/**
 * Back of house: the communities a member runs, and everything they can change.
 *
 *   GET  /host
 *   GET  /host/communities/:slug
 *   POST /host/communities
 *   POST /host/communities/:slug/events
 *   POST /host/communities/:slug/packages
 *   POST /host/communities/:slug/members/:memberId/approve
 *
 * Mounted at `/` in `src/index.ts`, so those are the contract's URLs
 * (`design/reference/api-contract.md`).
 *
 * **This console is deliberately plainer than the member's side** (§5): no
 * plates, rules only, everything tabular with `tnum`, and status as uppercase
 * micro text rather than a coloured chip. Back-of-house as a ledger is what
 * makes front-of-house feel precious.
 *
 * Two rules hold on every write here:
 *
 *   - **Acting on a community you do not host is 403** — checked before the input
 *     is even read, so a stranger cannot probe a form's validation.
 *   - **A validation error re-renders the page with 400**, every submitted
 *     value echoed back, the problems listed in one `Alert`, and
 *     `aria-invalid` + `aria-describedby` on the offenders. Nothing typed is
 *     ever lost.
 *
 * The reads that `src/services/` does not cover — a request's date, a
 * event's drafts, revenue to date — are queried here. `src/db.ts` is
 * explicit that queries may live in a route, and every one carries a LIMIT
 * (AGENTS.md §5). Writes never do: the create-a-community batch is the only
 * multi-table write, and it is one `batch()` (AGENTS.md §5 — `db.transaction()`
 * throws on this platform).
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import {
  requireUser,
  setFlash,
  takeFlash,
  type AuthEnv,
  type Flash,
  type SessionUser,
} from "../auth";
import { batch, getDb, type DatabaseEnv } from "../db";
import { formatDateRange, formatDay, formatMoney, formatTime } from "../lib/format";
import { newId, slugify, uniqueSlug } from "../lib/ids";
import {
  bookings,
  communityMembers,
  communities,
  events,
  orders,
  packages,
  users,
  COMMUNITY_CATEGORIES,
  type CommunityCategory,
} from "../schema";
import { approvedMemberCount, confirmedBookingCount, placesLeft } from "../services/common";
import { getCommunityBySlug, type CommunityDetail } from "../services/communities";
import { listPackages, type PackageOffer } from "../services/commerce";
import { Alert, Button, EmptyState, Field, Hero, Section } from "../ui/components";
import { Layout } from "../ui/layout";

const host = new Hono<{ Bindings: AuthEnv }>();

type PageContext = Context<{ Bindings: AuthEnv }>;

/** Every list read here is bounded (AGENTS.md §5). */
const ROW_LIMIT = 50;
/** Attendees across a whole community: 8 events of 24 still fits comfortably. */
const ATTENDEE_LIMIT = 200;
/** Names printed in an event's row before the rest become `+N`. */
const NAMES_SHOWN = 6;

/** An event runs two hours unless the host says otherwise. */
const DEFAULT_DURATION_HOURS = 2;
/** Twelve is the house default; a host can change it before submitting. */
const DEFAULT_CAPACITY = "12";

/* ------------------------------------------------------------ small helpers */

/**
 * `body { overflow-wrap:anywhere }` (§10.4) is right for prose and wrong for a
 * date, a code or a figure — at 375 it breaks `09:20` across two lines. These
 * cells do not wrap; the table scrolls inside its own `.scroll-x` box instead.
 */
const NOWRAP = "white-space:nowrap";

/**
 * `.package-table` is `width:100%`, so inside a `.scroll-x` box it squeezes rather
 * than scrolls. A minimum width is what lets the box scroll instead — the
 * §10.4 answer for a ledger that cannot wrap. Measured at 375.
 */
function wide(rem: number): string {
  return `min-width:${rem}rem`;
}

/** `Cache-Control: private, no-cache` on every GET page (§10.4) — never `no-store`. */
function pageHeaders(c: PageContext): void {
  c.header("cache-control", "private, no-cache");
}

/** Park the one-line result on the session, then 302. */
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
 * `role="status"`, no auto-dismiss (§10.4).
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

/** Every problem with what was just submitted, in one place, above the `<h1>`. */
function ErrorBanner(props: { problems: string[] }) {
  return (
    <div class="shell" style="padding-block-start:24px">
      <Alert tone="rust">
        <p>
          {props.problems.length} {props.problems.length === 1 ? "thing needs" : "things need"}{" "}
          fixing before this saves. Nothing you typed was lost.
        </p>
        {props.problems.map((problem) => (
          <p class="meta">{problem}</p>
        ))}
      </Alert>
    </div>
  );
}

/** A styled 404 (§8: never a stack trace). */
function notFoundPage(c: PageContext, me: SessionUser): Response | Promise<Response> {
  pageHeaders(c);
  return c.html(
    <Layout title="No such community" user={{ name: me.user.name }} active="host">
      <Hero
        index="00"
        label="Not found"
        title="No such community"
        lede="That community is not here. The ones you run are listed on your host page."
      />
      <Section index="01" label="Elsewhere" title="Where to go instead">
        <Button href="/host" variant="ghost">
          Your communities
        </Button>
      </Section>
    </Layout>,
    404,
  );
}

/** A styled 403 (§8). Someone else's community is refused, not hidden. */
function forbiddenPage(
  c: PageContext,
  me: SessionUser,
  community: { name: string },
): Response | Promise<Response> {
  pageHeaders(c);
  return c.html(
    <Layout title="Not your community" user={{ name: me.user.name }} active="host">
      <Hero
        index="00"
        label="Refused"
        title="Not your community"
        lede={`${community.name} is run by someone else. Only its host can change it.`}
      />
      <Section index="01" label="Elsewhere" title="Where to go instead">
        <div class="row">
          <Button href="/host" variant="ghost">
            Communities you run
          </Button>
          <Button href="/communities" variant="quiet">
            The directory
          </Button>
        </div>
      </Section>
    </Layout>,
    403,
  );
}

/* --------------------------------------------------------------- form input */

/** One submitted field, trimmed. A file upload is not a string and reads as empty. */
function readField(body: Record<string, unknown>, key: string): string {
  const raw = body[key];
  return typeof raw === "string" ? raw.trim() : "";
}

/** A checkbox is `"on"` when ticked and absent when not. */
function readFlag(body: Record<string, unknown>, key: string): boolean {
  return readField(body, key) === "on";
}

/** Every problem, keyed by field, so the summary and the field agree. */
type Errors = Record<string, string>;

function requireText(
  errors: Errors,
  field: string,
  value: string,
  label: string,
  max: number,
): void {
  if (value === "") errors[field] = `${label} is needed.`;
  else if (value.length > max) errors[field] = `${label} is longer than ${max} characters.`;
}

/** A whole number inside a range, or a message saying what the range is. */
function readNumber(
  errors: Errors,
  field: string,
  value: string,
  label: string,
  min: number,
  max: number,
): number | null {
  const parsed = Number(value);
  if (value === "" || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    errors[field] = `${label} must be a whole number between ${min} and ${max}.`;
    return null;
  }
  return parsed;
}

/** `datetime-local` posts `YYYY-MM-DDTHH:MM`. Read as UTC, which is what the app stores and prints. */
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function readDateTime(errors: Errors, field: string, value: string, label: string): Date | null {
  if (!LOCAL_DATETIME.test(value)) {
    errors[field] = `${label} must be a date and a time, e.g. 2026-09-12T18:30.`;
    return null;
  }
  const parsed = new Date(`${value}:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    errors[field] = `${label} is not a real date.`;
    return null;
  }
  return parsed;
}

/** `2026-09-12T18:30` — what a `datetime-local` input wants back. */
function toLocalInput(d: Date): string {
  return d.toISOString().slice(0, 16);
}

/**
 * The coming Saturday at 18:00, so the form opens on a plausible evening
 * rather than on an empty field. Today never counts: an event someone is
 * filling in now is not this afternoon.
 */
function nextSaturdayEvening(now: Date): Date {
  const days = (6 - now.getUTCDay() + 7) % 7 || 7;
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, 18, 0, 0, 0),
  );
  return d;
}

/**
 * `slugify` returns "" for a name with no letters or digits, and `uniqueSlug`
 * would then hand back "-2". Fall back before it ever sees an empty base.
 */
async function freeSlug(
  env: DatabaseEnv,
  base: string,
  fallback: string,
  taken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  return uniqueSlug(slugify(base) || fallback, taken);
}

async function communitySlugTaken(env: DatabaseEnv, candidate: string): Promise<boolean> {
  const db = getDb(env);
  const [row] = await db
    .select({ id: communities.id })
    .from(communities)
    .where(eq(communities.slug, candidate))
    .limit(1);
  return row !== undefined;
}

async function eventSlugTaken(env: DatabaseEnv, candidate: string): Promise<boolean> {
  const db = getDb(env);
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.slug, candidate))
    .limit(1);
  return row !== undefined;
}

/* ------------------------------------------------------------------- reads */

/** One row of the host's own index. */
type HostedCommunityRow = {
  slug: string;
  name: string;
  city: string;
  country: string;
  category: CommunityCategory;
  isPrivate: boolean;
  memberCount: number;
  publishedCount: number;
  draftCount: number;
  pendingCount: number;
};

/**
 * The communities this member runs, with the three numbers a host actually checks:
 * who is in, what is on, and who is waiting.
 *
 * Three queries rather than one: `approvedMemberCount` is a proven correlated
 * subquery (`src/services/common.ts`), while the two count-by-status rollups
 * are plain aggregates. They do not depend on each other, so they run together.
 */
async function listHostedCommunityRows(
  env: DatabaseEnv,
  userId: string,
): Promise<HostedCommunityRow[]> {
  const db = getDb(env);

  const [rows, eventCounts, pendingCounts] = await Promise.all([
    db
      .select({
        id: communities.id,
        slug: communities.slug,
        name: communities.name,
        city: communities.city,
        country: communities.country,
        category: communities.category,
        isPrivate: communities.isPrivate,
        memberCount: approvedMemberCount(communities.id),
      })
      .from(communities)
      .where(eq(communities.hostUserId, userId))
      .orderBy(asc(communities.createdAt))
      .limit(ROW_LIMIT),

    db
      .select({
        communityId: events.communityId,
        status: events.status,
        n: sql<number>`count(*)::int`.mapWith(Number),
      })
      .from(events)
      .innerJoin(communities, eq(communities.id, events.communityId))
      .where(eq(communities.hostUserId, userId))
      .groupBy(events.communityId, events.status)
      .limit(ROW_LIMIT * 3),

    db
      .select({ communityId: communityMembers.communityId, n: sql<number>`count(*)::int`.mapWith(Number) })
      .from(communityMembers)
      .innerJoin(communities, eq(communities.id, communityMembers.communityId))
      .where(and(eq(communities.hostUserId, userId), eq(communityMembers.status, "pending")))
      .groupBy(communityMembers.communityId)
      .limit(ROW_LIMIT),
  ]);

  const pendingById = new Map(pendingCounts.map((row) => [row.communityId, Number(row.n)]));
  const published = new Map<string, number>();
  const drafts = new Map<string, number>();
  for (const row of eventCounts) {
    const target = row.status === "published" ? published : row.status === "draft" ? drafts : null;
    if (target) target.set(row.communityId, Number(row.n));
  }

  return rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    city: row.city,
    country: row.country,
    category: row.category,
    isPrivate: row.isPrivate,
    memberCount: Number(row.memberCount),
    publishedCount: published.get(row.id) ?? 0,
    draftCount: drafts.get(row.id) ?? 0,
    pendingCount: pendingById.get(row.id) ?? 0,
  }));
}

/** An event as its host sees it — drafts included, and who is coming. */
type HostEvent = {
  id: string;
  slug: string;
  title: string;
  status: "draft" | "published" | "cancelled";
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  confirmed: number;
};

/** Every event of one community, any status. Members only ever see the published ones. */
async function listHostEvents(env: DatabaseEnv, communityId: string): Promise<HostEvent[]> {
  const db = getDb(env);
  const rows = await db
    .select({
      id: events.id,
      slug: events.slug,
      title: events.title,
      status: events.status,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      capacity: events.capacity,
      confirmed: confirmedBookingCount(events.id),
    })
    .from(events)
    .where(eq(events.communityId, communityId))
    .orderBy(asc(events.startsAt))
    .limit(ROW_LIMIT);
  return rows.map((row) => ({
    ...row,
    capacity: Number(row.capacity),
    confirmed: Number(row.confirmed),
  }));
}

/** Confirmed attendees for every event of one community, in one round trip. */
async function attendeesByEvent(
  env: DatabaseEnv,
  communityId: string,
): Promise<Map<string, string[]>> {
  const db = getDb(env);
  const rows = await db
    .select({ eventId: bookings.eventId, name: users.name })
    .from(bookings)
    .innerJoin(users, eq(users.id, bookings.userId))
    .innerJoin(events, eq(events.id, bookings.eventId))
    .where(and(eq(events.communityId, communityId), eq(bookings.status, "confirmed")))
    .orderBy(asc(bookings.createdAt))
    .limit(ATTENDEE_LIMIT);

  const byEvent = new Map<string, string[]>();
  for (const row of rows) {
    const list = byEvent.get(row.eventId) ?? [];
    list.push(row.name);
    byEvent.set(row.eventId, list);
  }
  return byEvent;
}

/** One line of the roster. Pending rows carry the date they asked. */
type RosterEntry = {
  membershipId: string;
  name: string;
  headline: string | null;
  city: string | null;
  role: "host" | "member";
  status: "pending" | "approved" | "declined";
  since: Date;
};

/**
 * Everyone with a row in this community — approved, pending and declined — with
 * the date attached. The public list (`listApprovedMembers`) filters pending
 * rows out by design and carries no dates; the host needs both.
 */
async function listRoster(env: DatabaseEnv, communityId: string): Promise<RosterEntry[]> {
  const db = getDb(env);
  return db
    .select({
      membershipId: communityMembers.id,
      name: users.name,
      headline: users.headline,
      city: users.city,
      role: communityMembers.role,
      status: communityMembers.status,
      since: communityMembers.createdAt,
    })
    .from(communityMembers)
    .innerJoin(users, eq(users.id, communityMembers.userId))
    .where(eq(communityMembers.communityId, communityId))
    .orderBy(asc(communityMembers.createdAt))
    .limit(ROW_LIMIT);
}

/** Money taken for one community, per currency — packages are priced in the community's own. */
type RevenueLine = { currency: string; orders: number; tickets: number; cents: number };

async function revenueToDate(env: DatabaseEnv, communityId: string): Promise<RevenueLine[]> {
  const db = getDb(env);
  return db
    .select({
      currency: orders.currency,
      orders: sql<number>`count(*)::int`.mapWith(Number),
      tickets: sql<number>`sum(${orders.tickets})::int`.mapWith(Number),
      cents: sql<number>`sum(${orders.amountCents})::int`.mapWith(Number),
    })
    .from(orders)
    .where(and(eq(orders.communityId, communityId), eq(orders.status, "paid")))
    .groupBy(orders.currency)
    .limit(10);
}

/**
 * The currency a new package is priced in: whatever this community already sells in,
 * else the country's (§6 — currency follows the community's country).
 */
const CURRENCY_BY_COUNTRY: Record<string, string> = {
  Monaco: "EUR",
  France: "EUR",
  Portugal: "EUR",
  Spain: "EUR",
  Italy: "EUR",
  Germany: "EUR",
  Greece: "EUR",
  Netherlands: "EUR",
  "United States": "USD",
  "United Kingdom": "GBP",
  Switzerland: "CHF",
  Sweden: "SEK",
  Norway: "NOK",
  "United Arab Emirates": "AED",
  Thailand: "THB",
  Japan: "JPY",
  Australia: "AUD",
  Canada: "CAD",
};

function currencyFor(community: { country: string }, existing: PackageOffer[]): string {
  return existing[0]?.currency ?? CURRENCY_BY_COUNTRY[community.country] ?? "USD";
}

/* -------------------------------------------------------------- /host page */

type CommunityForm = {
  name: string;
  tagline: string;
  description: string;
  city: string;
  country: string;
  category: string;
  isPrivate: boolean;
};

const EMPTY_COMMUNITY_FORM: CommunityForm = {
  name: "",
  tagline: "",
  description: "",
  city: "",
  country: "",
  category: "",
  isPrivate: false,
};

/** Five words, five radios. A category is a word, never an icon and never a `<select>`. */
function CategoryChoice(props: { value: string; error?: string }) {
  const { value, error } = props;
  return (
    <fieldset
      aria-invalid={error !== undefined ? "true" : undefined}
      aria-describedby={error !== undefined ? "e-category" : undefined}
    >
      <legend class="field-label">
        Category<span class="field-req"> *</span>
      </legend>
      <div class="row" style="gap:8px 24px">
        {COMMUNITY_CATEGORIES.map((category) => (
          <label
            class="micro"
            style="display:inline-flex;align-items:center;gap:8px;min-height:44px;cursor:pointer"
          >
            <input
              type="radio"
              name="category"
              value={category}
              checked={value === category}
              style="accent-color:var(--ink);inline-size:18px;block-size:18px"
            />
            {category}
          </label>
        ))}
      </div>
      {error !== undefined ? (
        <span class="field-error" id="e-category">
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}

function HostPage(props: {
  user: { name: string };
  flash: Flash | null;
  problems: string[];
  errors: Errors;
  form: CommunityForm;
  rows: HostedCommunityRow[];
}) {
  const { user, flash, problems, errors, form, rows } = props;

  return (
    <Layout
      title="Host"
      description="The communities you run, and the form that starts another."
      user={{ name: user.name }}
      active="host"
    >
      {problems.length > 0 ? <ErrorBanner problems={problems} /> : null}
      {flash !== null && problems.length === 0 ? <FlashBanner message={flash} /> : null}

      <Hero
        index="01"
        label="Host"
        title="Back of house"
        lede="Your communities, what is on, and who is waiting. Members never see this side."
      />

      <Section index="02" label="Communities" title="Communities you run">
        {rows.length === 0 ? (
          <EmptyState
            title="No communities yet."
            note="A community needs a name, a city and a description. The form below starts one."
            action={{ href: "#new-community", label: "Start a community" }}
          />
        ) : (
          <div class="bordered scroll-x" tabindex={0} data-hosted="">
            <table class="package-table" style={wide(38)}>
              <thead style={NOWRAP}>
                <tr>
                  <th scope="col">Community</th>
                  <th scope="col">Where</th>
                  <th scope="col">Members</th>
                  <th scope="col">Events</th>
                  <th scope="col">Waiting</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr>
                    <th scope="row">
                      <a href={`/host/communities/${row.slug}`}>{row.name}</a>
                      <span class="package-derivation">
                        {row.category} · {row.isPrivate ? "by request" : "open"}
                      </span>
                    </th>
                    <td>
                      {row.city}
                      <span class="package-derivation">{row.country}</span>
                    </td>
                    <td class="num" style={NOWRAP}>
                      {row.memberCount}
                    </td>
                    <td class="num" style={NOWRAP}>
                      {row.publishedCount}
                      {row.draftCount > 0 ? (
                        <span class="package-derivation num">{row.draftCount} draft</span>
                      ) : null}
                    </td>
                    <td class="num" style={NOWRAP}>
                      {row.pendingCount > 0 ? (
                        <a href={`/host/communities/${row.slug}#requests`}>{row.pendingCount}</a>
                      ) : (
                        "0"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section index="03" label="New" title="Start a community" id="new-community">
        <form class="column-420" method="post" action="/host/communities" data-new-community="">
          <Field
            label="Name"
            name="name"
            value={form.name}
            required={true}
            error={errors.name}
            hint="The URL is made from this."
          />
          <Field
            label="Tagline"
            name="tagline"
            value={form.tagline}
            required={true}
            error={errors.tagline}
            hint="One line on the card. A named person, a cadence, a constraint."
          />
          <Field
            label="Description"
            name="description"
            value={form.description}
            required={true}
            multiline={true}
            rows={6}
            error={errors.description}
            hint="Two to four sentences. Who runs it, how often, and what the rule is."
          />
          <Field label="City" name="city" value={form.city} required={true} error={errors.city} />
          <Field
            label="Country"
            name="country"
            value={form.country}
            required={true}
            error={errors.country}
            hint="Packages are priced in this country's currency."
          />

          <div style="margin-block-start:24px">
            <CategoryChoice value={form.category} error={errors.category} />
          </div>

          <div style="margin-block-start:24px">
            <label
              class="row"
              style="gap:12px;min-height:48px;margin-inline:-12px;padding-inline:12px;cursor:pointer"
            >
              <input
                type="checkbox"
                name="isPrivate"
                value="on"
                checked={form.isPrivate}
                style="accent-color:var(--ink);inline-size:18px;block-size:18px"
              />
              <span>Approve members by hand</span>
            </label>
            <span class="field-hint">
              Left off, buying a package joins the community at once. Turned on, every member waits for
              you.
            </span>
          </div>

          <div style="margin-block-start:32px">
            <Button type="submit" variant="primary">
              Create the community
            </Button>
          </div>
        </form>
      </Section>
    </Layout>
  );
}

/** The whole `/host` page, from a form state. Shared by the GET and the 400 re-render. */
async function renderHost(
  c: PageContext,
  me: SessionUser,
  state: { flash: Flash | null; problems: string[]; errors: Errors; form: CommunityForm },
  status: 200 | 400,
): Promise<Response> {
  const rows = await listHostedCommunityRows(c.env, me.user.id);
  pageHeaders(c);
  return c.html(
    <HostPage
      user={{ name: me.user.name }}
      flash={state.flash}
      problems={state.problems}
      errors={state.errors}
      form={state.form}
      rows={rows}
    />,
    status,
  );
}

host.get("/host", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  const flash = await takeFlash(c.env, me.session);
  return renderHost(c, me, { flash, problems: [], errors: {}, form: EMPTY_COMMUNITY_FORM }, 200);
});

host.post("/host/communities", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  const body = await c.req.parseBody();
  const form: CommunityForm = {
    name: readField(body, "name"),
    tagline: readField(body, "tagline"),
    description: readField(body, "description"),
    city: readField(body, "city"),
    country: readField(body, "country"),
    category: readField(body, "category"),
    isPrivate: readFlag(body, "isPrivate"),
  };

  const errors: Errors = {};
  requireText(errors, "name", form.name, "A name", 120);
  requireText(errors, "tagline", form.tagline, "A tagline", 240);
  requireText(errors, "description", form.description, "A description", 4000);
  requireText(errors, "city", form.city, "A city", 120);
  requireText(errors, "country", form.country, "A country", 120);
  if (!(COMMUNITY_CATEGORIES as readonly string[]).includes(form.category)) {
    errors.category = `Pick one of: ${COMMUNITY_CATEGORIES.join(", ")}.`;
  }

  const problems = Object.values(errors);
  if (problems.length > 0) {
    return renderHost(c, me, { flash: null, problems, errors, form }, 400);
  }

  const slug = await freeSlug(c.env, form.name, "community", (candidate) =>
    communitySlugTaken(c.env, candidate),
  );

  const db = getDb(c.env);
  const communityId = newId();
  // Two tables, one all-or-nothing write: a community with no host row would be a
  // community its own host could not manage. `db.transaction()` throws here.
  await batch(c.env, [
    db.insert(communities).values({
      id: communityId,
      slug,
      name: form.name,
      tagline: form.tagline,
      description: form.description,
      city: form.city,
      country: form.country,
      category: form.category as CommunityCategory,
      hostUserId: me.user.id,
      isPrivate: form.isPrivate,
    }),
    db.insert(communityMembers).values({
      id: newId(),
      communityId,
      userId: me.user.id,
      role: "host",
      status: "approved",
    }),
  ]);

  return redirectWith(
    c,
    me.session,
    `${form.name} exists. Add a package and an event and it is open.`,
    `/host/communities/${slug}`,
  );
});

/* ------------------------------------------------------- /host/communities/:slug */

type EventForm = {
  title: string;
  summary: string;
  description: string;
  venue: string;
  city: string;
  startsAt: string;
  endsAt: string;
  capacity: string;
  status: string;
};

type PackageForm = { name: string; tickets: string; priceCents: string };

/** The form as it opens: this Saturday at 18:00, two hours, twelve places, published. */
function defaultEventForm(community: { city: string }, now: Date): EventForm {
  const startsAt = nextSaturdayEvening(now);
  const endsAt = new Date(startsAt.getTime() + DEFAULT_DURATION_HOURS * 3_600_000);
  return {
    title: "",
    summary: "",
    description: "",
    venue: "",
    city: community.city,
    startsAt: toLocalInput(startsAt),
    endsAt: toLocalInput(endsAt),
    capacity: DEFAULT_CAPACITY,
    // An invisible draft is the top host confusion, so publishing is the default.
    status: "published",
  };
}

const EMPTY_PACKAGE_FORM: PackageForm = { name: "", tickets: "", priceCents: "" };

type ManageData = {
  community: CommunityDetail;
  events: HostEvent[];
  attendees: Map<string, string[]>;
  roster: RosterEntry[];
  offers: PackageOffer[];
  revenue: RevenueLine[];
};

type ManageState = {
  flash: Flash | null;
  problems: string[];
  errors: Errors;
  eventForm: EventForm;
  packageForm: PackageForm;
};

function ManagePage(props: { user: { name: string }; data: ManageData; state: ManageState }) {
  const { user, data, state } = props;
  const { community, events: events, attendees, roster, offers, revenue } = data;
  const { flash, problems, errors, eventForm, packageForm } = state;

  const pending = roster.filter((entry) => entry.status === "pending");
  const approved = roster.filter((entry) => entry.status === "approved");

  return (
    <Layout
      title={`${community.name} · host`}
      description={`Back of house for ${community.name}.`}
      user={{ name: user.name }}
      active="host"
    >
      {problems.length > 0 ? <ErrorBanner problems={problems} /> : null}
      {flash !== null && problems.length === 0 ? <FlashBanner message={flash} /> : null}

      <Hero index="01" label="Manage" title={community.name}>
        <p class="meta">
          {community.city} · {community.category} · {community.isPrivate ? "By request" : "Open"} ·{" "}
          <a href={`/communities/${community.slug}`}>See it as a member does</a>
        </p>
      </Hero>

      <Section
        index="02"
        label="Events"
        title="What is on"
        action={{ href: "#new-event", label: "Add an event" }}
      >
        {events.length === 0 ? (
          <EmptyState
            title="No events yet."
            note="Members see published events only. The form below adds one."
            action={{ href: "#new-event", label: "Add an event" }}
          />
        ) : (
          <div class="bordered scroll-x" tabindex={0} data-events="">
            <table class="package-table" style={wide(46)}>
              <thead style={NOWRAP}>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Event</th>
                  <th scope="col">Standing</th>
                  <th scope="col">Fill</th>
                  <th scope="col">Coming</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => {
                  const names = attendees.get(event.id) ?? [];
                  const shown = names.slice(0, NAMES_SHOWN);
                  const hidden = names.length - shown.length;
                  return (
                    <tr>
                      <td class="num" style={NOWRAP}>
                        {formatDay(event.startsAt)}
                        <span class="package-derivation num">
                          {formatTime(event.startsAt)}–{formatTime(event.endsAt)}
                        </span>
                      </td>
                      <th scope="row">
                        <a href={`/events/${event.slug}`}>{event.title}</a>
                      </th>
                      <td>
                        {/* Status is uppercase micro text. Never a coloured chip (§5). */}
                        <span class="status">{event.status}</span>
                      </td>
                      <td class="num" style={NOWRAP}>
                        {event.confirmed} of {event.capacity}
                        <span class="package-derivation num">
                          {placesLeft(event.capacity, event.confirmed)} left
                        </span>
                      </td>
                      <td style="text-align:left">
                        {names.length === 0 ? (
                          <span class="meta">Nobody yet</span>
                        ) : (
                          <span class="meta">
                            {shown.join(", ")}
                            {hidden > 0 ? ` +${hidden}` : ""}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section index="03" label="Requests" title="Waiting on you" id="requests">
        {pending.length === 0 ? (
          <EmptyState
            title="Nobody is waiting."
            note={
              community.isPrivate
                ? "Requests to join land here, oldest first."
                : "This community is open, so buying a package joins it without asking you."
            }
          />
        ) : (
          <div class="bordered scroll-x" tabindex={0} data-requests="">
            <table class="package-table" style={wide(30)}>
              <thead style={NOWRAP}>
                <tr>
                  <th scope="col">Who</th>
                  <th scope="col">Asked</th>
                  <th scope="col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((entry) => (
                  <tr>
                    <th scope="row">
                      {entry.name}
                      <span class="package-derivation">{entry.headline ?? entry.city ?? ""}</span>
                    </th>
                    <td class="num" style={NOWRAP}>
                      {formatDay(entry.since)}
                    </td>
                    <td>
                      <form
                        method="post"
                        action={`/host/communities/${community.slug}/members/${entry.membershipId}/approve`}
                      >
                        <Button type="submit" variant="ghost">
                          Approve
                        </Button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* The count comes from the same SQL count the card and the community page
          print (§8), not from the length of the table below it. */}
      <Section index="04" label="Members" title={`${community.memberCount} in the community`}>
        <div class="bordered scroll-x" tabindex={0} data-members="">
          <table class="package-table" style={wide(40)}>
            <thead style={NOWRAP}>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">What they do</th>
                <th scope="col">City</th>
                <th scope="col">Since</th>
              </tr>
            </thead>
            <tbody>
              {approved.map((entry) => (
                <tr>
                  <th scope="row">
                    {entry.name}
                    {entry.role === "host" ? <span class="package-derivation">Host</span> : null}
                  </th>
                  <td>
                    <span class="meta">{entry.headline ?? ""}</span>
                  </td>
                  <td>
                    <span class="meta">{entry.city ?? ""}</span>
                  </td>
                  <td class="num" style={NOWRAP}>
                    {formatDay(entry.since)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        index="05"
        label="Packages"
        title="What the community sells"
        action={{ href: "#new-package", label: "Add a package" }}
      >
        {offers.length === 0 ? (
          <EmptyState
            title="No packages yet."
            note="Nobody can book until a package exists. One ticket takes one place."
            action={{ href: "#new-package", label: "Add a package" }}
          />
        ) : (
          <div class="bordered scroll-x" tabindex={0} data-packages="">
            <table class="package-table" style={wide(28)}>
              <thead style={NOWRAP}>
                <tr>
                  <th scope="col">Package</th>
                  <th scope="col">Tickets</th>
                  <th scope="col">Price</th>
                  <th scope="col">Each</th>
                </tr>
              </thead>
              <tbody>
                {offers.map((offer) => (
                  <tr>
                    <th scope="row">{offer.name}</th>
                    <td class="num" style={NOWRAP}>
                      {offer.tickets}
                    </td>
                    <td class="num" style={NOWRAP}>
                      {formatMoney(offer.priceCents, offer.currency)}
                    </td>
                    <td class="num" style={NOWRAP}>
                      {formatMoney(
                        Math.round(offer.priceCents / Math.max(1, offer.tickets)),
                        offer.currency,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section index="06" label="Money" title="Revenue to date">
        {revenue.length === 0 ? (
          <EmptyState title="Nothing sold yet." note="Packages bought by members are totalled here." />
        ) : (
          <div class="bordered scroll-x" tabindex={0} data-revenue="">
            <table class="package-table" style={wide(30)}>
              <thead style={NOWRAP}>
                <tr>
                  <th scope="col">Currency</th>
                  <th scope="col">Orders</th>
                  <th scope="col">Tickets sold</th>
                  <th scope="col">Taken</th>
                </tr>
              </thead>
              <tbody>
                {revenue.map((line) => (
                  <tr>
                    <th scope="row" class="num">
                      {line.currency}
                    </th>
                    <td class="num" style={NOWRAP}>
                      {line.orders}
                    </td>
                    <td class="num" style={NOWRAP}>
                      {line.tickets}
                    </td>
                    <td class="num package-price" style={NOWRAP}>
                      {formatMoney(line.cents, line.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section index="07" label="New" title="Add an event" id="new-event">
        <form
          class="column-420"
          method="post"
          action={`/host/communities/${community.slug}/events`}
          data-new-event=""
        >
          <Field
            label="Title"
            name="title"
            value={eventForm.title}
            required={true}
            error={errors.title}
          />
          <Field
            label="Summary"
            name="summary"
            value={eventForm.summary}
            required={true}
            error={errors.summary}
            hint="One or two sentences for the card."
          />
          <Field
            label="Description"
            name="description"
            value={eventForm.description}
            required={true}
            multiline={true}
            rows={5}
            error={errors.description}
          />
          <Field
            label="Venue"
            name="venue"
            value={eventForm.venue}
            required={true}
            error={errors.venue}
            hint="Where to stand on the day."
          />
          <Field
            label="City"
            name="city"
            value={eventForm.city}
            required={true}
            error={errors.city}
          />
          <Field
            label="Starts"
            name="startsAt"
            type="datetime-local"
            value={eventForm.startsAt}
            required={true}
            error={errors.startsAt}
          />
          <Field
            label="Ends"
            name="endsAt"
            type="datetime-local"
            value={eventForm.endsAt}
            required={true}
            error={errors.endsAt}
          />
          <Field
            label="Places"
            name="capacity"
            type="number"
            inputmode="numeric"
            value={eventForm.capacity}
            required={true}
            error={errors.capacity}
          />

          <div style="margin-block-start:24px">
            <fieldset
              aria-invalid={errors.status !== undefined ? "true" : undefined}
              aria-describedby={errors.status !== undefined ? "e-status" : undefined}
            >
              <legend class="field-label">
                Visibility<span class="field-req"> *</span>
              </legend>
              <div class="row" style="gap:8px 24px">
                <label
                  style="display:inline-flex;align-items:center;gap:8px;min-height:44px;cursor:pointer"
                >
                  <input
                    type="radio"
                    name="status"
                    value="published"
                    checked={eventForm.status !== "draft"}
                    style="accent-color:var(--ink);inline-size:18px;block-size:18px"
                  />
                  Publish now
                </label>
                <label
                  style="display:inline-flex;align-items:center;gap:8px;min-height:44px;cursor:pointer"
                >
                  <input
                    type="radio"
                    name="status"
                    value="draft"
                    checked={eventForm.status === "draft"}
                    style="accent-color:var(--ink);inline-size:18px;block-size:18px"
                  />
                  Keep as a draft
                </label>
              </div>
              {errors.status !== undefined ? (
                <span class="field-error" id="e-status">
                  {errors.status}
                </span>
              ) : null}
            </fieldset>
            <span class="field-hint">A draft is invisible to members until you publish it.</span>
          </div>

          <div style="margin-block-start:32px">
            <Button type="submit" variant="primary">
              Add the event
            </Button>
          </div>
        </form>
      </Section>

      <Section index="08" label="New" title="Add a package" id="new-package">
        <form
          class="column-420"
          method="post"
          action={`/host/communities/${community.slug}/packages`}
          data-new-package=""
        >
          <Field
            label="Package name"
            name="name"
            value={packageForm.name}
            required={true}
            error={errors.packageName}
            hint="Single, Trio and Season are the usual three."
          />
          <Field
            label="Tickets"
            name="tickets"
            type="number"
            inputmode="numeric"
            value={packageForm.tickets}
            required={true}
            error={errors.tickets}
            hint="One ticket takes one place at one event."
          />
          <Field
            label="Price in cents"
            name="priceCents"
            type="number"
            inputmode="numeric"
            value={packageForm.priceCents}
            required={true}
            error={errors.priceCents}
            hint={`Whole cents, ${currencyFor(community, offers)}. 36000 is 360.`}
          />
          <div style="margin-block-start:32px">
            <Button type="submit" variant="primary">
              Add the package
            </Button>
          </div>
        </form>
      </Section>
    </Layout>
  );
}

/** Everything the manage page reads, in two waves. */
async function loadManage(env: DatabaseEnv, community: CommunityDetail): Promise<ManageData> {
  const [events, attendees, roster, offers, revenue] = await Promise.all([
    listHostEvents(env, community.id),
    attendeesByEvent(env, community.id),
    listRoster(env, community.id),
    listPackages(env, community.id),
    revenueToDate(env, community.id),
  ]);
  return { community, events: events, attendees, roster, offers, revenue };
}

async function renderManage(
  c: PageContext,
  me: SessionUser,
  community: CommunityDetail,
  state: ManageState,
  status: 200 | 400,
): Promise<Response> {
  const data = await loadManage(c.env, community);
  pageHeaders(c);
  return c.html(<ManagePage user={{ name: me.user.name }} data={data} state={state} />, status);
}

/**
 * The community in the URL, plus the guard: missing is 404, someone else's is 403.
 * The host id comes back with the community, so the check costs no extra query.
 */
async function requireHostedCommunity(
  c: PageContext,
  me: SessionUser,
): Promise<CommunityDetail | Response> {
  const found = await getCommunityBySlug(c.env, c.req.param("slug") ?? "");
  if (!found) return notFoundPage(c, me);
  if (found.host.id !== me.user.id) return forbiddenPage(c, me, found.community);
  return found.community;
}

host.get("/host/communities/:slug", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  const community = await requireHostedCommunity(c, me);
  if (community instanceof Response) return community;

  const flash = await takeFlash(c.env, me.session);
  return renderManage(
    c,
    me,
    community,
    {
      flash,
      problems: [],
      errors: {},
      eventForm: defaultEventForm(community, new Date()),
      packageForm: EMPTY_PACKAGE_FORM,
    },
    200,
  );
});

host.post("/host/communities/:slug/events", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  // Authorisation before input: a stranger never gets to probe the validation.
  const community = await requireHostedCommunity(c, me);
  if (community instanceof Response) return community;

  const body = await c.req.parseBody();
  const form: EventForm = {
    title: readField(body, "title"),
    summary: readField(body, "summary"),
    description: readField(body, "description"),
    venue: readField(body, "venue"),
    city: readField(body, "city"),
    startsAt: readField(body, "startsAt"),
    endsAt: readField(body, "endsAt"),
    capacity: readField(body, "capacity"),
    status: readField(body, "status"),
  };

  const errors: Errors = {};
  requireText(errors, "title", form.title, "A title", 200);
  requireText(errors, "summary", form.summary, "A summary", 400);
  requireText(errors, "description", form.description, "A description", 4000);
  requireText(errors, "venue", form.venue, "A venue", 200);
  requireText(errors, "city", form.city, "A city", 120);
  const startsAt = readDateTime(errors, "startsAt", form.startsAt, "A start");
  const endsAt = readDateTime(errors, "endsAt", form.endsAt, "An end");
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
    errors.endsAt = "The end has to be after the start.";
  }
  const capacity = readNumber(errors, "capacity", form.capacity, "Places", 1, 500);
  if (form.status !== "published" && form.status !== "draft") {
    errors.status = "Pick publish now, or keep it as a draft.";
  }

  const problems = Object.values(errors);
  if (problems.length > 0 || !startsAt || !endsAt || capacity === null) {
    return renderManage(
      c,
      me,
      community,
      {
        flash: null,
        problems,
        errors,
        eventForm: form,
        packageForm: EMPTY_PACKAGE_FORM,
      },
      400,
    );
  }

  const slug = await freeSlug(c.env, form.title, "event", (candidate) =>
    eventSlugTaken(c.env, candidate),
  );

  const db = getDb(c.env);
  await db.insert(events).values({
    id: newId(),
    communityId: community.id,
    slug,
    title: form.title,
    summary: form.summary,
    description: form.description,
    venue: form.venue,
    city: form.city,
    startsAt,
    endsAt,
    capacity,
    status: form.status === "draft" ? "draft" : "published",
  });

  const when = formatDateRange(startsAt, endsAt);
  return redirectWith(
    c,
    me.session,
    form.status === "draft"
      ? `${form.title} is saved as a draft, so members cannot see it yet. ${when}.`
      : `${form.title} is published. ${when}, ${capacity} places.`,
    `/host/communities/${community.slug}`,
  );
});

host.post("/host/communities/:slug/packages", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  const community = await requireHostedCommunity(c, me);
  if (community instanceof Response) return community;

  const body = await c.req.parseBody();
  const form: PackageForm = {
    name: readField(body, "name"),
    tickets: readField(body, "tickets"),
    priceCents: readField(body, "priceCents"),
  };

  const errors: Errors = {};
  // Keyed `packageName` so it cannot collide with the event form's `title`
  // or with a community's `name` in the shared error map.
  if (form.name === "") errors.packageName = "The package needs a name.";
  else if (form.name.length > 80) errors.packageName = "The package name is longer than 80 characters.";
  const tickets = readNumber(errors, "tickets", form.tickets, "Tickets", 1, 100);
  const priceCents = readNumber(errors, "priceCents", form.priceCents, "The price in cents", 0, 100_000_000);

  const problems = Object.values(errors);
  if (problems.length > 0 || tickets === null || priceCents === null) {
    return renderManage(
      c,
      me,
      community,
      {
        flash: null,
        problems,
        errors,
        eventForm: defaultEventForm(community, new Date()),
        packageForm: form,
      },
      400,
    );
  }

  const existing = await listPackages(c.env, community.id);
  const currency = currencyFor(community, existing);
  const db = getDb(c.env);
  await db.insert(packages).values({
    id: newId(),
    communityId: community.id,
    name: form.name,
    tickets,
    priceCents,
    currency,
    sortOrder: existing.length,
  });

  return redirectWith(
    c,
    me.session,
    `${form.name} is on sale. ${tickets} ${tickets === 1 ? "ticket" : "tickets"} for ${formatMoney(priceCents, currency)}.`,
    `/host/communities/${community.slug}`,
  );
});

host.post("/host/communities/:slug/members/:memberId/approve", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  const community = await requireHostedCommunity(c, me);
  if (community instanceof Response) return community;

  const db = getDb(c.env);
  // Scoped to this community in the WHERE, so a membership id from somewhere else
  // updates nothing rather than being approved into the wrong community.
  const [approved] = await db
    .update(communityMembers)
    .set({ status: "approved" })
    .where(
      and(eq(communityMembers.id, c.req.param("memberId")), eq(communityMembers.communityId, community.id)),
    )
    .returning({ userId: communityMembers.userId });

  if (!approved) return c.json({ error: "Member not found" }, 404);

  const [member] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, approved.userId))
    .limit(1);

  return redirectWith(
    c,
    me.session,
    `${member?.name ?? "That member"} is in. They can buy a package and book from now on.`,
    `/host/communities/${community.slug}`,
  );
});

export default host;
