/**
 * The signed-in member's own surface: what they hold, what they booked, and
 * the two steps that move money and tickets.
 *
 *   GET  /account
 *   GET  /account/tickets/:code
 *   GET  /communities/:slug/packages/:packageId/checkout
 *   POST /communities/:slug/packages/:packageId/buy
 *   POST /events/:slug/book
 *   POST /events/:slug/ticket
 *   POST /account/tickets/:code/cancel
 *
 * `src/routes/profile.tsx` is mounted into this router (see the bottom of the
 * file), so `/members/:id`, `/account/profile` and `/api/members/:id` are
 * served from here too.
 *
 * Mounted at `/` in `src/index.ts`, so the paths above are the contract's URLs
 * (`design/reference/api-contract.md`). Handlers stay thin (AGENTS.md §8):
 * authorise, load, render — every mutation is a call into `src/services/`,
 * which owns the `batch()`es. Nothing here writes with two awaits, and nothing
 * here reimplements a service.
 *
 * Two rules from `design/reference/design-decisions.md` shape the reads:
 *
 *   - **Tickets are grouped by community and never totalled across them** (§5). A
 *     package is scoped to one community, so a combined number would be a figure
 *     nobody can spend.
 *   - **Nothing is hand-formatted.** Dates and money go through
 *     `src/lib/format.ts`, so the ticket, the ledger and the checkout agree.
 *
 * A few reads are queried here rather than through `src/services/`: which order
 * a package came from, the host a request is waiting on, the next event per
 * community. The service layer is owned elsewhere and returns none of those
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
import { bookings, communityMembers, communities, events, orders, packages, memberPackages, users } from "../schema";
import { getCommunityBySlug } from "../services/communities";
import {
  book,
  cancel,
  getPackageForCommunity,
  listBookingsForUser,
  purchase,
  purchaseTicket,
  type BookingSummary,
  type PaymentMethod,
} from "../services/commerce";
import { getWallet } from "../services/wallet";
import { listEvents } from "../services/events";
import { listMembershipsForUser, type MembershipSummary } from "../services/members";
import { CheckoutSummary, TicketSquares, TicketPlate } from "../ui/booking";
import { Alert, Badge, Button, EmptyState, Hero, PackageCard, PackageGrid, Section } from "../ui/components";
import { Layout } from "../ui/layout";
import profile from "./profile";
import walletRoutes, { balanceOptionFor, EMPTY_BALANCE } from "./wallet";

const account = new Hono<{ Bindings: AuthEnv }>();

/**
 * The member surface, continued: `/members/:id`, `/account/profile` and
 * `/api/members/:id`. Mounted at module scope so the routes are on this router
 * before `src/index.ts` mounts it — `app.route()` copies the routes a sub-app
 * has at the moment it is called, not the ones it grows afterwards.
 */
account.route("/", profile);

/**
 * And the demo balance: `/account/wallet` and its top-up. Same reason as
 * above — mounted at module scope, before `src/index.ts` mounts this router.
 */
account.route("/", walletRoutes);

type PageContext = Context<{ Bindings: AuthEnv }>;

/** Every list read here is bounded (AGENTS.md §5). One member's own history is small. */
const ROW_LIMIT = 50;

/**
 * The cancellation deadline printed on the ticket is **the start of the
 * event**, because that is the deadline the product actually enforces:
 * `cancel()` in `src/services/commerce.ts` always hands the ticket back, and
 * this page stops offering the release once the event has begun. An
 * earlier, prettier deadline would be a number the app does not keep.
 */
function cancelDeadline(startsAt: Date): Date {
  return startsAt;
}

/**
 * What to bring, by the community's category.
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
            All events
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
 * `.package-table` is `width:100%`, so inside a `.scroll-x` box it can never be
 * wider than the box — it squeezes the flexible columns to one character per
 * line instead. A minimum width is what makes the box actually scroll, which is
 * §10.4's answer for content that genuinely cannot wrap. Measured at 375.
 */
function wide(rem: number): string {
  return `min-width:${rem}rem`;
}

/**
 * Which of the two ways to pay a form asked for.
 *
 * A missing or unrecognised value is the card, which is what every form posted
 * before there was a balance to spend — so nothing that worked before this
 * change behaves differently.
 */
function paymentMethod(raw: unknown): PaymentMethod {
  return raw === "balance" ? "balance" : "card";
}

/** `3 events · €120 each` — the derivation §6 asks every price to show. */
function derivation(tickets: number, priceCents: number, currency: string): string {
  const each = formatMoney(Math.round(priceCents / Math.max(1, tickets)), currency);
  return `${tickets} ${tickets === 1 ? "event" : "events"} · ${each} each`;
}

/* ------------------------------------------------------------------- reads */

/** A package a member holds, with the order it came from. */
type HeldPackage = {
  memberPackageId: string;
  communitySlug: string;
  communityName: string;
  packageName: string;
  ticketsTotal: number;
  ticketsUsed: number;
  amountCents: number;
  currency: string;
  reference: string;
  boughtAt: Date;
};

/**
 * Every package this member holds, with the order that created it. The account
 * page shows what was bought, when and for how much; `listPackagesForUser`
 * (which the JSON API uses) carries none of that.
 */
async function listHeldPackages(env: DatabaseEnv, userId: string): Promise<HeldPackage[]> {
  const db = getDb(env);
  const rows = await db
    .select({
      memberPackageId: memberPackages.id,
      communitySlug: communities.slug,
      communityName: communities.name,
      packageName: packages.name,
      ticketsTotal: memberPackages.ticketsTotal,
      ticketsUsed: memberPackages.ticketsUsed,
      amountCents: orders.amountCents,
      currency: orders.currency,
      reference: orders.reference,
      boughtAt: orders.createdAt,
    })
    .from(memberPackages)
    .innerJoin(communities, eq(communities.id, memberPackages.communityId))
    .innerJoin(orders, eq(orders.id, memberPackages.orderId))
    .innerJoin(packages, eq(packages.id, orders.packageId))
    .where(eq(memberPackages.userId, userId))
    .orderBy(desc(orders.createdAt))
    .limit(ROW_LIMIT);

  return rows.map((row) => ({
    ...row,
    ticketsTotal: Number(row.ticketsTotal),
    ticketsUsed: Number(row.ticketsUsed),
    amountCents: Number(row.amountCents),
  }));
}

/** The soonest published event in each community this member belongs to. */
type NextEvent = { slug: string; title: string; startsAt: Date };

async function nextEventByCommunity(
  env: DatabaseEnv,
  userId: string,
  now: Date,
): Promise<Map<string, NextEvent>> {
  const db = getDb(env);
  const rows = await db
    .select({
      communitySlug: communities.slug,
      slug: events.slug,
      title: events.title,
      startsAt: events.startsAt,
    })
    .from(events)
    .innerJoin(communities, eq(communities.id, events.communityId))
    .innerJoin(communityMembers, eq(communityMembers.communityId, communities.id))
    .where(
      and(
        eq(communityMembers.userId, userId),
        eq(events.status, "published"),
        gte(events.startsAt, now),
      ),
    )
    .orderBy(asc(events.startsAt))
    .limit(ROW_LIMIT);

  // Sorted soonest first, so the first row seen for a community is its next date.
  const byCommunity = new Map<string, NextEvent>();
  for (const row of rows) {
    if (!byCommunity.has(row.communitySlug)) {
      byCommunity.set(row.communitySlug, { slug: row.slug, title: row.title, startsAt: row.startsAt });
    }
  }
  return byCommunity;
}

/** A request still with a host: which community, who decides, and when it was made. */
type PendingRequest = {
  communitySlug: string;
  communityName: string;
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
      communitySlug: communities.slug,
      communityName: communities.name,
      hostName: users.name,
      requestedAt: communityMembers.createdAt,
    })
    .from(communityMembers)
    .innerJoin(communities, eq(communities.id, communityMembers.communityId))
    .innerJoin(users, eq(users.id, communities.hostUserId))
    .where(and(eq(communityMembers.userId, userId), eq(communityMembers.status, "pending")))
    .orderBy(asc(communityMembers.createdAt))
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
  communitySlug: string;
  communityName: string;
  category: string;
  packageName: string;
  ticketsTotal: number;
  ticketsUsed: number;
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
      country: communities.country,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      communitySlug: communities.slug,
      communityName: communities.name,
      category: communities.category,
      packageName: packages.name,
      ticketsTotal: memberPackages.ticketsTotal,
      ticketsUsed: memberPackages.ticketsUsed,
    })
    .from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId))
    .innerJoin(communities, eq(communities.id, events.communityId))
    .innerJoin(memberPackages, eq(memberPackages.id, bookings.memberPackageId))
    .innerJoin(orders, eq(orders.id, memberPackages.orderId))
    .innerJoin(packages, eq(packages.id, orders.packageId))
    .where(and(eq(bookings.code, code), eq(bookings.userId, userId)))
    .limit(1);
  if (!row) return null;
  return { ...row, ticketsTotal: Number(row.ticketsTotal), ticketsUsed: Number(row.ticketsUsed) };
}

/** The community an event belongs to — one indexed lookup, for the "full" refusal. */
async function getEventCommunitySlug(env: DatabaseEnv, eventSlug: string): Promise<string | null> {
  const db = getDb(env);
  const [row] = await db
    .select({ communitySlug: communities.slug })
    .from(events)
    .innerJoin(communities, eq(communities.id, events.communityId))
    .where(eq(events.slug, eventSlug))
    .limit(1);
  return row?.communitySlug ?? null;
}

/* ------------------------------------------------------------- the account */

/** One community's worth of tickets: the packages, and the movements behind them. */
type CommunityTickets = {
  slug: string;
  name: string;
  held: HeldPackage[];
  ticketsLeft: number;
  spent: BookingSummary[];
  returned: BookingSummary[];
};

/**
 * Packages and bookings folded together per community. **No combined total** — a
 * package is good for one community, and a number spanning them would lie (§5).
 */
function ticketsByCommunity(held: HeldPackage[], booked: BookingSummary[]): CommunityTickets[] {
  const groups = new Map<string, CommunityTickets>();
  for (const bought of held) {
    const group = groups.get(bought.communitySlug) ?? {
      slug: bought.communitySlug,
      name: bought.communityName,
      held: [],
      ticketsLeft: 0,
      spent: [],
      returned: [],
    };
    group.held.push(bought);
    group.ticketsLeft += Math.max(0, bought.ticketsTotal - bought.ticketsUsed);
    groups.set(bought.communitySlug, group);
  }
  for (const booking of booked) {
    const group = groups.get(booking.communitySlug);
    if (!group) continue;
    if (booking.status === "confirmed") group.spent.push(booking);
    else group.returned.push(booking);
  }
  return [...groups.values()];
}

/**
 * The ledger for one community: bought, spent, handed back, and what is left.
 * The tickets column adds up to the closing figure, which is the whole point
 * of showing it.
 */
function TicketLedger(props: { group: CommunityTickets }) {
  const { group } = props;
  return (
    <div class="bordered scroll-x" tabindex={0} style="margin-block-start:24px">
      <table class="package-table" style={wide(30)}>
        <caption class="vh">Ticket ledger for {group.name}</caption>
        <thead style={NOWRAP}>
          <tr>
            <th scope="col">Movement</th>
            <th scope="col">Detail</th>
            <th scope="col">Date</th>
            <th scope="col">Tickets</th>
          </tr>
        </thead>
        <tbody>
          {group.held.map((bought) => (
            <tr>
              <th scope="row" style={NOWRAP}>
                Bought
              </th>
              <td>
                {bought.packageName}
                <span class="package-derivation num">{bought.reference}</span>
              </td>
              <td class="num" style={NOWRAP}>
                {formatDay(bought.boughtAt)}
              </td>
              <td class="num" style={NOWRAP}>
                +{bought.ticketsTotal}
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
            <td class="num package-price" style={NOWRAP}>
              {group.ticketsLeft}
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
      <table class="package-table" style={wide(28)}>
        <thead style={NOWRAP}>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Event</th>
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
                  <span class="package-derivation num">{formatTime(startsAt)}</span>
                </td>
                <th scope="row">
                  <a href={`/events/${row.eventSlug}`}>{row.eventTitle}</a>
                  <span class="package-derivation">
                    <a href={`/communities/${row.communitySlug}`}>{row.communityName}</a> ·{" "}
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
  /** "€500" — already formatted, so this page and the wallet agree. */
  balance: string;
  flash: Flash | null;
  held: HeldPackage[];
  booked: BookingSummary[];
  memberships: MembershipSummary[];
  pending: PendingRequest[];
  nextByCommunity: Map<string, NextEvent>;
  now: Date;
};

function AccountPage(props: AccountPageProps) {
  const { user, balance, flash, held, booked, memberships, pending, nextByCommunity, now } = props;

  const groups = ticketsByCommunity(held, booked);
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
      description="Your packages, your tickets and the places you hold."
      user={{ name: user.name }}
      active="account"
    >
      {flash !== null ? <FlashBanner message={flash} /> : null}

      <Hero
        index="01"
        label="Account"
        title="Your account"
        lede="Tickets are held per community. Booking spends one, and cancelling in time puts it back."
      >
        <p class="meta num">{user.email}</p>
        {/* The email is on this page and on no other. What members see is the
            profile, which is what this link opens. */}
        <Button href="/account/profile" variant="quiet">
          Your profile
        </Button>
        <Button href="/account/wallet" variant="quiet">
          Your balance — <span class="num">{balance}</span>
        </Button>
      </Hero>

      <Section
        index="02"
        label="Tickets"
        title="What you hold"
        action={{ href: "/communities", label: "Find a community" }}
      >
        {groups.length === 0 ? (
          <EmptyState
            title="No packages yet."
            note="A package buys tickets for one community. One ticket takes one place at one event."
            action={{ href: "/communities", label: "Browse communities" }}
          />
        ) : (
          <div class="stack stack--wide" data-tickets="">
            {groups.map((group) => {
              const next = nextByCommunity.get(group.slug);
              return (
                <div data-community={group.slug}>
                  <div class="row">
                    <h3 class="h-card">
                      <a href={`/communities/${group.slug}`}>{group.name}</a>
                    </h3>
                    <span class="micro micro--brass">
                      {group.ticketsLeft} {group.ticketsLeft === 1 ? "ticket" : "tickets"} left
                    </span>
                  </div>
                  <p class="meta" style="margin-block-start:8px">
                    {next !== undefined ? (
                      <>
                        Next: <a href={`/events/${next.slug}`}>{next.title}</a>,{" "}
                        <span class="num">{formatDay(next.startsAt)}</span>
                      </>
                    ) : (
                      "No events scheduled yet."
                    )}
                  </p>

                  <div style="margin-block-start:24px">
                    <PackageGrid>
                      {group.held.map((bought) => (
                        <PackageCard
                          name={bought.packageName}
                          tickets={bought.ticketsTotal}
                          price={formatMoney(bought.amountCents, bought.currency)}
                          derivation={derivation(bought.ticketsTotal, bought.amountCents, bought.currency)}
                          note={`Bought ${formatDay(bought.boughtAt)}`}
                        >
                          <div style="margin-block-start:16px">
                            <TicketSquares
                              total={bought.ticketsTotal}
                              used={bought.ticketsUsed}
                              label={`${bought.ticketsTotal - bought.ticketsUsed} of ${bought.ticketsTotal} tickets left on your ${bought.packageName} for ${group.name}`}
                            />
                          </div>
                        </PackageCard>
                      ))}
                    </PackageGrid>
                  </div>

                  <TicketLedger group={group} />
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
            note="A ticket takes a place. Cancelling before the deadline hands it back."
            action={{ href: "/events", label: "All events" }}
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

      <Section index="05" label="Communities" title="Communities you are in">
        {joined.length === 0 ? (
          <EmptyState
            title="Not in a community yet."
            note="Buying a package on an open community joins it. A private one asks the host first."
            action={{ href: "/communities", label: "Browse communities" }}
          />
        ) : (
          <div class="bordered scroll-x" tabindex={0} data-communities="">
            <table class="package-table" style={wide(24)}>
              <thead style={NOWRAP}>
                <tr>
                  <th scope="col">Community</th>
                  <th scope="col">Next event</th>
                </tr>
              </thead>
              <tbody>
                {joined.map((m) => {
                  const next = nextByCommunity.get(m.communitySlug);
                  return (
                    <tr>
                      <th scope="row">
                        <a href={`/communities/${m.communitySlug}`}>{m.communityName}</a>
                        <span class="package-derivation">
                          <Badge tone={m.role === "host" ? "brass" : "quiet"}>
                            {m.role === "host" ? "Host" : "Member"}
                          </Badge>
                        </span>
                      </th>
                      <td>
                        {next !== undefined ? (
                          <>
                            <a href={`/events/${next.slug}`}>{next.title}</a>
                            <span class="package-derivation num" style={NOWRAP}>
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
              <table class="package-table" style={wide(26)}>
                <thead style={NOWRAP}>
                  <tr>
                    <th scope="col">Community</th>
                    <th scope="col">Asked</th>
                    <th scope="col">With</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((request) => (
                    <tr>
                      <th scope="row">
                        <a href={`/communities/${request.communitySlug}`}>{request.communityName}</a>
                        <span class="package-derivation">
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
              A host approves by hand. Browsing carries on meanwhile, and the event list opens
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
  const [flash, held, booked, memberships, pending, nextByCommunity, wallet] = await Promise.all([
    takeFlash(c.env, me.session),
    listHeldPackages(c.env, me.user.id),
    listBookingsForUser(c.env, me.user.id, { limit: ROW_LIMIT }),
    listMembershipsForUser(c.env, me.user.id, { limit: ROW_LIMIT }),
    listPendingRequests(c.env, me.user.id),
    nextEventByCommunity(c.env, me.user.id, now),
    getWallet(c.env, me.user.id),
  ]);

  pageHeaders(c);
  return c.html(
    <AccountPage
      user={{ name: me.user.name, email: me.user.email }}
      balance={wallet.exists ? formatMoney(wallet.balanceCents, wallet.currency) : EMPTY_BALANCE}
      flash={flash}
      held={held}
      booked={booked}
      memberships={memberships}
      pending={pending}
      nextByCommunity={nextByCommunity}
      now={now}
    />,
  );
});

/* -------------------------------------------------------------- the ticket */

function TicketPage(props: { user: { name: string }; flash: Flash | null; ticket: Ticket }) {
  const { user, flash, ticket } = props;
  const cancelBy = cancelDeadline(ticket.startsAt);
  const cancelByLabel = `${formatDay(cancelBy)} · ${formatTime(cancelBy)}`;
  const ticketsLeft = Math.max(0, ticket.ticketsTotal - ticket.ticketsUsed);
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
          <a href={`/communities/${ticket.communitySlug}`}>{ticket.communityName}</a>
        </p>
      </Hero>

      <Section index="02" label="Your place" title="Show this on the day">
        <div data-ticket={ticket.code}>
          {ticket.status === "cancelled" ? (
            <div style="margin-block-end:24px">
              <Alert tone="rust">
                This place was released. The ticket went back on your {ticket.packageName} for{" "}
                {ticket.communityName}.
              </Alert>
            </div>
          ) : null}

          <TicketPlate
            seed={ticket.eventSlug}
            code={ticket.code}
            title={ticket.title}
            communityName={ticket.communityName}
            when={formatDateRange(ticket.startsAt, ticket.endsAt)}
            venue={ticket.venue}
            address={placeLabel(ticket.city, ticket.country)}
            packageName={`${ticket.packageName} · ${ticketsLeft} of ${ticket.ticketsTotal} tickets left`}
            bring={BRING[ticket.category]}
            cancelBy={cancelByLabel}
          />

          <div class="row" style="margin-block-start:32px">
            <Button href={`/events/${ticket.eventSlug}`} variant="quiet">
              The event
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
                Free right up to the start, <span class="num">{cancelByLabel}</span>. The ticket
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

account.get("/communities/:slug/packages/:packageId/checkout", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  const found = await getCommunityBySlug(c.env, c.req.param("slug"));
  if (!found) {
    return notFoundPage(c, me, {
      title: "No such community",
      note: "That community is not here. The directory lists the ones that are.",
    });
  }

  const offer = await getPackageForCommunity(c.env, found.community.id, c.req.param("packageId"));
  if (!offer) {
    return notFoundPage(c, me, {
      title: "No such package",
      note: `${found.community.name} does not sell that package. Its own three are on the community page.`,
    });
  }

  const next = safeNext(c.req.query("next"));
  const price = formatMoney(offer.priceCents, offer.currency);
  const here = `/communities/${found.community.slug}/packages/${offer.id}/checkout${
    next === undefined ? "" : `?next=${encodeURIComponent(next)}`
  }`;
  const [flash, balance] = await Promise.all([
    takeFlash(c.env, me.session),
    // Topping up comes back to this checkout, so the second click is the buy.
    balanceOptionFor(c.env, me.user.id, { amountCents: offer.priceCents, currency: offer.currency }, here),
  ]);

  pageHeaders(c);
  return c.html(
    <Layout
      title={`Confirm — ${offer.name}`}
      description={`${offer.name} for ${found.community.name}.`}
      user={{ name: me.user.name }}
    >
      {flash !== null ? <FlashBanner message={flash} /> : null}

      <Hero
        index="01"
        label="Checkout"
        title="One step, then it is yours"
        lede={`${offer.name} for ${found.community.name}. Pay from your balance or by card — neither charges anything, and both record the order and issue the tickets.`}
      />

      <Section index="02" label="Order" title={`${offer.name} · ${price}`}>
        <div data-checkout={offer.id}>
          <CheckoutSummary
            communityName={found.community.name}
            packageName={offer.name}
            tickets={offer.tickets}
            price={price}
            perEvent={derivation(offer.tickets, offer.priceCents, offer.currency)}
            action={`/communities/${found.community.slug}/packages/${offer.id}/buy`}
            nonce={issuePurchaseNonce()}
            next={next}
            balance={balance}
          />
          <p class="action-help" style="margin-block-start:24px">
            {found.community.isPrivate
              ? "Tickets are good for this community only. The host still approves members by hand."
              : "Tickets are good for this community only. Buying joins the community, so you can book straight away."}
          </p>
        </div>
      </Section>
    </Layout>,
  );
});

/* ---------------------------------------------------------------------- buy */

account.post("/communities/:slug/packages/:packageId/buy", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  const found = await getCommunityBySlug(c.env, c.req.param("slug"));
  if (!found) return c.json({ error: "Community not found" }, 404);

  const body = await c.req.parseBody();
  const next = safeNext(typeof body.next === "string" ? body.next : undefined);
  const nonce = typeof body.nonce === "string" && body.nonce !== "" ? body.nonce : undefined;
  const payWith = paymentMethod(body.pay);

  // `purchase` writes the order, the package, — on an open community — the
  // approved membership, and, when the balance is paying, the debit and its
  // ledger line, in ONE batch. It spends the nonce into `orders.reference`, so
  // a double submit collides on the unique index rather than buying twice.
  const result = await purchase(c.env, {
    userId: me.user.id,
    communityId: found.community.id,
    packageId: c.req.param("packageId"),
    nonce,
    payWith,
  });

  if (result.status === "package_not_found") return c.json({ error: "Package not found" }, 404);

  if (result.status === "insufficient_balance") {
    // Back to the checkout, where the top-up link sits under the refusal.
    const back = `/communities/${found.community.slug}/packages/${c.req.param("packageId")}/checkout${
      next === undefined ? "" : `?next=${encodeURIComponent(next)}`
    }`;
    return redirectWith(
      c,
      me.session,
      flashMessage(
        "warn",
        result.balanceCurrency !== result.currency
          ? `Your balance is held in ${result.balanceCurrency} and this package is priced in ${result.currency}. Nothing was bought.`
          : `Your balance is ${formatMoney(result.balanceCents, result.currency)}, which is ${formatMoney(result.amountCents - result.balanceCents, result.currency)} short. Nothing was bought.`,
      ),
      back,
    );
  }

  if (result.status === "already_processed") {
    return redirectWith(
      c,
      me.session,
      `Already processed. Order ${result.reference} stands, and no second one was created.`,
      next ?? "/account",
    );
  }

  const joined = result.joinedCommunity ? ` You are in ${found.community.name}.` : "";
  const how = result.paidWith === "balance" ? " from your balance" : "";
  return redirectWith(
    c,
    me.session,
    `${result.tickets} ${result.tickets === 1 ? "ticket" : "tickets"} for ${found.community.name}. Order ${result.reference}, ${formatMoney(result.amountCents, result.currency)}${how}.${joined}`,
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
        `You're going. Ticket ${result.code}, and ${result.ticketsLeft} ${result.ticketsLeft === 1 ? "ticket" : "tickets"} left.`,
        `/account/tickets/${result.code}`,
      );

    case "already_booked":
      return redirectWith(
        c,
        me.session,
        "You already hold this place. No second ticket was spent.",
        `/account/tickets/${result.code}`,
      );

    // A draft is invisible to members, so it is missing rather than refused.
    case "event_not_found":
    case "not_published":
      return c.json({ error: "Event not found" }, 404);

    case "no_tickets":
      // The event page answers this with the three package buttons directly
      // under the banner, so the refusal and its fix are on one screen.
      return redirectWith(
        c,
        me.session,
        flashMessage("warn", "No tickets left for this community. Take a package below and the place is yours."),
        back,
      );

    case "not_a_member":
      return redirectWith(
        c,
        me.session,
        flashMessage("warn", "Members only. Buying a package joins an open community; a private one asks the host first."),
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
      // A refusal with no alternative is a dead end — name the community's next one.
      const communitySlug = await getEventCommunitySlug(c.env, slug);
      const now = Date.now();
      const upcoming =
        communitySlug === null ? [] : await listEvents(c.env, { communitySlug, limit: ROW_LIMIT });
      const nextUp = upcoming.find(
        (e) => e.slug !== slug && e.placesLeft > 0 && new Date(e.startsAt).getTime() > now,
      );
      const offer =
        nextUp === undefined
          ? ""
          : ` Next from this community: ${nextUp.title}, ${formatDay(new Date(nextUp.startsAt))}.`;
      return redirectWith(
        c,
        me.session,
        flashMessage("warn", `That event is full, and nothing was spent.${offer}`),
        back,
      );
    }
  }
});

/* ------------------------------------------------------------ one ticket */

/**
 * Buy one place at this event, without choosing a package first: the community's
 * 1-ticket package and the booking, in one submit.
 *
 * All of the work is `purchaseTicket()` in `src/services/commerce.ts` — it
 * calls `purchase()` and then `book()`, checks every refusal before any money
 * moves, and reverses the order if the last place goes in between. Nothing is
 * reimplemented here; this authorises, calls it, and turns the tagged result
 * into a redirect and a line of copy.
 *
 * The `nonce` is the same one-time nonce the checkout form carries. A double
 * tap sends it twice, `purchase()` spends it into the uniquely-indexed order
 * reference, and the second one is recognised rather than charged.
 */
account.post("/events/:slug/ticket", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  const slug = c.req.param("slug");
  const back = `/events/${slug}`;
  const body = await c.req.parseBody();
  const nonce = typeof body.nonce === "string" && body.nonce !== "" ? body.nonce : undefined;
  const payWith = paymentMethod(body.pay);

  const result = await purchaseTicket(c.env, {
    userId: me.user.id,
    eventSlug: slug,
    nonce,
    payWith,
  });

  switch (result.status) {
    case "ticketed":
      return redirectWith(
        c,
        me.session,
        `You're going. Ticket ${result.code}, ${formatMoney(result.amountCents, result.currency)}${result.paidWith === "balance" ? " from your balance" : ""}, order ${result.reference}.`,
        `/account/tickets/${result.code}`,
      );

    case "insufficient_balance":
      return redirectWith(
        c,
        me.session,
        flashMessage(
          "warn",
          result.balanceCurrency !== result.currency
            ? `Your balance is held in ${result.balanceCurrency} and this ticket is priced in ${result.currency}. Nothing was bought.`
            : `Your balance is ${formatMoney(result.balanceCents, result.currency)}, which is ${formatMoney(result.amountCents - result.balanceCents, result.currency)} short of this ticket. Nothing was bought — top up on your balance page.`,
        ),
        back,
      );

    case "already_booked":
      return redirectWith(
        c,
        me.session,
        "You already hold this place. Nothing was bought.",
        `/account/tickets/${result.code}`,
      );

    case "already_processed":
      return redirectWith(
        c,
        me.session,
        `Already processed. Order ${result.reference} stands, and no second one was created.`,
        result.code === null ? back : `/account/tickets/${result.code}`,
      );

    // A draft is invisible to members, so it is missing rather than refused.
    case "event_not_found":
    case "not_published":
      return c.json({ error: "Event not found" }, 404);

    case "no_single_package":
      return redirectWith(
        c,
        me.session,
        flashMessage("warn", "This community does not sell a single ticket. Its packages are below."),
        back,
      );

    case "not_a_member":
      return redirectWith(
        c,
        me.session,
        flashMessage("warn", "Members only. A private community asks the host first."),
        back,
      );

    case "membership_pending":
      return redirectWith(
        c,
        me.session,
        flashMessage("warn", "Your request is still with the host. Nothing was bought."),
        back,
      );

    case "full":
      return redirectWith(
        c,
        me.session,
        flashMessage("warn", "That event is full, and nothing was bought."),
        back,
      );

    case "reversed":
      return redirectWith(
        c,
        me.session,
        flashMessage(
          "warn",
          "The last place went while the order was going through. The order was reversed, so nothing stands and nothing was charged.",
        ),
        back,
      );
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
        `Place released. The ticket is back on your package, and ticket ${result.code} is void.`,
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
