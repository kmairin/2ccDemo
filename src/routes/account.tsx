/**
 * The signed-in member's own surface: what they hold, what they booked, and
 * the two steps that move money and credits.
 *
 *   GET  /account
 *   GET  /account/tickets/:code
 *   GET  /circles/:slug/passes/:packageId/checkout
 *   POST /circles/:slug/passes/:packageId/buy
 *   POST /events/:slug/book
 *   POST /account/tickets/:code/cancel
 *
 * Mounted at `/` in `src/index.ts`, so the paths above are the contract's URLs
 * (`design/reference/api-contract.md`). Handlers stay thin (AGENTS.md §8):
 * authorise, load, render — every mutation is a call into `src/services/`,
 * which owns the `batch()`es. Nothing here writes with two awaits, and nothing
 * here reimplements a service.
 *
 * Two rules from `design/reference/design-decisions.md` shape the reads:
 *
 *   - **Credits are grouped by circle and never totalled across them** (§5). A
 *     pass is scoped to one circle, so a combined number would be a figure
 *     nobody can spend.
 *   - **Nothing is hand-formatted.** Dates and money go through
 *     `src/lib/format.ts`, so the ticket, the ledger and the checkout agree.
 *
 * A few reads are queried here rather than through `src/services/`: which order
 * a pass came from, the host a request is waiting on, the next gathering per
 * circle. The service layer is owned elsewhere and returns none of those
 * columns, and `src/db.ts` is explicit that queries may live in a route. Every
 * one of them carries a LIMIT (AGENTS.md §5).
 */

import { and, asc, desc, eq, gte } from "drizzle-orm";
import { Hono, type Context } from "hono";
import {
  issuePurchaseNonce,
  requireUser,
  setFlash,
  flashMessage,
  takeFlash,
  type Flash,
  type AuthEnv,
  type SessionUser,
} from "../auth";
import { getDb, type DatabaseEnv } from "../db";
import { placeLabel, formatDateRange, formatDay, formatMoney, formatTime, relativeDay } from "../lib/format";
import { bookings, circleMembers, circles, events, orders, packages, passes, users } from "../schema";
import { getCircleBySlug } from "../services/circles";
import {
  book,
  cancel,
  getPackageForCircle,
  listBookingsForUser,
  purchase,
  type BookingSummary,
} from "../services/commerce";
import { listEvents } from "../services/events";
import { listMembershipsForUser, type MembershipSummary } from "../services/members";
import { CheckoutSummary, CreditSquares, TicketPlate } from "../ui/booking";
import { Alert, Badge, Button, EmptyState, Hero, PassCard, PassGrid, Section } from "../ui/components";
import { Layout } from "../ui/layout";

const account = new Hono<{ Bindings: AuthEnv }>();

type PageContext = Context<{ Bindings: AuthEnv }>;

/** Every list read here is bounded (AGENTS.md §5). One member's own history is small. */
const ROW_LIMIT = 50;

/**
 * The cancellation deadline printed on the ticket is **the start of the
 * gathering**, because that is the deadline the product actually enforces:
 * `cancel()` in `src/services/commerce.ts` always hands the credit back, and
 * this page stops offering the release once the gathering has begun. An
 * earlier, prettier deadline would be a number the app does not keep.
 */
function cancelDeadline(startsAt: Date): Date {
  return startsAt;
}

/**
 * What to bring, by the circle's category.
 *
 * `events` has no column for it and this worker does not own `src/schema.ts`.
 * A ticket that cannot say what to bring is a code on a page rather than an
 * object (§5), so it is derived from the category until a column exists.
 */
const BRING: Record<string, string> = {
  sailing: "Soft soles, a shell jacket, sunglasses",
  wellness: "Towel, sandals, a change of clothes",
  dining: "Nothing. The table is laid",
  sport: "Court shoes, and a racket if you own one",
  art: "Flat shoes. The floors are concrete",
};

/* ------------------------------------------------------------ small helpers */

/**
 * `Cache-Control: private, no-cache` on every GET page (§10.4) — never
 * `no-store`, which disables bfcache and makes Back a cold load at every step
 * of the funnel.
 */
function pageHeaders(c: PageContext): void {
  c.header("cache-control", "private, no-cache");
}

/**
 * A `next=` value is only followed when it is a path on this site. An absolute
 * URL or a protocol-relative `//host` is dropped rather than redirected to.
 */
function safeNext(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  return raw;
}

/** Park the one-line result on the session, then 302. Flash lives on the session, not the URL. */
async function redirectWith(
  c: PageContext,
  session: { id: string },
  message: string,
  location: string,
): Promise<Response> {
  await setFlash(c.env, session.id, message);
  return c.redirect(location, 302);
}

/**
 * The confirmation banner: first thing inside `<main>`, above the `<h1>`,
 * `role="status"`, no auto-dismiss and no dismiss control (§10.4). The
 * `<div class="shell">` is only the page gutter — `Alert` is the live region.
 */
function FlashBanner(props: { message: Flash }) {
  // A refusal must not render in the same band as a confirmation.
  const warn = props.message.tone === "warn";
  return (
    <div class="shell" style="padding-block-start:24px">
      <Alert tone={warn ? "warn" : "brass"} confirm={!warn}>
        {props.message.message}
      </Alert>
    </div>
  );
}

/** A styled 404 (§8: never a stack trace). Also what someone else's ticket gets. */
function notFoundPage(
  c: PageContext,
  me: SessionUser | null,
  props: { title: string; note: string },
): Response | Promise<Response> {
  pageHeaders(c);
  return c.html(
    <Layout title={props.title} user={me ? { name: me.user.name } : null}>
      <Hero index="00" label="Not found" title={props.title} lede={props.note} />
      <Section index="01" label="Elsewhere" title="Where to go instead">
        <div class="row">
          <Button href="/account" variant="ghost">
            Your account
          </Button>
          <Button href="/events" variant="quiet">
            All gatherings
          </Button>
        </div>
      </Section>
    </Layout>,
    404,
  );
}

/**
 * `body { overflow-wrap:anywhere }` (§10.4) is the right default for prose and
 * the wrong one for a date, a code or a figure: at 375 it broke `09:20` across
 * two lines and `2CC-TKT-WNVZ` across three. These cells hold things that
 * genuinely cannot wrap, so they do not — the table scrolls inside its own
 * `.scroll-x` box instead, which is what §10.4 asks for.
 */
const NOWRAP = "white-space:nowrap";

/**
 * `.pass-table` is `width:100%`, so inside a `.scroll-x` box it can never be
 * wider than the box — it squeezes the flexible columns to one character per
 * line instead. A minimum width is what makes the box actually scroll, which is
 * §10.4's answer for content that genuinely cannot wrap. Measured at 375.
 */
function wide(rem: number): string {
  return `min-width:${rem}rem`;
}

/** `3 gatherings · €120 each` — the derivation §6 asks every price to show. */
function derivation(credits: number, priceCents: number, currency: string): string {
  const each = formatMoney(Math.round(priceCents / Math.max(1, credits)), currency);
  return `${credits} ${credits === 1 ? "gathering" : "gatherings"} · ${each} each`;
}

/* ------------------------------------------------------------------- reads */

/** A pass a member holds, with the order it came from. */
type HeldPass = {
  passId: string;
  circleSlug: string;
  circleName: string;
  packageName: string;
  creditsTotal: number;
  creditsUsed: number;
  amountCents: number;
  currency: string;
  reference: string;
  boughtAt: Date;
};

/**
 * Every pass this member holds, with the order that created it. The account
 * page shows what was bought, when and for how much; `listPassesForUser`
 * (which the JSON API uses) carries none of that.
 */
async function listHeldPasses(env: DatabaseEnv, userId: string): Promise<HeldPass[]> {
  const db = getDb(env);
  const rows = await db
    .select({
      passId: passes.id,
      circleSlug: circles.slug,
      circleName: circles.name,
      packageName: packages.name,
      creditsTotal: passes.creditsTotal,
      creditsUsed: passes.creditsUsed,
      amountCents: orders.amountCents,
      currency: orders.currency,
      reference: orders.reference,
      boughtAt: orders.createdAt,
    })
    .from(passes)
    .innerJoin(circles, eq(circles.id, passes.circleId))
    .innerJoin(orders, eq(orders.id, passes.orderId))
    .innerJoin(packages, eq(packages.id, orders.packageId))
    .where(eq(passes.userId, userId))
    .orderBy(desc(orders.createdAt))
    .limit(ROW_LIMIT);

  return rows.map((row) => ({
    ...row,
    creditsTotal: Number(row.creditsTotal),
    creditsUsed: Number(row.creditsUsed),
    amountCents: Number(row.amountCents),
  }));
}

/** The soonest published gathering in each circle this member belongs to. */
type NextGathering = { slug: string; title: string; startsAt: Date };

async function nextGatheringByCircle(
  env: DatabaseEnv,
  userId: string,
  now: Date,
): Promise<Map<string, NextGathering>> {
  const db = getDb(env);
  const rows = await db
    .select({
      circleSlug: circles.slug,
      slug: events.slug,
      title: events.title,
      startsAt: events.startsAt,
    })
    .from(events)
    .innerJoin(circles, eq(circles.id, events.circleId))
    .innerJoin(circleMembers, eq(circleMembers.circleId, circles.id))
    .where(
      and(
        eq(circleMembers.userId, userId),
        eq(events.status, "published"),
        gte(events.startsAt, now),
      ),
    )
    .orderBy(asc(events.startsAt))
    .limit(ROW_LIMIT);

  // Sorted soonest first, so the first row seen for a circle is its next date.
  const byCircle = new Map<string, NextGathering>();
  for (const row of rows) {
    if (!byCircle.has(row.circleSlug)) {
      byCircle.set(row.circleSlug, { slug: row.slug, title: row.title, startsAt: row.startsAt });
    }
  }
  return byCircle;
}

/** A request still with a host: which circle, who decides, and when it was made. */
type PendingRequest = {
  circleSlug: string;
  circleName: string;
  hostName: string;
  requestedAt: Date;
};

/**
 * Pending requests, with the host's name and the date asked, so a request is
 * not a black hole. `listMembershipsForUser` carries neither.
 */
async function listPendingRequests(env: DatabaseEnv, userId: string): Promise<PendingRequest[]> {
  const db = getDb(env);
  return db
    .select({
      circleSlug: circles.slug,
      circleName: circles.name,
      hostName: users.name,
      requestedAt: circleMembers.createdAt,
    })
    .from(circleMembers)
    .innerJoin(circles, eq(circles.id, circleMembers.circleId))
    .innerJoin(users, eq(users.id, circles.hostUserId))
    .where(and(eq(circleMembers.userId, userId), eq(circleMembers.status, "pending")))
    .orderBy(asc(circleMembers.createdAt))
    .limit(ROW_LIMIT);
}

/** One ticket, and everything printed on it. */
type Ticket = {
  code: string;
  status: "confirmed" | "cancelled";
  eventSlug: string;
  title: string;
  venue: string;
  city: string;
  country: string;
  startsAt: Date;
  endsAt: Date;
  circleSlug: string;
  circleName: string;
  category: string;
  packageName: string;
  creditsTotal: number;
  creditsUsed: number;
};

/**
 * A ticket, **scoped to its owner in SQL**. Someone else's code simply does not
 * come back, so the route answers 404 and never confirms that it exists.
 */
async function getTicket(env: DatabaseEnv, userId: string, code: string): Promise<Ticket | null> {
  const db = getDb(env);
  const [row] = await db
    .select({
      code: bookings.code,
      status: bookings.status,
      eventSlug: events.slug,
      title: events.title,
      venue: events.venue,
      city: events.city,
      country: circles.country,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      circleSlug: circles.slug,
      circleName: circles.name,
      category: circles.category,
      packageName: packages.name,
      creditsTotal: passes.creditsTotal,
      creditsUsed: passes.creditsUsed,
    })
    .from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId))
    .innerJoin(circles, eq(circles.id, events.circleId))
    .innerJoin(passes, eq(passes.id, bookings.passId))
    .innerJoin(orders, eq(orders.id, passes.orderId))
    .innerJoin(packages, eq(packages.id, orders.packageId))
    .where(and(eq(bookings.code, code), eq(bookings.userId, userId)))
    .limit(1);
  if (!row) return null;
  return { ...row, creditsTotal: Number(row.creditsTotal), creditsUsed: Number(row.creditsUsed) };
}

/** The circle a gathering belongs to — one indexed lookup, for the "full" refusal. */
async function getEventCircleSlug(env: DatabaseEnv, eventSlug: string): Promise<string | null> {
  const db = getDb(env);
  const [row] = await db
    .select({ circleSlug: circles.slug })
    .from(events)
    .innerJoin(circles, eq(circles.id, events.circleId))
    .where(eq(events.slug, eventSlug))
    .limit(1);
  return row?.circleSlug ?? null;
}

/* ------------------------------------------------------------- the account */

/** One circle's worth of credits: the passes, and the movements behind them. */
type CircleCredits = {
  slug: string;
  name: string;
  held: HeldPass[];
  creditsLeft: number;
  spent: BookingSummary[];
  returned: BookingSummary[];
};

/**
 * Passes and bookings folded together per circle. **No combined total** — a
 * pass is good for one circle, and a number spanning them would lie (§5).
 */
function creditsByCircle(held: HeldPass[], booked: BookingSummary[]): CircleCredits[] {
  const groups = new Map<string, CircleCredits>();
  for (const pass of held) {
    const group = groups.get(pass.circleSlug) ?? {
      slug: pass.circleSlug,
      name: pass.circleName,
      held: [],
      creditsLeft: 0,
      spent: [],
      returned: [],
    };
    group.held.push(pass);
    group.creditsLeft += Math.max(0, pass.creditsTotal - pass.creditsUsed);
    groups.set(pass.circleSlug, group);
  }
  for (const booking of booked) {
    const group = groups.get(booking.circleSlug);
    if (!group) continue;
    if (booking.status === "confirmed") group.spent.push(booking);
    else group.returned.push(booking);
  }
  return [...groups.values()];
}

/**
 * The ledger for one circle: bought, spent, handed back, and what is left.
 * The credits column adds up to the closing figure, which is the whole point
 * of showing it.
 */
function CreditLedger(props: { group: CircleCredits }) {
  const { group } = props;
  return (
    <div class="bordered scroll-x" tabindex={0} style="margin-block-start:24px">
      <table class="pass-table" style={wide(30)}>
        <caption class="vh">Credit ledger for {group.name}</caption>
        <thead style={NOWRAP}>
          <tr>
            <th scope="col">Movement</th>
            <th scope="col">Detail</th>
            <th scope="col">Date</th>
            <th scope="col">Credits</th>
          </tr>
        </thead>
        <tbody>
          {group.held.map((pass) => (
            <tr>
              <th scope="row" style={NOWRAP}>
                Bought
              </th>
              <td>
                {pass.packageName}
                <span class="pass-derivation num">{pass.reference}</span>
              </td>
              <td class="num" style={NOWRAP}>
                {formatDay(pass.boughtAt)}
              </td>
              <td class="num" style={NOWRAP}>
                +{pass.creditsTotal}
              </td>
            </tr>
          ))}
          {group.spent.map((booking) => (
            <tr>
              <th scope="row" style={NOWRAP}>
                Spent
              </th>
              <td>
                <a href={`/events/${booking.eventSlug}`}>{booking.eventTitle}</a>
              </td>
              <td class="num" style={NOWRAP}>
                {formatDay(new Date(booking.startsAt))}
              </td>
              <td class="num" style={NOWRAP}>
                −1
              </td>
            </tr>
          ))}
          {group.returned.map((booking) => (
            <tr>
              <th scope="row">Spent, then returned</th>
              <td>
                <a href={`/events/${booking.eventSlug}`}>{booking.eventTitle}</a>
              </td>
              <td class="num" style={NOWRAP}>
                {formatDay(new Date(booking.startsAt))}
              </td>
              <td class="num" style={NOWRAP}>
                0
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row" style={NOWRAP}>
              Left
            </th>
            <td>
              <span class="meta">Good for {group.name} only</span>
            </td>
            <td />
            <td class="num pass-price" style={NOWRAP}>
              {group.creditsLeft}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Places held, or places behind you. Hairline rows — this is a record, not a grid. */
function BookingTable(props: { rows: BookingSummary[]; now: Date; showStatus?: boolean }) {
  const { rows, now, showStatus } = props;
  return (
    <div class="bordered scroll-x" tabindex={0}>
      <table class="pass-table" style={wide(28)}>
        <thead style={NOWRAP}>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Gathering</th>
            <th scope="col">{showStatus === true ? "Standing" : "Ticket"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const startsAt = new Date(row.startsAt);
            return (
              <tr>
                <td class="num" style={NOWRAP}>
                  {formatDay(startsAt)}
                  <span class="pass-derivation num">{formatTime(startsAt)}</span>
                </td>
                <th scope="row">
                  <a href={`/events/${row.eventSlug}`}>{row.eventTitle}</a>
                  <span class="pass-derivation">
                    <a href={`/circles/${row.circleSlug}`}>{row.circleName}</a> ·{" "}
                    {relativeDay(startsAt, now)}
                  </span>
                </th>
                <td>
                  {showStatus === true && row.status === "cancelled" ? (
                    <Badge tone="rust">Cancelled</Badge>
                  ) : (
                    <a class="num" style={NOWRAP} href={`/account/tickets/${row.code}`}>
                      {row.code}
                    </a>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type AccountPageProps = {
  user: { name: string; email: string };
  flash: Flash | null;
  held: HeldPass[];
  booked: BookingSummary[];
  memberships: MembershipSummary[];
  pending: PendingRequest[];
  nextByCircle: Map<string, NextGathering>;
  now: Date;
};

function AccountPage(props: AccountPageProps) {
  const { user, flash, held, booked, memberships, pending, nextByCircle, now } = props;

  const groups = creditsByCircle(held, booked);
  const upcoming = booked.filter(
    (b) => b.status === "confirmed" && new Date(b.startsAt).getTime() >= now.getTime(),
  );
  const history = booked.filter(
    (b) => b.status !== "confirmed" || new Date(b.startsAt).getTime() < now.getTime(),
  );
  const joined = memberships.filter((m) => m.status === "approved");

  return (
    <Layout
      title="Your account"
      description="Your passes, your credits and the places you hold."
      user={{ name: user.name }}
      active="account"
    >
      {flash !== null ? <FlashBanner message={flash} /> : null}

      <Hero
        index="01"
        label="Account"
        title="Your account"
        lede="Credits are held per circle. Booking spends one, and cancelling in time puts it back."
      >
        <p class="meta num">{user.email}</p>
      </Hero>

      <Section
        index="02"
        label="Credits"
        title="What you hold"
        action={{ href: "/circles", label: "Find a circle" }}
      >
        {groups.length === 0 ? (
          <EmptyState
            title="No passes yet."
            note="A pass buys credits for one circle. One credit takes one place at one gathering."
            action={{ href: "/circles", label: "Browse circles" }}
          />
        ) : (
          <div class="stack stack--wide" data-credits="">
            {groups.map((group) => {
              const next = nextByCircle.get(group.slug);
              return (
                <div data-circle={group.slug}>
                  <div class="row">
                    <h3 class="h-card">
                      <a href={`/circles/${group.slug}`}>{group.name}</a>
                    </h3>
                    <span class="micro micro--brass">
                      {group.creditsLeft} {group.creditsLeft === 1 ? "credit" : "credits"} left
                    </span>
                  </div>
                  <p class="meta" style="margin-block-start:8px">
                    {next !== undefined ? (
                      <>
                        Next: <a href={`/events/${next.slug}`}>{next.title}</a>,{" "}
                        <span class="num">{formatDay(next.startsAt)}</span>
                      </>
                    ) : (
                      "No gatherings scheduled yet."
                    )}
                  </p>

                  <div style="margin-block-start:24px">
                    <PassGrid>
                      {group.held.map((pass) => (
                        <PassCard
                          name={pass.packageName}
                          credits={pass.creditsTotal}
                          price={formatMoney(pass.amountCents, pass.currency)}
                          derivation={derivation(pass.creditsTotal, pass.amountCents, pass.currency)}
                          note={`Bought ${formatDay(pass.boughtAt)}`}
                        >
                          <div style="margin-block-start:16px">
                            <CreditSquares
                              total={pass.creditsTotal}
                              used={pass.creditsUsed}
                              label={`${pass.creditsTotal - pass.creditsUsed} of ${pass.creditsTotal} credits left on your ${pass.packageName} for ${group.name}`}
                            />
                          </div>
                        </PassCard>
                      ))}
                    </PassGrid>
                  </div>

                  <CreditLedger group={group} />
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section index="03" label="Upcoming" title="Places you hold" id="upcoming">
        {upcoming.length === 0 ? (
          <EmptyState
            title="No places booked."
            note="A credit takes a place. Cancelling before the deadline hands it back."
            action={{ href: "/events", label: "All gatherings" }}
          />
        ) : (
          <div data-upcoming="">
            <BookingTable rows={upcoming} now={now} />
          </div>
        )}
      </Section>

      <Section index="04" label="History" title="Been and gone">
        {history.length === 0 ? (
          <EmptyState title="Nothing behind you yet." note="Past and released places land here." />
        ) : (
          <div data-history="">
            <BookingTable rows={history} now={now} showStatus={true} />
          </div>
        )}
      </Section>

      <Section index="05" label="Circles" title="Circles you are in">
        {joined.length === 0 ? (
          <EmptyState
            title="Not in a circle yet."
            note="Buying a pass on an open circle joins it. A private one asks the host first."
            action={{ href: "/circles", label: "Browse circles" }}
          />
        ) : (
          <div class="bordered scroll-x" tabindex={0} data-circles="">
            <table class="pass-table" style={wide(24)}>
              <thead style={NOWRAP}>
                <tr>
                  <th scope="col">Circle</th>
                  <th scope="col">Next gathering</th>
                </tr>
              </thead>
              <tbody>
                {joined.map((m) => {
                  const next = nextByCircle.get(m.circleSlug);
                  return (
                    <tr>
                      <th scope="row">
                        <a href={`/circles/${m.circleSlug}`}>{m.circleName}</a>
                        <span class="pass-derivation">
                          <Badge tone={m.role === "host" ? "brass" : "quiet"}>
                            {m.role === "host" ? "Host" : "Member"}
                          </Badge>
                        </span>
                      </th>
                      <td>
                        {next !== undefined ? (
                          <>
                            <a href={`/events/${next.slug}`}>{next.title}</a>
                            <span class="pass-derivation num" style={NOWRAP}>
                              {formatDay(next.startsAt)}
                            </span>
                          </>
                        ) : (
                          <span class="meta">None scheduled</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {pending.length > 0 ? (
          <div style="margin-block-start:48px" data-pending="">
            <h3 class="h-card">Requests with a host</h3>
            <div class="bordered scroll-x" tabindex={0} style="margin-block-start:16px">
              <table class="pass-table" style={wide(26)}>
                <thead style={NOWRAP}>
                  <tr>
                    <th scope="col">Circle</th>
                    <th scope="col">Asked</th>
                    <th scope="col">With</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((request) => (
                    <tr>
                      <th scope="row">
                        <a href={`/circles/${request.circleSlug}`}>{request.circleName}</a>
                        <span class="pass-derivation">
                          <Badge tone="slate">Pending</Badge>
                        </span>
                      </th>
                      <td class="num" style={NOWRAP}>
                        {formatDay(request.requestedAt)}
                      </td>
                      <td>{request.hostName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p class="meta" style="margin-block-start:16px">
              A host approves by hand. Browsing carries on meanwhile, and the gathering list opens
              the moment they say yes.
            </p>
          </div>
        ) : null}
      </Section>
    </Layout>
  );
}

account.get("/account", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  const now = new Date();
  const [flash, held, booked, memberships, pending, nextByCircle] = await Promise.all([
    takeFlash(c.env, me.session),
    listHeldPasses(c.env, me.user.id),
    listBookingsForUser(c.env, me.user.id, { limit: ROW_LIMIT }),
    listMembershipsForUser(c.env, me.user.id, { limit: ROW_LIMIT }),
    listPendingRequests(c.env, me.user.id),
    nextGatheringByCircle(c.env, me.user.id, now),
  ]);

  pageHeaders(c);
  return c.html(
    <AccountPage
      user={{ name: me.user.name, email: me.user.email }}
      flash={flash}
      held={held}
      booked={booked}
      memberships={memberships}
      pending={pending}
      nextByCircle={nextByCircle}
      now={now}
    />,
  );
});

/* -------------------------------------------------------------- the ticket */

function TicketPage(props: { user: { name: string }; flash: Flash | null; ticket: Ticket }) {
  const { user, flash, ticket } = props;
  const cancelBy = cancelDeadline(ticket.startsAt);
  const cancelByLabel = `${formatDay(cancelBy)} · ${formatTime(cancelBy)}`;
  const creditsLeft = Math.max(0, ticket.creditsTotal - ticket.creditsUsed);
  const releasable = ticket.status === "confirmed" && ticket.startsAt.getTime() > Date.now();

  return (
    <Layout
      // §10.4: the `<title>` is the real screen-reader announcement, so after a
      // booking it names what just happened rather than the page.
      title={flash !== null ? `Booked — ${ticket.title}` : `Ticket ${ticket.code}`}
      description={`Your place at ${ticket.title}.`}
      user={{ name: user.name }}
      active="account"
    >
      {flash !== null ? <FlashBanner message={flash} /> : null}

      <Hero index="01" label="Ticket" title={ticket.title}>
        <p class="meta">
          <a href={`/circles/${ticket.circleSlug}`}>{ticket.circleName}</a>
        </p>
      </Hero>

      <Section index="02" label="Your place" title="Show this on the day">
        <div data-ticket={ticket.code}>
          {ticket.status === "cancelled" ? (
            <div style="margin-block-end:24px">
              <Alert tone="rust">
                This place was released. The credit went back on your {ticket.packageName} for{" "}
                {ticket.circleName}.
              </Alert>
            </div>
          ) : null}

          <TicketPlate
            seed={ticket.eventSlug}
            code={ticket.code}
            title={ticket.title}
            circleName={ticket.circleName}
            when={formatDateRange(ticket.startsAt, ticket.endsAt)}
            venue={ticket.venue}
            address={placeLabel(ticket.city, ticket.country)}
            passName={`${ticket.packageName} · ${creditsLeft} of ${ticket.creditsTotal} credits left`}
            bring={BRING[ticket.category]}
            cancelBy={cancelByLabel}
          />

          <div class="row" style="margin-block-start:32px">
            <Button href={`/events/${ticket.eventSlug}`} variant="quiet">
              The gathering
            </Button>
            <Button href="/account" variant="quiet">
              Your account
            </Button>
          </div>

          {releasable ? (
            <form
              method="post"
              action={`/account/tickets/${ticket.code}/cancel`}
              style="margin-block-start:32px"
            >
              <Button type="submit" variant="ghost">
                Release this place
              </Button>
              <p class="action-help" style="margin-block-start:12px">
                Free right up to the start, <span class="num">{cancelByLabel}</span>. The credit
                goes straight back on your {ticket.packageName}.
              </p>
            </form>
          ) : null}
        </div>
      </Section>
    </Layout>
  );
}

account.get("/account/tickets/:code", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  // Scoped to the owner in SQL: someone else's code is a 404, and the page
  // never confirms that it exists.
  const ticket = await getTicket(c.env, me.user.id, c.req.param("code"));
  if (!ticket) {
    return notFoundPage(c, me, {
      title: "No such ticket",
      note: "That code is not on your account. Your own places are listed on your account page.",
    });
  }

  const flash = await takeFlash(c.env, me.session);
  pageHeaders(c);
  return c.html(<TicketPage user={{ name: me.user.name }} flash={flash} ticket={ticket} />);
});

/* ------------------------------------------------------------ mock checkout */

account.get("/circles/:slug/passes/:packageId/checkout", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  const found = await getCircleBySlug(c.env, c.req.param("slug"));
  if (!found) {
    return notFoundPage(c, me, {
      title: "No such circle",
      note: "That circle is not here. The directory lists the ones that are.",
    });
  }

  const offer = await getPackageForCircle(c.env, found.circle.id, c.req.param("packageId"));
  if (!offer) {
    return notFoundPage(c, me, {
      title: "No such pass",
      note: `${found.circle.name} does not sell that pass. Its own three are on the circle page.`,
    });
  }

  const next = safeNext(c.req.query("next"));
  const price = formatMoney(offer.priceCents, offer.currency);
  const flash = await takeFlash(c.env, me.session);

  pageHeaders(c);
  return c.html(
    <Layout
      title={`Confirm — ${offer.name}`}
      description={`${offer.name} for ${found.circle.name}.`}
      user={{ name: me.user.name }}
    >
      {flash !== null ? <FlashBanner message={flash} /> : null}

      <Hero
        index="01"
        label="Checkout"
        title="One step, then it is yours"
        lede={`${offer.name} for ${found.circle.name}. No card is charged — the demo records the order and issues the credits.`}
      />

      <Section index="02" label="Order" title={`${offer.name} · ${price}`}>
        <div data-checkout={offer.id}>
          <CheckoutSummary
            circleName={found.circle.name}
            passName={offer.name}
            credits={offer.credits}
            price={price}
            perGathering={derivation(offer.credits, offer.priceCents, offer.currency)}
            action={`/circles/${found.circle.slug}/passes/${offer.id}/buy`}
            nonce={issuePurchaseNonce()}
            next={next}
          />
          <p class="action-help" style="margin-block-start:24px">
            {found.circle.isPrivate
              ? "Credits are good for this circle only. The host still approves members by hand."
              : "Credits are good for this circle only. Buying joins the circle, so you can book straight away."}
          </p>
        </div>
      </Section>
    </Layout>,
  );
});

/* ---------------------------------------------------------------------- buy */

account.post("/circles/:slug/passes/:packageId/buy", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  const found = await getCircleBySlug(c.env, c.req.param("slug"));
  if (!found) return c.json({ error: "Circle not found" }, 404);

  const body = await c.req.parseBody();
  const next = safeNext(typeof body.next === "string" ? body.next : undefined);
  const nonce = typeof body.nonce === "string" && body.nonce !== "" ? body.nonce : undefined;

  // `purchase` writes the order, the pass and — on an open circle — the
  // approved membership in ONE batch, and spends the nonce into
  // `orders.reference`, so a double submit collides on the unique index rather
  // than buying twice.
  const result = await purchase(c.env, {
    userId: me.user.id,
    circleId: found.circle.id,
    packageId: c.req.param("packageId"),
    nonce,
  });

  if (result.status === "package_not_found") return c.json({ error: "Pass not found" }, 404);

  if (result.status === "already_processed") {
    return redirectWith(
      c,
      me.session,
      `Already processed. Order ${result.reference} stands, and no second one was created.`,
      next ?? "/account",
    );
  }

  const joined = result.joinedCircle ? ` You are in ${found.circle.name}.` : "";
  return redirectWith(
    c,
    me.session,
    `${result.credits} ${result.credits === 1 ? "credit" : "credits"} for ${found.circle.name}. Order ${result.reference}, ${formatMoney(result.amountCents, result.currency)}.${joined}`,
    next ?? "/account",
  );
});

/* --------------------------------------------------------------------- book */

account.post("/events/:slug/book", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  const slug = c.req.param("slug");
  const back = `/events/${slug}`;
  const result = await book(c.env, { userId: me.user.id, eventSlug: slug });

  switch (result.status) {
    case "booked":
      return redirectWith(
        c,
        me.session,
        `You're going. Ticket ${result.code}, and ${result.creditsLeft} ${result.creditsLeft === 1 ? "credit" : "credits"} left.`,
        `/account/tickets/${result.code}`,
      );

    case "already_booked":
      return redirectWith(
        c,
        me.session,
        "You already hold this place. No second credit was spent.",
        `/account/tickets/${result.code}`,
      );

    // A draft is invisible to members, so it is missing rather than refused.
    case "event_not_found":
    case "not_published":
      return c.json({ error: "Gathering not found" }, 404);

    case "no_credits":
      // The gathering page answers this with the three pass buttons directly
      // under the banner, so the refusal and its fix are on one screen.
      return redirectWith(
        c,
        me.session,
        flashMessage("warn", "No credits left for this circle. Take a pass below and the place is yours."),
        back,
      );

    case "not_a_member":
      return redirectWith(
        c,
        me.session,
        flashMessage("warn", "Members only. Buying a pass joins an open circle; a private one asks the host first."),
        back,
      );

    case "membership_pending":
      return redirectWith(
        c,
        me.session,
        flashMessage("warn", "Your request is still with the host. Nothing was spent."),
        back,
      );

    case "full": {
      // A refusal with no alternative is a dead end — name the circle's next one.
      const circleSlug = await getEventCircleSlug(c.env, slug);
      const now = Date.now();
      const upcoming =
        circleSlug === null ? [] : await listEvents(c.env, { circleSlug, limit: ROW_LIMIT });
      const nextUp = upcoming.find(
        (e) => e.slug !== slug && e.placesLeft > 0 && new Date(e.startsAt).getTime() > now,
      );
      const offer =
        nextUp === undefined
          ? ""
          : ` Next from this circle: ${nextUp.title}, ${formatDay(new Date(nextUp.startsAt))}.`;
      return redirectWith(
        c,
        me.session,
        flashMessage("warn", `That gathering is full, and nothing was spent.${offer}`),
        back,
      );
    }
  }
});

/* ------------------------------------------------------------------- cancel */

account.post("/account/tickets/:code/cancel", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  const result = await cancel(c.env, { userId: me.user.id, code: c.req.param("code") });

  switch (result.status) {
    case "cancelled":
      return redirectWith(
        c,
        me.session,
        `Place released. The credit is back on your pass, and ticket ${result.code} is void.`,
        "/account",
      );

    case "already_cancelled":
      return redirectWith(
        c,
        me.session,
        "That place was already released. Nothing changed.",
        "/account",
      );

    // Someone else's ticket is a 404, not a 403 — do not confirm it exists.
    case "forbidden":
    case "not_found":
      return c.json({ error: "Ticket not found" }, 404);
  }
});

export default account;
