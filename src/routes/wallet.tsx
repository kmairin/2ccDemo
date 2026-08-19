/**
 * The demo balance, as a surface.
 *
 *   GET  /account/wallet
 *   POST /account/wallet/topup
 *
 * Mounted into `src/routes/account.tsx`, so the paths above are the real URLs.
 * The handlers stay thin (AGENTS.md §8): authorise, read, render — every write
 * is `topUp()` in `src/services/wallet.ts`, which owns the `batch()`.
 *
 * This file also exports `walletHeader`, the one piece of middleware in the
 * product. See its doc for why the header needs it.
 */

import { eq } from "drizzle-orm";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import {
  currentUser,
  flashMessage,
  issuePurchaseNonce,
  requireUser,
  setFlash,
  takeFlash,
  SESSION_COOKIE,
  type AuthEnv,
  type Flash,
} from "../auth";
import { getDb } from "../db";
import { formatDay, formatMoney, formatTime } from "../lib/format";
import { createLogger } from "../logger";
import { wallets } from "../schema";
import {
  getWallet,
  isWalletCurrency,
  listMovements,
  MAX_TOPUP_CENTS,
  topUp,
  topUpPresets,
  type WalletMovement,
} from "../services/wallet";
import type { BalanceOption } from "../ui/booking";
import { Alert, Button, EmptyState, Hero, Section } from "../ui/components";
import { HEADER_SLOT, Layout, headerBalanceHtml } from "../ui/layout";

const wallet = new Hono<{ Bindings: AuthEnv }>();

type PageContext = Context<{ Bindings: AuthEnv }>;

/** One member's own history is small, and every read here is bounded (AGENTS.md §5). */
const ROW_LIMIT = 50;

/** Same as everywhere else: `private, no-cache`, never `no-store` (§10.4). */
function pageHeaders(c: PageContext): void {
  c.header("cache-control", "private, no-cache");
}

/** Only a path on this site is ever followed. See the same helper in account.tsx. */
function safeNext(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  return raw;
}

/** Copied from account.tsx: dates and codes must not be broken across lines at 375. */
const NOWRAP = "white-space:nowrap";

/* ---------------------------------------------------------------- the page */

/** What one movement is called, and which way it moved the balance. */
const MOVEMENT: Record<WalletMovement["kind"], { label: string; sign: string }> = {
  topup: { label: "Top-up", sign: "+" },
  spend: { label: "Spent", sign: "−" },
  refund: { label: "Returned", sign: "+" },
};

type WalletPageProps = {
  user: { name: string };
  flash: Flash | null;
  balanceCents: number;
  currency: string;
  presets: number[];
  /** The amount the checkout that sent them here needs covering. */
  needCents: number | null;
  next: string | undefined;
  nonce: string;
  movements: WalletMovement[];
  now: Date;
};

function WalletPage(props: WalletPageProps) {
  const {
    user,
    flash,
    balanceCents,
    currency,
    presets,
    needCents,
    next,
    nonce,
    movements,
    now,
  } = props;

  const balance = formatMoney(balanceCents, currency);
  const short = needCents !== null ? Math.max(0, needCents - balanceCents) : 0;
  // The preset the checkout would have chosen: the smallest that covers what is
  // missing. `topUpAmounts` has already appended an exact one when no preset does.
  const recommended = needCents !== null ? presets.find((amount) => amount >= short) : undefined;

  return (
    <Layout
      title="Your balance"
      description="Top up your demo balance and pay for a package without a card."
      user={{ name: user.name }}
      active="account"
    >
      {flash !== null ? (
        <div class="shell" style="padding-block-start:24px">
          <Alert tone={flash.tone === "warn" ? "warn" : "brass"} confirm={flash.tone !== "warn"}>
            {flash.message}
          </Alert>
        </div>
      ) : null}

      <Hero
        index="01"
        label="Balance"
        title="Your balance"
        lede="Top up in one click, then pay for a package or a ticket from the balance. No card is charged at any point — the money here is part of the demo."
      >
        <p class="places-left" data-balance-cents={String(balanceCents)}>
          {balance}
        </p>
        <Button href="/account" variant="quiet">
          Your account
        </Button>
      </Hero>

      <Section index="02" label="Top up" title="Add to the balance">
        {needCents !== null ? (
          <p class="meta" style="margin-block-end:24px" data-need={String(needCents)}>
            {short > 0 ? (
              <>
                The checkout you came from needs{" "}
                <span class="num">{formatMoney(needCents, currency)}</span>, so you are{" "}
                <span class="num">{formatMoney(short, currency)}</span> short.
              </>
            ) : (
              <>
                Your balance already covers the{" "}
                <span class="num">{formatMoney(needCents, currency)}</span> you came here for.
              </>
            )}
          </p>
        ) : null}

        <form method="post" action="/account/wallet/topup" class="topup" data-topup="">
          <input type="hidden" name="nonce" value={nonce} />
          <input type="hidden" name="currency" value={currency} />
          {next !== undefined ? <input type="hidden" name="next" value={next} /> : null}
          <div class="topup-amounts">
            {presets.map((amount) => (
              <Button
                type="submit"
                name="amount"
                value={String(amount)}
                variant={amount === recommended ? "primary" : "ghost"}
              >
                {formatMoney(amount, currency)}
              </Button>
            ))}
          </div>
          <p class="action-help" style="margin-block-start:16px">
            One click, no card, and the balance moves at once. Submitting the same button twice
            adds the money once.
          </p>
        </form>
      </Section>

      <Section index="03" label="History" title="Every movement">
        {movements.length === 0 ? (
          <EmptyState
            title="No movements yet."
            note="A top-up, a package paid from the balance, and anything handed back all land here."
          />
        ) : (
          <div class="bordered scroll-x" tabindex={0} data-movements="">
            <table class="package-table" style="min-width:34rem">
              <caption class="vh">Wallet movements, newest first</caption>
              <thead style={NOWRAP}>
                <tr>
                  <th scope="col">Movement</th>
                  <th scope="col">Detail</th>
                  <th scope="col">Date</th>
                  <th scope="col">Amount</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((movement) => {
                  const shape = MOVEMENT[movement.kind];
                  return (
                    <tr data-movement={movement.kind}>
                      <th scope="row" style={NOWRAP}>
                        {shape.label}
                        <span class="package-derivation num">{movement.reference}</span>
                      </th>
                      <td>{movement.note}</td>
                      <td class="num" style={NOWRAP}>
                        {formatDay(movement.createdAt)}
                        <span class="package-derivation num">
                          {formatTime(movement.createdAt)}
                        </span>
                      </td>
                      <td class="num" style={NOWRAP}>
                        <span class="package-price">
                          {shape.sign}
                          {formatMoney(movement.amountCents, movement.currency)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p class="meta" style="margin-block-start:24px">
          Balance as of <span class="num">{formatDay(now)}</span>,{" "}
          <span class="num">{formatTime(now)}</span> UTC.
        </p>
      </Section>
    </Layout>
  );
}

/**
 * The ladder of buttons on the page.
 *
 * The four presets for the currency, plus — when the member arrived from a
 * checkout that needs more than the largest of them — the exact shortfall, so
 * the page always offers a single click that is enough. Sorted, de-duplicated.
 */
function topUpAmounts(currency: string, shortCents: number | null): number[] {
  const presets = topUpPresets(currency);
  if (shortCents !== null && shortCents > 0 && !presets.some((amount) => amount >= shortCents)) {
    presets.push(Math.min(shortCents, MAX_TOPUP_CENTS));
  }
  return [...new Set(presets)].sort((a, b) => a - b);
}

/** A positive integer of cents from a query string or a form field, or null. */
function centsParam(raw: string | undefined | null): number | null {
  if (typeof raw !== "string" || !/^\d{1,12}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TOPUP_CENTS ? value : null;
}

wallet.get("/account/wallet", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  const needCents = centsParam(c.req.query("need"));
  const asked = c.req.query("currency");
  // The checkout link carries the currency it is priced in. A wallet with money
  // in it keeps its own; an empty one takes the one it was sent.
  const held = await getWallet(c.env, me.user.id);
  const wanted = typeof asked === "string" && isWalletCurrency(asked) ? asked : null;
  const currency = wanted !== null && held.balanceCents === 0 ? wanted : held.currency;

  const short = needCents === null ? null : Math.max(0, needCents - held.balanceCents);
  const [flash, movements] = await Promise.all([
    takeFlash(c.env, me.session),
    listMovements(c.env, me.user.id, { limit: ROW_LIMIT }),
  ]);

  pageHeaders(c);
  return c.html(
    <WalletPage
      user={{ name: me.user.name }}
      flash={flash}
      balanceCents={held.balanceCents}
      currency={currency}
      presets={topUpAmounts(currency, short)}
      needCents={wanted === null || wanted === currency ? needCents : null}
      next={safeNext(c.req.query("next"))}
      nonce={issuePurchaseNonce()}
      movements={movements}
      now={new Date()}
    />,
  );
});

wallet.post("/account/wallet/topup", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  const body = await c.req.parseBody();
  const amountCents = centsParam(typeof body.amount === "string" ? body.amount : undefined);
  const currency = typeof body.currency === "string" ? body.currency : "";
  const next = safeNext(typeof body.next === "string" ? body.next : undefined);
  const nonce = typeof body.nonce === "string" && body.nonce !== "" ? body.nonce : undefined;

  if (amountCents === null || !isWalletCurrency(currency)) {
    return c.json({ error: "A top-up needs an amount in cents and a known currency" }, 400);
  }

  const result = await topUp(c.env, { userId: me.user.id, amountCents, currency, nonce });
  const back = next ?? "/account/wallet";

  switch (result.status) {
    case "topped_up":
      await setFlash(
        c.env,
        me.session.id,
        `${formatMoney(result.amountCents, result.currency)} added. Your balance is ${formatMoney(result.balanceCents, result.currency)}.`,
      );
      return c.redirect(back, 302);

    case "already_processed":
      await setFlash(
        c.env,
        me.session.id,
        `Already processed. Your balance is still ${formatMoney(result.balanceCents, result.currency)}, and nothing was added twice.`,
      );
      return c.redirect(back, 302);

    case "currency_mismatch":
      await setFlash(
        c.env,
        me.session.id,
        flashMessage(
          "warn",
          `Your balance is ${formatMoney(result.balanceCents, result.currency)} and a balance holds one currency. Spend it down and you can top up in ${currency}.`,
        ),
      );
      return c.redirect("/account/wallet", 302);

    case "invalid_amount":
      return c.json({ error: "That is not an amount this demo tops up" }, 400);
  }
});

/** What the header and the account link show before there is a wallet at all. */
export const EMPTY_BALANCE = "—";

/* ------------------------------------------------- what the buying pages ask */

/**
 * The demo balance measured against one price, formatted once, for every
 * surface that offers "pay from balance".
 *
 * It lives here rather than in either route that calls it so the checkout, the
 * single-ticket button and this page can never disagree about what a member
 * holds or about where "top up" goes.
 *
 * A balance holds one currency (see `src/services/wallet.ts`), so money in
 * another currency cannot pay here at all — that is `otherCurrency`, and it is
 * a different sentence from "you are short". The top-up link carries the amount
 * and the currency, so the page it opens already has the right button chosen
 * and comes back to where the member was.
 */
export async function balanceOptionFor(
  env: AuthEnv,
  userId: string,
  price: { amountCents: number; currency: string },
  next: string,
): Promise<BalanceOption> {
  const held = await getWallet(env, userId, price.currency);
  const otherCurrency = held.balanceCents > 0 && held.currency !== price.currency;
  const usable = otherCurrency ? 0 : held.balanceCents;
  const query = new URLSearchParams({
    need: String(price.amountCents),
    currency: price.currency,
    next,
  });
  return {
    label: formatMoney(held.balanceCents, held.currency),
    covers: usable >= price.amountCents,
    shortLabel: formatMoney(Math.max(0, price.amountCents - usable), price.currency),
    topUpHref: `/account/wallet?${query.toString()}`,
    otherCurrency,
  };
}

/* ------------------------------------------------------------- the header */

/**
 * Fills the two slots `Layout` leaves in every signed-in page: the balance chip
 * in the header, and the `localStorage` mirror of the account.
 *
 * **Why middleware and not a prop.** Both depend on the signed-in member and on
 * nothing the page knows, and `Layout` is called from twenty-eight places. A
 * prop would mean a wallet read threaded through every one of them, in four
 * route files, three of which this change has no business touching. So the
 * markup is written once here, on the way out — the same shape as the theme
 * stamp in `src/index.ts`, which rewrites `<html>` the same way.
 *
 * Signed-out requests cost nothing: there is no session cookie, so it returns
 * before the body is ever read.
 *
 * Register it in `src/index.ts` BEFORE the routers. Middleware added after a
 * route handler never runs for that route — the handler answers first.
 */
export const walletHeader: MiddlewareHandler<{ Bindings: AuthEnv }> = async (c, next) => {
  await next();

  // Cheapest possible bail for the anonymous majority.
  if (!getCookie(c, SESSION_COOKIE)) return;
  if (!c.res.headers.get("content-type")?.includes("text/html")) return;

  const me = await currentUser(c);
  if (!me) return;

  /**
   * One indexed lookup on top of the session read `currentUser` already did —
   * and it may not take the page down.
   *
   * This middleware runs on EVERY html response, so anything it throws becomes
   * a 500 on every signed-in page in the product. It did: the deployment that
   * introduced `wallets` served 500s to signed-in visitors on `/`, `/events`
   * and everything else, while the same pages were fine signed out, because
   * this one query failed and took the whole response with it.
   *
   * A balance in the header is decoration. If it cannot be read, say nothing
   * and let the page through; the wallet page and the checkout do their own
   * reads and report their own failures, where an error actually belongs.
   */
  let amount = EMPTY_BALANCE;
  try {
    const db = getDb(c.env);
    const [row] = await db
      .select({ balanceCents: wallets.balanceCents, currency: wallets.currency })
      .from(wallets)
      .where(eq(wallets.userId, me.user.id))
      .limit(1);
    // No row means the member has never topped up, and therefore has not chosen
    // a currency. An em dash says that; "$0" would assert a currency they have
    // not picked, and would sit next to a "€0" on a checkout priced in euros.
    if (row) amount = formatMoney(Number(row.balanceCents), row.currency);
  } catch (err) {
    createLogger(c.env).warn("could not read the header balance", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const html = (await c.res.text())
    .replace(HEADER_SLOT.desktop, headerBalanceHtml(amount, "desktop"))
    .replace(HEADER_SLOT.mobile, headerBalanceHtml(amount, "mobile"))
    .replace(HEADER_SLOT.panel, headerBalanceHtml(amount, "panel"))
    .replace(HEADER_SLOT.account, accountMirrorScript(me.user.name, me.user.email));

  c.res = new Response(html, c.res);
};

/**
 * The owner's ask, in four lines of vanilla JS: the signed-in account, mirrored
 * into `localStorage` under `2cc.account` as `{name, email, initials}`.
 *
 * The server session is what actually authorises anything — bookings, tickets
 * and the balance are all keyed to a user row, and the server cannot read
 * `localStorage`. This is the copy the owner asked for, kept in step on every
 * signed-in page rather than written once and left to rot.
 *
 * **The JSON is escaped for a `<script>` context**, not just JSON-encoded: a
 * member called `</script>` would otherwise close the element and everything
 * after it would be markup.
 */
function accountMirrorScript(name: string, email: string): string {
  const account = {
    name,
    email,
    initials: name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join(""),
  };
  // JSON, then a JS string literal OF that JSON, then the four characters that
  // can end a script element or break a literal. The engine decodes the escapes
  // back, so what reaches `localStorage` is the JSON itself.
  const literal = JSON.stringify(JSON.stringify(account))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<script>try{localStorage.setItem('2cc.account',${literal})}catch(e){}</script>`;
}

export default wallet;
