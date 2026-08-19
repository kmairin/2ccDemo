/**
 * The public surface — `src/routes/pages.tsx`, mounted at `/`:
 *
 *   app.route("/", pages);
 *
 * so the paths declared here are the contract's URLs
 * (`design/reference/api-contract.md`). Seven pages and three mutations: the
 * landing, the directory, one community, the ledger of events, one event,
 * the calendar, the join form, and sign in / sign out / join a community.
 *
 * Handlers stay thin (AGENTS.md §8): validate what crossed the network, call a
 * service in `src/services/`, hand the rows to a component. Nothing here writes
 * SQL except the one membership insert, which has no service to call.
 *
 * Three rules from `design/reference/design-decisions.md` shape every handler:
 *
 *   - `Cache-Control: private, no-cache` on every GET, never `no-store` — the
 *     latter disables bfcache and makes Back a cold load at each step (§10.4).
 *   - The flash comes off the session and is the first thing inside `<main>`,
 *     above the `<h1>`, `role="status"`, with no dismiss control (§10.4).
 *   - One `<h1>` per page = the subject; card titles are `<h3>` under a
 *     section's `<h2>` (§10.4).
 */

import { inArray } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import {
  currentUser,
  findUserByEmail,
  flashMessage,
  setFlash,
  setSessionCookie,
  signIn,
  signOut,
  takeFlash,
  type AuthEnv,
  type Flash,
  type SessionUser,
} from "../auth";
import { getDb } from "../db";
import { plural, placeLabel, formatDateRange, formatDay, formatMoney, formatTime } from "../lib/format";
import { newId } from "../lib/ids";
import {
  COMMUNITY_CATEGORIES,
  communityMembers,
  users,
  type CommunityCategory,
  type MembershipStatus,
} from "../schema";
import {
  getCommunityBySlug,
  getCity,
  getCountry,
  isCommunityHost,
  listCommunityPhotos,
  listCommunities,
  listCities,
  listCountries,
  searchCommunities,
  type CitySummary,
  type CountrySummary,
} from "../services/communities";
import { SEARCH_MAX_LENGTH, utcDateKey } from "../services/common";
import {
  listBookingsForUser,
  listPackages,
  listPackagesForUser,
  type PackageOffer,
} from "../services/commerce";
import {
  currentMonthKey,
  getEventBySlug,
  listCalendarMonth,
  listEventPhotos,
  listEvents,
  listEventsForCommunity,
  parseMonth,
  searchEvents,
  type CalendarDay as CalendarSource,
  type EventSummary,
} from "../services/events";
import { getMembership, listApprovedMembers, listEventAttendees } from "../services/members";
import { balanceOptionFor } from "./wallet";
import { ActionArea, ActionBar, PackageTable, type ActionState, type PackageChoice } from "../ui/booking";
import { CalendarMonth, Ledger, type CalendarDay, type LedgerGroup } from "../ui/calendar";
import {
  Alert,
  Button,
  CardGrid,
  CommunityCard,
  Container,
  EmptyState,
  EventCard,
  Field,
  FilterRow,
  Hero,
  Plate,
  Section,
  type FilterOption,
} from "../ui/components";
import { Gallery, type GalleryItem } from "../ui/gallery";
import { Layout, type LayoutUser } from "../ui/layout";
import { AttendeeList, MemberList, type PersonEntry } from "../ui/people";
import { initials } from "../ui/plate";

const pages = new Hono<{ Bindings: AuthEnv }>();

type PageContext = Context<{ Bindings: AuthEnv }>;

/* ------------------------------------------------------------- plumbing */

/**
 * `private, no-cache` on every GET page (§10.4). Not `no-store`: that disables
 * bfcache, and Back becomes a cold load at every step of the funnel.
 */
function pageHeaders(c: PageContext): void {
  c.header("Cache-Control", "private, no-cache");
}

/**
 * A `next` we are willing to 302 to: a path on this site and nothing else.
 * `//evil.example` is a protocol-relative URL, so the second character matters
 * as much as the first.
 */
function safeNext(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith("/")) return undefined;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return undefined;
  return raw;
}

/** Read the flash off the session and clear it, so a reload cannot re-announce it. */
async function readFlash(c: PageContext, me: SessionUser | null): Promise<Flash | null> {
  if (!me) return null;
  return takeFlash(c.env, me.session);
}

/** The header has room for one word, and so does "Your request is with …". */
function firstName(name: string): string {
  const trimmed = name.trim();
  return trimmed === "" ? "the host" : trimmed.split(/\s+/)[0];
}

function layoutUser(me: SessionUser | null): LayoutUser {
  return me ? { name: me.user.name } : null;
}

/**
 * The real screen-reader announcement of a result is the `<title>` (§10.4):
 * `Booked — Sunrise Padel · 2CC`. The flash's first sentence is that lead.
 */
function pageTitle(subject: string, flash: Flash | null): string {
  if (flash === null) return subject;
  const lead = flash.message.split(".")[0].trim();
  return lead === "" ? subject : `${lead} — ${subject}`;
}

/** First child of `<main>`, above the `<h1>`, no auto-dismiss, no dismiss control. */
function FlashBanner(props: { flash: Flash | null }) {
  if (props.flash === null) return null;
  // A refusal must not render in the same band as a confirmation.
  const warn = props.flash.tone === "warn";
  return (
    <Container>
      <div style="padding-block-start:var(--s5)">
        <Alert tone={warn ? "warn" : "brass"} confirm={!warn}>
          {props.flash.message}
        </Alert>
      </div>
    </Container>
  );
}

/**
 * Month names. `src/lib/format.ts` owns every other date string in the product
 * and is not this worker's file; it has no month-name formatter, and the ledger
 * headers and the calendar both need one. Same rules as that file: `Intl`
 * parts, UTC, one fixed locale — never a hand-written month table.
 */
const MONTH_LONG = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "long",
  year: "numeric",
});
const MONTH_SHORT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" });

/** `August 2026`. */
function monthTitle(year: number, month: number): string {
  return MONTH_LONG.format(new Date(Date.UTC(year, month - 1, 1)));
}

/**
 * `formatDay` renders `Sat 23 Aug`. The ledger wants the weekday and day on one
 * line and the month on the next, so its output is split rather than the date
 * being formatted a second way here.
 */
function splitDay(d: Date): { dayLabel: string; monthLabel: string; weekday: string } {
  const parts = formatDay(d).split(" ");
  return {
    dayLabel: `${parts[0]} ${parts[1]}`,
    monthLabel: parts[2] ?? "",
    weekday: parts[0] ?? "",
  };
}

/** Events that have not started yet, in the order the service returned them. */
function upcoming(events: EventSummary[], now: Date): EventSummary[] {
  return events.filter((e) => new Date(e.startsAt).getTime() >= now.getTime());
}

/** `€180` and the derivation `3 events · €60 each`. Never "from" (§6). */
function toPackageChoices(communitySlug: string, offers: PackageOffer[], next?: string): PackageChoice[] {
  const query = next === undefined ? "" : `?next=${encodeURIComponent(next)}`;
  return offers.map((p) => ({
    id: p.id,
    name: p.name,
    tickets: p.tickets,
    price: formatMoney(p.priceCents, p.currency),
    derivation:
      p.tickets === 1
        ? "1 event"
        : `${p.tickets} events · ${formatMoney(Math.round(p.priceCents / p.tickets), p.currency)} each`,
    href: `/communities/${communitySlug}/packages/${p.id}/checkout${query}`,
  }));
}

function toGalleryItems(
  photos: { caption: string; seed: string; objectKey: string | null }[],
): GalleryItem[] {
  return photos.map((p) => ({ caption: p.caption, seed: p.seed, objectKey: p.objectKey }));
}

function toPerson(p: {
  userId?: string;
  name: string;
  headline: string | null;
  city?: string | null;
}): PersonEntry {
  // Carry the id through: without it every member and attendee rendered as
  // plain text and no profile page was reachable from anywhere in the product.
  return {
    id: p.userId,
    name: p.name,
    headline: p.headline ?? "Member",
    city: p.city ?? undefined,
  };
}

/** A styled 404 — never a stack trace, never the JSON handler (§8). */
function notFoundPage(
  c: PageContext,
  me: SessionUser | null,
  subject: string,
  note: string,
): Response | Promise<Response> {
  pageHeaders(c);
  return c.html(
    <Layout title={subject} user={layoutUser(me)}>
      <Hero index="00" label="Not found" title={subject} lede={note} />
      <Section index={1} label="Elsewhere" title="Where to go instead">
        <div class="row">
          <Button href="/communities" variant="ghost">
            The communities
          </Button>
          <Button href="/events" variant="ghost">
            Every event
          </Button>
        </div>
      </Section>
    </Layout>,
    404,
  );
}

/* ------------------------------------------------------------- landing */

pages.get("/", async (c) => {
  const me = await currentUser(c);
  const flash = await readFlash(c, me);
  const [communities, events] = await Promise.all([listCommunities(c.env), listEvents(c.env)]);
  const next = upcoming(events, new Date()).slice(0, 4);

  pageHeaders(c);
  return c.html(
    <Layout
      title={pageTitle("Communities and events worldwide", flash)}
      description="Communities that meet on a date, at an address, with a limit on how many people can come."
      user={layoutUser(me)}
    >
      <FlashBanner flash={flash} />

      {/* §5: one sentence at --t-hero in the left 8 columns, then the subline
          that defines all four nouns in one breath. */}
      <Hero
        scale="hero"
        title="Every event here has a date, an address, and a limit on how many people can come."
        lede="A community is a standing group with a host and a place. An event is one dated meeting of it. A package buys 1, 3 or 6 tickets for one community, and one ticket takes one place."
      />

      {/* The date and the places left are what a traveller wants, so the
          events sit above the communities. */}
      <Section
        index={1}
        label="Next"
        title="The next events"
        action={{ href: "/events", label: "Every event" }}
      >
        {next.length === 0 ? (
          <EmptyState
            title="No events scheduled."
            note="Hosts post their dates a season ahead. The calendar keeps the months either side."
            action={{ href: "/calendar", label: "Open the calendar" }}
          />
        ) : (
          <CardGrid wide={true}>
            {next.map((e) => (
              <EventCard
                slug={e.slug} coverKey={e.coverKey}
                title={e.title}
                communityName={e.community.name}
                city={e.city}
                venue={e.venue}
                when={formatDateRange(new Date(e.startsAt), new Date(e.endsAt))}
                placesLeft={e.placesLeft}
              />
            ))}
          </CardGrid>
        )}
      </Section>

      <Section
        index={2}
        label="Communities"
        title="The communities"
        action={{ href: "/communities", label: "The directory" }}
      >
        <CardGrid>
          {communities.map((community) => (
            <CommunityCard
              slug={community.slug} coverKey={community.coverKey}
              name={community.name}
              tagline={community.tagline}
              city={community.city}
              category={community.category}
              memberCount={community.memberCount}
              isPrivate={community.isPrivate}
            />
          ))}
        </CardGrid>
      </Section>

      <Section index={3} label="How it works" title="What an event is">
        <div class="prose">
          <p>
            An event is not an idea. It is a date, a street address, a start time in real
            minutes, and a number of chairs that runs out.
          </p>
          <p>
            Someone has already cut the ice, booked the boat or lit the fire. The host writes the
            constraint into the listing — no phones, eight seats, back by two — and everyone who
            takes a place has read it.
          </p>
          <p>
            That is what keeps an event small enough to be real. You are not an audience. You are
            one of the twelve.
          </p>
        </div>
      </Section>
    </Layout>,
  );
});

/* ------------------------------------------------------------- communities */

/**
 * Micro-caps hairline row, active marked by a 1px brass underline. Never pills
 * (§5). `place` is carried through every link, so choosing a category keeps
 * the country and city the reader already picked.
 */
function categoryFilters(active: string | undefined, place: PlaceQuery = {}): FilterOption[] {
  const options: FilterOption[] = [
    { label: "All", href: withFilters("/communities", place, { category: undefined }), current: active === undefined },
  ];
  for (const category of COMMUNITY_CATEGORIES) {
    options.push({
      label: category,
      href: withFilters("/communities", place, { category }),
      current: active === category,
    });
  }
  return options;
}

/**
 * The country and city rows a directory page carries above its results.
 *
 * Both are built from the data (see `listCities`/`listCountries`) — there is no
 * list of places in this file, so a community added in a new country puts that
 * country in the row on the next request. Picking a country narrows the city
 * row to that country's cities, which is the drill-down the product is built
 * around.
 *
 * `count` is what the reader is looking at: communities on `/communities`,
 * events coming up on `/events`. A place with none of the thing this page
 * lists is left out rather than shown as a zero.
 */
function placeRows(
  base: string,
  place: PlaceQuery,
  countries: CountrySummary[],
  cities: CitySummary[],
  counting: "communities" | "events",
): { countries: PlaceOption[]; cities: PlaceOption[] } {
  const countOf = (row: { communityCount: number; eventCount: number }): number =>
    counting === "communities" ? row.communityCount : row.eventCount;

  const countryOptions: PlaceOption[] = [
    {
      label: "All",
      href: withFilters(base, place, { country: undefined, city: undefined }),
      count: countries.reduce((n, row) => n + countOf(row), 0),
      current: place.country === undefined,
    },
  ];
  for (const row of countries) {
    if (countOf(row) === 0) continue;
    countryOptions.push({
      label: row.country,
      // A city belongs to one country, so switching country clears the city.
      href: withFilters(base, place, { country: row.country, city: undefined }),
      count: countOf(row),
      current: place.country?.toLowerCase() === row.country.toLowerCase(),
    });
  }

  const cityOptions: PlaceOption[] = [
    {
      label: "All",
      href: withFilters(base, place, { city: undefined }),
      count: cities.reduce((n, row) => n + countOf(row), 0),
      current: place.city === undefined,
    },
  ];
  for (const row of cities) {
    if (countOf(row) === 0) continue;
    cityOptions.push({
      label: row.city,
      href: withFilters(base, place, { city: row.city }),
      count: countOf(row),
      current: place.city?.toLowerCase() === row.city.toLowerCase(),
    });
  }

  return { countries: countryOptions, cities: cityOptions };
}

/** One labelled hairline row. Three of them stack without becoming a wall. */
function FilterGroup(props: { legend: string; children?: Child }) {
  return (
    <div class="filter-group">
      <p class="micro filter-legend">{props.legend}</p>
      {props.children}
    </div>
  );
}

pages.get("/communities", async (c) => {
  const me = await currentUser(c);
  const flash = await readFlash(c, me);
  const raw = c.req.query("category");

  // An unknown category is a typo in the URL, not an empty directory (§8).
  if (raw !== undefined && raw !== "" && !(COMMUNITY_CATEGORIES as readonly string[]).includes(raw)) {
    pageHeaders(c);
    return c.html(
      <Layout bodyClass="page-index" title="Communities" user={layoutUser(me)} active="communities">
        <Container>
          <div style="padding-block-start:var(--s5)">
            <Alert tone="warn">
              {`There is no "${raw}" category. The five are: ${COMMUNITY_CATEGORIES.join(", ")}.`}
            </Alert>
          </div>
        </Container>
        <Hero
          index="01"
          label="Directory"
          title="Communities"
          lede="Each community is run by one person, meets in one city, and holds a fixed number of members."
        />
        <Section index={2} label="Category" title="Pick one of the five">
          <FilterRow label="Category" options={categoryFilters(undefined)} />
        </Section>
      </Layout>,
      400,
    );
  }

  const category = raw === undefined || raw === "" ? undefined : (raw as CommunityCategory);
  // Places come from the data, so an unknown one cannot be told from a typo.
  // It is an empty result with a way out, never a 404 and never a 400.
  const place = readPlace(c, { category });
  const now = new Date();
  const [communities, allCountries, cities] = await Promise.all([
    listCommunities(c.env, { category, city: place.city, country: place.country }),
    listCountries(c.env, { now }),
    listCities(c.env, { country: place.country, now }),
  ]);
  const rows = placeRows("/communities", place, allCountries, cities, "communities");
  const where = place.city ?? place.country;

  pageHeaders(c);
  return c.html(
    <Layout bodyClass="page-index"
      title={pageTitle(where === undefined ? "Communities" : `Communities in ${where}`, flash)}
      description="Every community, by country, city and category. One host, one city, a fixed number of members."
      user={layoutUser(me)}
      active="communities"
    >
      <FlashBanner flash={flash} />
      <Hero
        index="01"
        label="Directory"
        title="Communities"
        lede="Each community is run by one person, meets in one city, and holds a fixed number of members."
      />
      <Section index={2} label="Search" title="Find one">
        <SearchField hint="A country, a city, a community or an event." />
      </Section>
      <Section
        index={3}
        label={place.country === undefined && place.city === undefined ? "Category" : "Where"}
        title={directoryHeading(category, place, "community", "communities")}
      >
        <div class="filter-stack">
          <FilterGroup legend="Country">
            <PlaceRow label="Country" noun="community" options={rows.countries} />
          </FilterGroup>
          <FilterGroup legend="City">
            <PlaceRow label="City" noun="community" options={rows.cities} />
          </FilterGroup>
          <FilterGroup legend="Category">
            <FilterRow label="Category" options={categoryFilters(category, place)} />
          </FilterGroup>
        </div>
        {communities.length === 0 ? (
          <EmptyState
            title={
              where === undefined
                ? "No communities in this category yet."
                : `No communities in ${where} yet.`
            }
            note={
              where === undefined
                ? "The other categories all have communities taking members."
                : "The rows above list every country and city that has one. The country index has the whole map."
            }
            action={
              where === undefined
                ? { href: "/communities", label: "Every community" }
                : { href: "/countries", label: "The country index" }
            }
          />
        ) : (
          <CardGrid>
            {communities.map((community) => (
              <CommunityCard
                slug={community.slug} coverKey={community.coverKey}
                name={community.name}
                tagline={community.tagline}
                city={community.city}
                category={community.category}
                memberCount={community.memberCount}
                isPrivate={community.isPrivate}
              />
            ))}
          </CardGrid>
        )}
      </Section>
    </Layout>,
  );
});

/* --------------------------------------------------------------- community */

type MembershipPanelProps = {
  slug: string;
  isPrivate: boolean;
  signedIn: boolean;
  status: MembershipStatus | null;
  hostFirstName: string;
  dateCount: number;
};

/** Join / request-to-join, in the one state this member is actually in. */
function MembershipPanel(props: MembershipPanelProps) {
  const { slug, isPrivate, signedIn, status, hostFirstName, dateCount } = props;

  if (!signedIn) {
    return (
      <div class="action">
        <p class="micro">Membership</p>
        <Button
          href={`/join?next=${encodeURIComponent(`/communities/${slug}`)}`}
          variant="primary"
          block={true}
        >
          Sign in to join
        </Button>
        <p class="action-help">Email and name. No password.</p>
      </div>
    );
  }

  if (status === "approved") {
    return (
      <div class="action">
        <p class="micro">Membership</p>
        <p class="action-line">You are in this community.</p>
        <Button href="#events" variant="ghost" block={true}>
          {dateCount === 0 ? "No dates yet" : dateCount === 1 ? "The one date" : `The ${dateCount} dates`}
        </Button>
        <p class="action-help">
          A place costs 1 ticket. The packages are below, and your tickets are on{" "}
          <a href="/account">your account</a>.
        </p>
      </div>
    );
  }

  if (status === "pending") {
    return (
      <div class="action">
        <p class="micro">Membership</p>
        <p class="action-line">Your request is waiting.</p>
        <p class="action-help">
          {hostFirstName} approves members by hand. Meanwhile:{" "}
          <a href="/events">other events</a>.
        </p>
      </div>
    );
  }

  return (
    <div class="action">
      <p class="micro">Membership</p>
      <form method="post" action={`/communities/${slug}/join`}>
        <input type="hidden" name="next" value={`/communities/${slug}`} />
        <Button type="submit" variant="primary" block={true}>
          {isPrivate ? "Ask the host to join" : "Join the community"}
        </Button>
      </form>
      <p class="action-help">
        {isPrivate
          ? "This community approves members by hand."
          : "Public community. You are in as soon as you ask."}
      </p>
    </div>
  );
}

pages.get("/communities/:slug", async (c) => {
  const me = await currentUser(c);
  const slug = c.req.param("slug");
  const found = await getCommunityBySlug(c.env, slug);
  if (!found) {
    return notFoundPage(
      c,
      me,
      "No such community",
      `Nothing here answers to "${slug}". The directory lists every community there is.`,
    );
  }
  const { community, host } = found;
  const flash = await readFlash(c, me);

  const [packages, events, members, photos, membership] = await Promise.all([
    listPackages(c.env, community.id),
    listEventsForCommunity(c.env, community.id),
    listApprovedMembers(c.env, community.id),
    listCommunityPhotos(c.env, community.id),
    me ? getMembership(c.env, community.id, me.user.id) : Promise.resolve(null),
  ]);

  const nextDates = upcoming(events, new Date());
  const hostMember = members.find((m) => m.role === "host");
  const otherMembers = members.filter((m) => m.role !== "host");
  const status = membership?.status ?? null;
  const hostFirst = firstName(host.name);

  const barAction: Child =
    me === null ? (
      <Button href={`/join?next=${encodeURIComponent(`/communities/${community.slug}`)}`} variant="ghost">
        Sign in
      </Button>
    ) : status === "approved" ? (
      <Button href="#events" variant="ghost">
        The dates
      </Button>
    ) : status === "pending" ? (
      <Button href="/events" variant="ghost">
        Other events
      </Button>
    ) : (
      <form method="post" action={`/communities/${community.slug}/join`}>
        <input type="hidden" name="next" value={`/communities/${community.slug}`} />
        <Button type="submit" variant="ghost">
          {community.isPrivate ? "Request" : "Join"}
        </Button>
      </form>
    );

  pageHeaders(c);
  return c.html(
    <Layout
      title={pageTitle(community.name, flash)}
      description={community.tagline}
      user={layoutUser(me)}
      active="communities"
      actionBar={
        <ActionBar
          title={community.name}
          note={`${plural(community.memberCount, "member", "members")} · ${plural(nextDates.length, "date", "dates")}`}
        >
          {barAction}
        </ActionBar>
      }
    >
      <FlashBanner flash={flash} />

      {/* §5: full-bleed cover, the name overlapping its lower edge. The
          photograph leads; the plate is what a community without one falls back
          to (§11). */}
      <section class="section">
        <Container>
          <div class="grid--bleed">
            <Plate
              seed={community.slug}
              category={community.category}
              monogram={initials(community.name)}
              shape="hero"
              density="hero"
              objectKey={community.coverKey}
              alt={community.name}
            />
          </div>
          <div class="eight">
            <h1 class="h-page" style="margin-top:-.4em;position:relative">
              {community.name}
            </h1>
            <p class="lede">{community.tagline}</p>
            <p class="meta" style="margin-block-start:var(--s4)">
              <span class="micro micro--brass">{community.category}</span>{" · "}
              {placeLabel(community.city, community.country)} · <span class="num">{community.memberCount}</span> members ·{" "}
              <span class="num">{community.eventCount}</span> events
              {community.isPrivate ? " · by request" : ""}
            </p>
          </div>
        </Container>
      </section>

      <Section index={1} label="Story" title="What this community is">
        <div class="row" style="align-items:flex-start;gap:var(--s7)">
          <div style="flex:9999 1 540px">
            <div class="prose">
              <p>{community.description}</p>
            </div>
            <div class="row" style="margin-block-start:var(--s6);align-items:flex-start">
              <span class="avatar" aria-hidden="true">
                {initials(host.name)}
              </span>
              <div>
                <p class="person-name">
                  {host.name} <span class="status status--brass">Host</span>
                </p>
                <p class="person-line">{host.headline ?? "Runs this community."}</p>
                <p class="person-line">{host.city ?? community.city}</p>
              </div>
            </div>
          </div>
          <div class="action-sidebar bordered" style="flex:1 1 280px;padding:var(--s5)">
            <MembershipPanel
              slug={community.slug}
              isPrivate={community.isPrivate}
              signedIn={me !== null}
              status={status}
              hostFirstName={hostFirst}
              dateCount={nextDates.length}
            />
          </div>
        </div>
      </Section>

      <Section
        index={2}
        label="Events"
        title="What is coming up"
        id="events"
        action={{ href: "/events", label: "Every event" }}
      >
        {nextDates.length === 0 ? (
          <EmptyState
            title="No events scheduled."
            note={`${hostFirst} posts new dates here first. The other communities are running now.`}
            action={{ href: "/events", label: "Events elsewhere" }}
          />
        ) : (
          <CardGrid wide={true}>
            {nextDates.map((e) => (
              <EventCard
                slug={e.slug} coverKey={e.coverKey}
                title={e.title}
                communityName={community.name}
                city={e.city}
                venue={e.venue}
                when={formatDateRange(new Date(e.startsAt), new Date(e.endsAt))}
                placesLeft={e.placesLeft}
                category={community.category}
              />
            ))}
          </CardGrid>
        )}
      </Section>

      <Section index={3} label="Packages" title="How a place is bought">
        <PackageTable
          packages={toPackageChoices(community.slug, packages)}
          caption={`Packages for ${community.name}`}
        />
        <p class="meta" style="margin-block-start:var(--s4)">
          One ticket takes one place at one event. Cancel the place and the ticket comes back.
        </p>
      </Section>

      <Section index={4} label="Archive" title="From the log">
        <div data-gallery="">
          {photos.length === 0 ? (
            <EmptyState
              title="No plates in the archive yet."
              note={`${hostFirst} adds them after each event.`}
            />
          ) : (
            <Gallery
              label={`${community.name}, archive`}
              category={community.category}
              items={toGalleryItems(photos)}
            />
          )}
        </div>
      </Section>

      <Section index={5} label="Members" title="Who is in this community">
        <div data-members="">
          <MemberList
            members={otherMembers.map(toPerson)}
            total={community.memberCount}
            host={
              hostMember
                ? toPerson(hostMember)
                : toPerson({ name: host.name, headline: host.headline, city: host.city })
            }
          />
        </div>
      </Section>
    </Layout>,
  );
});

/* ------------------------------------------------------------ events */

/** Soonest first, grouped under the month they fall in (§5). */
function toLedgerGroups(events: EventSummary[]): LedgerGroup[] {
  const groups: LedgerGroup[] = [];
  for (const e of events) {
    const start = new Date(e.startsAt);
    const month = monthTitle(start.getUTCFullYear(), start.getUTCMonth() + 1);
    const { dayLabel, monthLabel } = splitDay(start);
    let group = groups[groups.length - 1];
    if (group === undefined || group.month !== month) {
      group = { month, entries: [] };
      groups.push(group);
    }
    group.entries.push({
      slug: e.slug,
      title: e.title,
      communityName: e.community.name,
      venue: e.venue,
      city: e.city,
      dayLabel,
      monthLabel,
      timeLabel: formatTime(start),
      placesLeft: e.placesLeft,
      coverKey: e.coverKey,
    });
  }
  return groups;
}

pages.get("/events", async (c) => {
  const me = await currentUser(c);
  const flash = await readFlash(c, me);
  const place = readPlace(c);
  const now = new Date();

  // `from` is applied in SQL rather than after the fact, so the LIMIT is spent
  // on dates that are still to come and the counts in the rows above equal the
  // rows printed below them.
  const [rows, allCountries, cities] = await Promise.all([
    listEvents(c.env, { city: place.city, country: place.country, from: now }),
    listCountries(c.env, { now }),
    listCities(c.env, { country: place.country, now }),
  ]);
  const filters = placeRows("/events", place, allCountries, cities, "events");
  const where = place.city ?? place.country;

  pageHeaders(c);
  return c.html(
    <Layout bodyClass="page-index"
      title={pageTitle(where === undefined ? "Events" : `Events in ${where}`, flash)}
      description="Every published event, soonest first, with the places left on each."
      user={layoutUser(me)}
      active="events"
    >
      <FlashBanner flash={flash} />
      <Hero
        index="01"
        label="Events"
        title="Events"
        lede="Every published event, soonest first. The number on the right is how many places are left."
      />
      <Section index={2} label="Search" title="Find one">
        <SearchField hint="A country, a city, a community or an event." />
      </Section>
      <Section
        index={3}
        label="Where"
        title={directoryHeading(undefined, place, "date", "dates")}
        action={{ href: "/calendar", label: "By month" }}
      >
        <div class="filter-stack">
          <FilterGroup legend="Country">
            <PlaceRow label="Country" noun="event" options={filters.countries} />
          </FilterGroup>
          <FilterGroup legend="City">
            <PlaceRow label="City" noun="event" options={filters.cities} />
          </FilterGroup>
        </div>
        {rows.length === 0 ? (
          <EmptyState
            title={
              where === undefined
                ? "No events scheduled."
                : `No events in ${where} yet.`
            }
            note={
              where === undefined
                ? "Hosts post a season at a time. The communities list who is running what."
                : "The rows above list every country and city with a date coming up. The country index has the whole map."
            }
            action={
              where === undefined
                ? { href: "/communities", label: "The communities" }
                : { href: "/countries", label: "The country index" }
            }
          />
        ) : (
          <Ledger groups={toLedgerGroups(rows)} />
        )}
      </Section>
    </Layout>,
  );
});

/* ------------------------------------------------------------- event */

type ActionInput = {
  signedIn: boolean;
  isPrivate: boolean;
  placesLeft: number;
  status: MembershipStatus | null;
  ticketsLeft: number;
  bookedCode: string | null;
  hostFirstName: string;
  packages: PackageChoice[];
  joinHref: string;
  requestAction: string;
  bookAction: string;
  next: string;
  nextUp?: { title: string; when: string; href: string };
};

/**
 * The contract's seven states, in the order they have to be tested.
 *
 * Booked is checked first: a member who already holds a place still holds it
 * when the last one goes, and the ticket stub is what they need to see. Full is
 * checked before signed-out, because "Sign in to reserve" on an event with
 * no places is a dead end — the state belongs to the event, not to the
 * reader, and the linked next date is the useful answer either way. A declined
 * membership counts as no membership, exactly as `book()` treats it.
 */
function pickActionState(input: ActionInput): ActionState {
  if (input.signedIn && input.bookedCode !== null) {
    return {
      kind: "booked",
      code: input.bookedCode,
      ticketHref: `/account/tickets/${input.bookedCode}`,
    };
  }
  if (input.placesLeft <= 0) return { kind: "full", nextUp: input.nextUp };
  if (!input.signedIn) return { kind: "signed-out", joinHref: input.joinHref };
  if (input.status === null || input.status === "declined") {
    return input.isPrivate
      ? { kind: "join-private", requestAction: input.requestAction, next: input.next }
      : { kind: "join-public", packages: input.packages };
  }
  if (input.status === "pending") return { kind: "pending", hostFirstName: input.hostFirstName };
  if (input.ticketsLeft > 0) {
    return {
      kind: "ready",
      bookAction: input.bookAction,
      ticketsLeft: input.ticketsLeft,
      ticketsTotal: input.ticketsLeft,
    };
  }
  return { kind: "no-tickets", packages: input.packages };
}

/** The same action as the sidebar, on the bar that only exists under 900px (§10.1). */
function actionBarButton(state: ActionState, bookAction: string): Child {
  switch (state.kind) {
    case "signed-out":
      return (
        <Button href={state.joinHref} variant="ghost">
          Sign in
        </Button>
      );
    case "booked":
      return (
        <Button href={state.ticketHref} variant="ghost">
          Your ticket
        </Button>
      );
    case "full":
      return (
        <Button variant="ghost" disabled={true}>
          Full
        </Button>
      );
    case "ready":
      return (
        <form method="post" action={bookAction}>
          <Button type="submit" variant="ghost">
            Confirm your place
          </Button>
        </form>
      );
    case "join-private":
      return (
        <form method="post" action={state.requestAction}>
          {state.next !== undefined ? <input type="hidden" name="next" value={state.next} /> : null}
          <Button type="submit" variant="ghost">
            Request
          </Button>
        </form>
      );
    case "pending":
      return (
        <Button href="/events" variant="ghost">
          Other events
        </Button>
      );
    default:
      return (
        <Button href="#reserve" variant="ghost">
          Take a package
        </Button>
      );
  }
}

pages.get("/events/:slug", async (c) => {
  const me = await currentUser(c);
  const slug = c.req.param("slug");
  const found = await getEventBySlug(c.env, slug);
  if (!found) {
    return notFoundPage(
      c,
      me,
      "No such event",
      `Nothing here answers to "${slug}". The ledger lists every published date.`,
    );
  }
  const { event, community } = found;

  // A draft belongs to its host and to nobody else — the public URL must not
  // leak one.
  if (event.status !== "published") {
    const maySee = me !== null && (await isCommunityHost(c.env, community.id, me.user.id));
    if (!maySee) {
      return notFoundPage(
        c,
        me,
        "No such event",
        "This date is not published. The ledger lists every event that is.",
      );
    }
  }

  const flash = await readFlash(c, me);
  const [packages, attendees, photos, communityEvents, membership, held, bookings, communityRow] =
    await Promise.all([
      listPackages(c.env, community.id),
      listEventAttendees(c.env, event.id),
      listEventPhotos(c.env, event.id),
      listEventsForCommunity(c.env, community.id),
      me ? getMembership(c.env, community.id, me.user.id) : Promise.resolve(null),
      me ? listPackagesForUser(c.env, me.user.id) : Promise.resolve([]),
      me ? listBookingsForUser(c.env, me.user.id) : Promise.resolve([]),
      getCommunityBySlug(c.env, community.slug),
    ]);

  /**
   * The single ticket on this page can be paid from the demo balance as well as
   * by the mocked card, so the action area needs to know what the member holds
   * and what the ticket costs. Only the 1-ticket package can be bought in one
   * step, so that is the price this is measured against; without one there is
   * nothing to offer and no read to make.
   */
  const single = packages.find((offer) => offer.tickets === 1);
  const balance =
    me === null || single === undefined
      ? undefined
      : await balanceOptionFor(
          c.env,
          me.user.id,
          { amountCents: single.priceCents, currency: single.currency },
          `/events/${event.slug}`,
        );

  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  const hostFirst = firstName(communityRow?.host.name ?? "");

  const ticketsLeft = held
    .filter((p) => p.communitySlug === community.slug)
    .reduce((n, p) => n + p.ticketsLeft, 0);
  const booked = bookings.find((b) => b.eventSlug === event.slug && b.status === "confirmed");
  const nextFromCommunity = upcoming(communityEvents, new Date()).find((e) => e.slug !== event.slug);

  const here = `/events/${event.slug}`;
  const bookAction = `/events/${event.slug}/book`;
  const state = pickActionState({
    signedIn: me !== null,
    isPrivate: community.isPrivate,
    placesLeft: event.placesLeft,
    status: membership?.status ?? null,
    ticketsLeft,
    bookedCode: booked?.code ?? null,
    hostFirstName: hostFirst,
    packages: toPackageChoices(community.slug, packages, here),
    joinHref: `/join?next=${encodeURIComponent(here)}`,
    requestAction: `/communities/${community.slug}/join`,
    bookAction,
    next: here,
    nextUp:
      nextFromCommunity === undefined
        ? undefined
        : {
            title: nextFromCommunity.title,
            when: formatDay(new Date(nextFromCommunity.startsAt)),
            href: `/events/${nextFromCommunity.slug}`,
          },
  });

  pageHeaders(c);
  return c.html(
    <Layout
      title={pageTitle(event.title, flash)}
      description={event.summary}
      user={layoutUser(me)}
      active="events"
      actionBar={
        <ActionBar
          title={event.title}
          note={`1 ticket · ${event.placesLeft} of ${event.capacity} places left`}
        >
          {actionBarButton(state, bookAction)}
        </ActionBar>
      }
    >
      <FlashBanner flash={flash} />

      <section class="section">
        <Container>
          <div class="row" style="align-items:flex-start;gap:var(--s7)">
            <div style="flex:9999 1 540px">
              <div class="grid--bleed">
                <Plate
                  seed={event.slug}
                  category={community.category}
                  rule={true}
                  shape="hero"
                  density="hero"
                  objectKey={event.coverKey}
                  alt={event.title}
                />
              </div>
              <h1 class="h-page" style="margin-top:-.4em;position:relative">
                {event.title}
              </h1>
              <p class="lede">{event.summary}</p>

              {/* When and where as a micro-caps definition list (§5). */}
              <dl class="deflist" style="margin-block-start:var(--s6)">
                <div>
                  <dt class="micro">When</dt>
                  <dd class="num">{formatDateRange(start, end)}</dd>
                </div>
                <div>
                  <dt class="micro">Where</dt>
                  <dd>
                    {event.venue}
                    <br />
                    {event.city}
                  </dd>
                </div>
                <div>
                  <dt class="micro">Community</dt>
                  <dd>
                    <a href={`/communities/${community.slug}`}>{community.name}</a>
                  </dd>
                </div>
                <div>
                  {/* The one large accent number in the product (§5). It goes
                      on a span rather than the `dd`, because `.deflist dd` is
                      one class plus one type and would out-specify
                      `.places-left` and repaint the number `--ink-2`. */}
                  <dt class="micro">Places left</dt>
                  <dd>
                    <span class="places-left">{event.placesLeft}</span>
                  </dd>
                </div>
              </dl>
            </div>

            <div
              id="reserve"
              class="action-sidebar bordered"
              style="flex:1 1 280px;padding:var(--s5)"
            >
              <ActionArea
                community={{ slug: community.slug, name: community.name }}
                placesLeft={event.placesLeft}
                capacity={event.capacity}
                state={state}
                eventSlug={event.slug}
                balance={balance}
              />
            </div>
          </div>
        </Container>
      </section>

      <Section index={1} label="The evening" title="What happens">
        <div class="prose">
          <p>{event.description}</p>
        </div>
      </Section>

      <Section index={2} label="Archive" title="From the log">
        <div data-gallery="">
          {photos.length === 0 ? (
            <EmptyState
              title="No plates from this one yet."
              note={`${hostFirst} adds them the week after.`}
            />
          ) : (
            <Gallery
              label={`${event.title}, archive`}
              category={community.category}
              items={toGalleryItems(photos)}
            />
          )}
        </div>
      </Section>

      <Section index={3} label="Attendees" title="Who is coming">
        <div data-attendees="">
          <AttendeeList
            attendees={attendees.map(toPerson)}
            going={attendees.length}
            capacity={event.capacity}
            signedOut={me === null}
            signInHref={`/join?next=${encodeURIComponent(here)}`}
          />
        </div>
      </Section>
    </Layout>,
  );
});

/* -------------------------------------------------------------- calendar */

/**
 * Seven-day weeks, Monday first, with the leading and trailing days borrowed
 * from the months either side so the grid is never ragged.
 */
function buildWeeks(
  year: number,
  month: number,
  source: CalendarSource[],
  todayKey: string,
): CalendarDay[][] {
  const byDate = new Map(source.map((d) => [d.date, d.events]));
  const lead = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cellCount = Math.ceil((lead + dayCount) / 7) * 7;
  const startMs = Date.UTC(year, month - 1, 1 - lead);

  const cells: CalendarDay[] = [];
  for (let i = 0; i < cellCount; i++) {
    // UTC throughout, so a day is exactly 86_400_000ms and no DST shift exists.
    const d = new Date(startMs + i * 86_400_000);
    const key = utcDateKey(d);
    cells.push({
      date: key,
      dayNumber: d.getUTCDate(),
      weekdayLabel: splitDay(d).weekday,
      inMonth: d.getUTCFullYear() === year && d.getUTCMonth() === month - 1,
      isToday: key === todayKey,
      entries: (byDate.get(key) ?? []).map((e) => ({
        slug: e.slug,
        title: e.title,
        timeLabel: formatTime(new Date(e.startsAt)),
      })),
    });
  }

  const weeks: CalendarDay[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

pages.get("/calendar", async (c) => {
  const me = await currentUser(c);
  const flash = await readFlash(c, me);
  const now = new Date();
  const raw = c.req.query("month") ?? currentMonthKey(now);
  const parsed = parseMonth(raw);

  // A typo in the URL must not look like a quiet month (contract §D).
  if (!parsed) {
    pageHeaders(c);
    return c.html(
      <Layout bodyClass="page-index" title="Calendar" user={layoutUser(me)} active="calendar">
        <Container>
          <div style="padding-block-start:var(--s5)">
            <Alert tone="warn">{`"${raw}" is not a month. Months look like 2026-09.`}</Alert>
          </div>
        </Container>
        <Hero index="01" label="Calendar" title="Calendar" lede="Published events, by day." />
        <Section index={2} label="Elsewhere" title="This month instead">
          <Button href="/calendar" variant="ghost">
            {monthTitle(now.getUTCFullYear(), now.getUTCMonth() + 1)}
          </Button>
        </Section>
      </Layout>,
      400,
    );
  }

  const { year, month } = parsed;
  const days = await listCalendarMonth(c.env, year, month);
  const weeks = buildWeeks(year, month, days, utcDateKey(now));

  const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  const key = (v: { y: number; m: number }): string => `${v.y}-${String(v.m).padStart(2, "0")}`;
  const shortName = (v: { y: number; m: number }): string =>
    MONTH_SHORT.format(new Date(Date.UTC(v.y, v.m - 1, 1)));

  pageHeaders(c);
  return c.html(
    <Layout bodyClass="page-index"
      title={pageTitle("Calendar", flash)}
      description="Every published event, laid out by the day it falls on."
      user={layoutUser(me)}
      active="calendar"
    >
      <FlashBanner flash={flash} />
      <Hero
        index="01"
        label="Calendar"
        title="Calendar"
        lede="Published events by day. Days with nothing are left empty, which is most of them."
      />
      <section class="section">
        <Container>
          <CalendarMonth
            monthLabel={monthTitle(year, month)}
            prevHref={`/calendar?month=${key(prev)}`}
            nextHref={`/calendar?month=${key(next)}`}
            prevLabel={shortName(prev)}
            nextLabel={shortName(next)}
            weeks={weeks}
          />
        </Container>
      </section>
    </Layout>,
  );
});

/* ------------------------------------------------------------- discovery */

/**
 * Search and geography — the two ways in that are not a link someone already
 * had. Both are read from the data: the countries and cities below come from
 * the communities and events that exist, so a community added in a new
 * country puts that country on `/countries` with no code change.
 *
 * Country is the primary axis and city the drill-down, which is why the rows
 * appear in that order and why `/countries/:country` links down to
 * `/cities/:city` rather than the other way round.
 */

/** How many rows one search group shows before it says it has stopped. */
const SEARCH_GROUP_LIMIT = 12;

/** The three filters a directory page carries, as they came off the URL. */
type PlaceQuery = { category?: string; country?: string; city?: string };

/**
 * Rebuild a directory URL with one filter changed or cleared, so picking a
 * country keeps the category you were already reading under. `undefined`
 * drops the parameter, which is what "All" does.
 */
/**
 * `?city=` and `?country=` off the URL.
 *
 * Neither can be checked against a list the way `?category=` is — they come
 * from the data, and hardcoding the world here is exactly what the product
 * must not do. So they are only bounded and trimmed (§8: validate what crossed
 * the network), and a name nothing answers to becomes an empty result with a
 * way out rather than an error.
 */
function readPlace(c: PageContext, base: PlaceQuery = {}): PlaceQuery {
  const clean = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed === "") return undefined;
    return trimmed.slice(0, SEARCH_MAX_LENGTH);
  };
  return { ...base, country: clean(c.req.query("country")), city: clean(c.req.query("city")) };
}

/** `Every community` · `Sailing communities` · `Sailing communities in Monaco`. */
function directoryHeading(
  category: string | undefined,
  place: PlaceQuery,
  one: string,
  many: string,
): string {
  const kind =
    category === undefined
      ? `Every ${one}`
      : `${category.charAt(0).toUpperCase()}${category.slice(1)} ${many}`;
  const where = place.city ?? place.country;
  return where === undefined ? kind : `${kind} in ${where}`;
}

function withFilters(base: string, current: PlaceQuery, change: PlaceQuery): string {
  const merged: PlaceQuery = { ...current, ...change };
  const params = new URLSearchParams();
  if (merged.category) params.set("category", merged.category);
  if (merged.country) params.set("country", merged.country);
  if (merged.city) params.set("city", merged.city);
  const query = params.toString();
  return query === "" ? base : `${base}?${query}`;
}

type PlaceOption = { label: string; href: string; count: number; current: boolean };

/**
 * The same hairline micro-caps row as the category filter, with the number of
 * things in each place beside its name. A 1px accent underline marks the live
 * one. Never pills (§5).
 *
 * `noun` is what the count counts, and it only reaches a screen reader: the
 * row is scanned visually, where the column of numerals reads as a tally.
 */
function PlaceRow(props: { label: string; noun: string; options: PlaceOption[] }) {
  return (
    <nav class="filters" aria-label={props.label}>
      {props.options.map((o) => (
        <a
          class="filter"
          href={o.href}
          aria-current={o.current ? "page" : undefined}
          aria-label={`${o.label}, ${plural(o.count, props.noun, `${props.noun}s`)}`}
        >
          {o.label}
          <span class="filter-count num" aria-hidden="true">
            {o.count}
          </span>
        </a>
      ))}
    </nav>
  );
}

/**
 * One field, in the page body. The header belongs to navigation, so search
 * lives where the reader is already looking at results (§5).
 */
function SearchField(props: { value?: string; hint?: string }) {
  return (
    <form class="searchbar" method="get" action="/search" role="search">
      <label class="vh" for="q">
        Search communities, events, cities and countries
      </label>
      <input
        id="q"
        class="searchbar-input"
        type="search"
        name="q"
        value={props.value ?? ""}
        placeholder="Bangkok, sailing, a name"
        maxlength={SEARCH_MAX_LENGTH}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        inputmode="search"
        enterkeyhint="search"
      />
      <Button type="submit" variant="ghost">
        Search
      </Button>
      {props.hint !== undefined ? <p class="searchbar-hint meta">{props.hint}</p> : null}
    </form>
  );
}

/**
 * A group that matched nothing, on a page where another group did.
 *
 * A full `EmptyState` here — heading, note and a button — out-weighed the two
 * results beside it and turned a four-result page into four screens of
 * scrolling. The group still carries its count in the section heading, which
 * is what the reader needs; this is the one line that says so in place.
 */
function GroupEmpty(props: { note: string }) {
  return <p class="meta group-empty">{props.note}</p>;
}

/** Fact, then two ways on. No apology and no exclamation mark (§6). */
function NoResults(props: { title: string; note: string }) {
  return (
    <div class="empty">
      <h3 class="h-card">{props.title}</h3>
      <p class="empty-note">{props.note}</p>
      <div class="empty-action row">
        <Button href="/communities" variant="quiet">
          Browse all communities
        </Button>
        <Button href="/events" variant="quiet">
          See what's on
        </Button>
      </div>
    </div>
  );
}

/** `Lisbon · Portugal · 2 communities · 4 events coming up`. */
function placeTally(communityCount: number, eventCount: number): string {
  return `${plural(communityCount, "community", "communities")} · ${plural(
    eventCount,
    "event",
    "events",
  )} coming up`;
}

/* -------------------------------------------------------------- countries */

pages.get("/countries", async (c) => {
  const me = await currentUser(c);
  const flash = await readFlash(c, me);
  const now = new Date();
  const countries = await listCountries(c.env, { now });
  const cities = await listCities(c.env, { now });

  const cityLine = (country: string): CitySummary[] =>
    cities.filter((city) => city.country === country);

  pageHeaders(c);
  return c.html(
    <Layout
      bodyClass="page-index"
      title={pageTitle("Countries", flash)}
      description="Every country 2CC runs in, with the communities and the events coming up in each."
      user={layoutUser(me)}
      active="countries"
    >
      <FlashBanner flash={flash} />
      <Hero
        index="01"
        label="Worldwide"
        title="Countries"
        lede="One world. Every country a community meets in, with the cities underneath it and the dates coming up in each."
      />
      <Section index={2} label="Search" title="Looking for somewhere">
        <SearchField hint="A country, a city, a community or an event." />
      </Section>
      <Section
        index={3}
        label="Index"
        title={plural(countries.length, "country", "countries")}
        action={{ href: "/events", label: "Every event" }}
      >
        {countries.length === 0 ? (
          <EmptyState
            title="No countries yet."
            note="A country appears here as soon as a community is based in it."
            action={{ href: "/communities", label: "Browse all communities" }}
          />
        ) : (
          <div class="geo-index">
            {countries.map((row) => (
              <article class="geo-row linkbox">
                <div class="geo-main">
                  <h3 class="h-card linkbox-title">
                    <a href={`/countries/${encodeURIComponent(row.country)}`}>{row.country}</a>
                  </h3>
                  <p class="geo-cities">
                    {cityLine(row.country).map((city, i) => (
                      <>
                        {i > 0 ? <span class="dot">·</span> : null}
                        <a class="secondary" href={`/cities/${encodeURIComponent(city.city)}`}>
                          {city.city}
                        </a>
                      </>
                    ))}
                  </p>
                </div>
                <dl class="geo-counts">
                  <div>
                    <dt class="micro">Communities</dt>
                    <dd class="num">{row.communityCount}</dd>
                  </div>
                  <div>
                    <dt class="micro">Cities</dt>
                    <dd class="num">{row.cityCount}</dd>
                  </div>
                  <div>
                    <dt class="micro">Coming up</dt>
                    <dd class="num">{row.eventCount}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </Section>
    </Layout>,
  );
});

pages.get("/countries/:country", async (c) => {
  const me = await currentUser(c);
  const raw = c.req.param("country");
  const now = new Date();
  const found = await getCountry(c.env, raw, { now });

  // Nothing here at all is a 404, and a styled one (§8). A country that has a
  // community but no dates is not nothing — it renders with an empty ledger.
  if (!found) {
    return notFoundPage(
      c,
      me,
      "No such country",
      `Nothing is running in "${raw}" yet. The country index lists every one that is.`,
    );
  }

  const flash = await readFlash(c, me);
  const [cities, communities, events] = await Promise.all([
    listCities(c.env, { country: found.country, now }),
    listCommunities(c.env, { country: found.country }),
    listEvents(c.env, { country: found.country, from: now }),
  ]);

  pageHeaders(c);
  return c.html(
    <Layout
      bodyClass="page-index"
      title={pageTitle(found.country, flash)}
      description={`What is on in ${found.country}: ${placeTally(found.communityCount, found.eventCount)}.`}
      user={layoutUser(me)}
      active="countries"
    >
      <FlashBanner flash={flash} />
      <Hero
        index="01"
        label="Country"
        title={`What is on in ${found.country}`}
        lede={`${placeTally(found.communityCount, found.eventCount)}, across ${plural(
          found.cityCount,
          "city",
          "cities",
        )}.`}
      />

      <Section index={2} label="Cities" title="Where in the country">
        <PlaceRow
          label={`Cities in ${found.country}`}
          noun="event"
          options={cities.map((city) => ({
            label: city.city,
            href: `/cities/${encodeURIComponent(city.city)}`,
            count: city.eventCount,
            current: false,
          }))}
        />
        <p class="meta" style="margin-block-start:var(--s4)">
          The number beside a city is how many events it has coming up.
        </p>
      </Section>

      <Section
        index={3}
        label="Communities"
        title={plural(communities.length, "community", "communities")}
        action={{
          href: `/communities?country=${encodeURIComponent(found.country)}`,
          label: "In the directory",
        }}
      >
        {communities.length === 0 ? (
          <EmptyState
            title={`No communities based in ${found.country} yet.`}
            note="The events below are run by communities based elsewhere."
            action={{ href: "/communities", label: "Browse all communities" }}
          />
        ) : (
          <CardGrid>
            {communities.map((community) => (
              <CommunityCard
                slug={community.slug}
                coverKey={community.coverKey}
                name={community.name}
                tagline={community.tagline}
                city={community.city}
                category={community.category}
                memberCount={community.memberCount}
                isPrivate={community.isPrivate}
              />
            ))}
          </CardGrid>
        )}
      </Section>

      <Section
        index={4}
        label="Coming up"
        title="The dates"
        action={{
          href: `/events?country=${encodeURIComponent(found.country)}`,
          label: "In the ledger",
        }}
      >
        {events.length === 0 ? (
          <EmptyState
            title={`No dates in ${found.country} yet.`}
            note="Hosts post a season at a time. The calendar keeps the months either side."
            action={{ href: "/calendar", label: "Open the calendar" }}
          />
        ) : (
          <Ledger groups={toLedgerGroups(events)} />
        )}
      </Section>
    </Layout>,
  );
});

/* ----------------------------------------------------------------- cities */

pages.get("/cities/:city", async (c) => {
  const me = await currentUser(c);
  const raw = c.req.param("city");
  const now = new Date();
  const found = await getCity(c.env, raw, { now });

  if (!found) {
    return notFoundPage(
      c,
      me,
      "No such city",
      `Nothing is running in "${raw}" yet. Every country 2CC covers is on the country index.`,
    );
  }

  const flash = await readFlash(c, me);
  const [communities, events] = await Promise.all([
    listCommunities(c.env, { city: found.city }),
    listEvents(c.env, { city: found.city, from: now }),
  ]);

  pageHeaders(c);
  return c.html(
    <Layout
      bodyClass="page-index"
      title={pageTitle(found.city, flash)}
      description={`What is on in ${found.city}: ${placeTally(found.communityCount, found.eventCount)}.`}
      user={layoutUser(me)}
      active="countries"
    >
      <FlashBanner flash={flash} />
      {/* The country is the level above, and it goes in the hero rather than
          in a band of its own: rendered as its own section it was one link
          alone in a full clamp(64px,12vw,144px) band, which reads as an empty
          screen between the title and the first result. */}
      <Hero
        index="01"
        label="City"
        title={`What is on in ${found.city}`}
        lede={`${placeTally(found.communityCount, found.eventCount)}. Every event has a date, an address and a number of places.`}
      >
        <a class="geo-up" href={`/countries/${encodeURIComponent(found.country)}`}>
          {`Everything in ${found.country}`}
        </a>
      </Hero>

      <Section
        index={2}
        label="Coming up"
        title={plural(events.length, "event", "events")}
        action={{ href: "/calendar", label: "By month" }}
      >
        {events.length === 0 ? (
          <EmptyState
            title={`No dates in ${found.city} yet.`}
            note={`The communities based here post their calendars a season ahead. ${found.country} has other cities running now.`}
            action={{
              href: `/countries/${encodeURIComponent(found.country)}`,
              label: `Everything in ${found.country}`,
            }}
          />
        ) : (
          <Ledger groups={toLedgerGroups(events)} />
        )}
      </Section>

      <Section
        index={3}
        label="Communities"
        title={
          communities.length === 1
            ? "The community based here"
            : `${communities.length} communities based here`
        }
        action={{
          href: `/communities?city=${encodeURIComponent(found.city)}`,
          label: "In the directory",
        }}
      >
        {communities.length === 0 ? (
          <EmptyState
            title={`No community is based in ${found.city}.`}
            note="The dates above are run by communities based in other cities."
            action={{
              href: `/countries/${encodeURIComponent(found.country)}`,
              label: `Communities in ${found.country}`,
            }}
          />
        ) : (
          <CardGrid>
            {communities.map((community) => (
              <CommunityCard
                slug={community.slug}
                coverKey={community.coverKey}
                name={community.name}
                tagline={community.tagline}
                city={community.city}
                category={community.category}
                memberCount={community.memberCount}
                isPrivate={community.isPrivate}
              />
            ))}
          </CardGrid>
        )}
      </Section>
    </Layout>,
  );
});

/* ----------------------------------------------------------------- search */

pages.get("/search", async (c) => {
  const me = await currentUser(c);
  const flash = await readFlash(c, me);
  const raw = c.req.query("q") ?? "";

  // Past the cap it is a payload rather than a search (§8: validate what
  // crossed the network, and answer 400 rather than throwing a 500).
  if (raw.length > SEARCH_MAX_LENGTH) {
    pageHeaders(c);
    return c.html(
      <Layout bodyClass="page-index" title="Search" user={layoutUser(me)} active="search">
        <Container>
          <div style="padding-block-start:var(--s5)">
            <Alert tone="warn">
              {`That search is ${raw.length} characters. ${SEARCH_MAX_LENGTH} is the most this field takes.`}
            </Alert>
          </div>
        </Container>
        <Hero index="01" label="Search" title="Search" lede="One field, across every country." />
        <Section index={2} label="Again" title="Try a shorter one">
          <SearchField hint="A country, a city, a community or an event." />
        </Section>
      </Layout>,
      400,
    );
  }

  const term = raw.trim();

  // An empty field is a prompt, not an error — someone has just arrived.
  if (term === "") {
    const now = new Date();
    const countries = await listCountries(c.env, { now });
    pageHeaders(c);
    return c.html(
      <Layout
        bodyClass="page-index"
        title={pageTitle("Search", flash)}
        description="Search every community, event, city and country on 2CC."
        user={layoutUser(me)}
        active="search"
      >
        <FlashBanner flash={flash} />
        <Hero
          index="01"
          label="Search"
          title="Search"
          lede="One field. It reads community names and descriptions, event titles and summaries, and the names of cities and countries."
        />
        <Section index={2} label="Field" title="What are you looking for">
          <SearchField hint="A country, a city, a community or an event." />
        </Section>
        <Section
          index={3}
          label="Countries"
          title="Or start from a country"
          action={{ href: "/countries", label: "The country index" }}
        >
          <PlaceRow
            label="Countries"
            noun="event"
            options={countries.map((row) => ({
              label: row.country,
              href: `/countries/${encodeURIComponent(row.country)}`,
              count: row.eventCount,
              current: false,
            }))}
          />
        </Section>
      </Layout>,
    );
  }

  const now = new Date();
  const [communities, events, countries, cities] = await Promise.all([
    searchCommunities(c.env, term, { limit: SEARCH_GROUP_LIMIT }),
    searchEvents(c.env, term, { from: now, limit: SEARCH_GROUP_LIMIT }),
    listCountries(c.env, { match: term, now, limit: SEARCH_GROUP_LIMIT }),
    listCities(c.env, { match: term, now, limit: SEARCH_GROUP_LIMIT }),
  ]);
  const total = communities.length + events.length + countries.length + cities.length;

  /** Said only when a group is full, because then there may well be more. */
  const capped = (n: number): Child =>
    n < SEARCH_GROUP_LIMIT ? null : (
      <p class="meta" style="margin-block-start:var(--s4)">
        {`The first ${SEARCH_GROUP_LIMIT} are shown. Narrow the search to see the rest.`}
      </p>
    );

  pageHeaders(c);
  return c.html(
    <Layout
      bodyClass="page-index"
      title={pageTitle(`Search: ${term}`, flash)}
      description={`What matches "${term}" across every community, event, city and country.`}
      user={layoutUser(me)}
      active="search"
    >
      <FlashBanner flash={flash} />
      <Hero
        index="01"
        label="Search"
        title={term}
        lede={
          total === 0
            ? "Nothing matches that yet."
            : `${plural(total, "result", "results")}, in four groups: communities, events, countries and cities.`
        }
      />

      <Section index={2} label="Search" title="Search again">
        <SearchField value={term} hint="A country, a city, a community or an event." />
      </Section>

      {total === 0 ? (
        <Section index={3} label="Nothing" title="No matches">
          <NoResults
            title={`Nothing matches "${term}".`}
            note="The search reads community names, taglines and descriptions, event titles and summaries, and the names of cities and countries."
          />
        </Section>
      ) : (
        <>
          <Section
            index={3}
            label="Communities"
            title={plural(communities.length, "community", "communities")}
          >
            {communities.length === 0 ? (
              <GroupEmpty note={`No community matches "${term}".`} />
            ) : (
              <>
                <CardGrid>
                  {communities.map((community) => (
                    <CommunityCard
                      slug={community.slug}
                      coverKey={community.coverKey}
                      name={community.name}
                      tagline={community.tagline}
                      city={community.city}
                      category={community.category}
                      memberCount={community.memberCount}
                      isPrivate={community.isPrivate}
                    />
                  ))}
                </CardGrid>
                {capped(communities.length)}
              </>
            )}
          </Section>

          <Section
            index={4}
            label="Events"
            title={plural(events.length, "event", "events")}
          >
            {events.length === 0 ? (
              <GroupEmpty
                note={`No event matches "${term}". Only dates that have not started yet are searched.`}
              />
            ) : (
              <>
                <Ledger groups={toLedgerGroups(events)} />
                {capped(events.length)}
              </>
            )}
          </Section>

          <Section
            index={5}
            label="Countries"
            title={plural(countries.length, "country", "countries")}
            action={{ href: "/countries", label: "The country index" }}
          >
            {countries.length === 0 ? (
              <GroupEmpty note={`No country matches "${term}".`} />
            ) : (
              <PlaceRow
                label="Countries that match"
                noun="event"
                options={countries.map((row) => ({
                  label: row.country,
                  href: `/countries/${encodeURIComponent(row.country)}`,
                  count: row.eventCount,
                  current: false,
                }))}
              />
            )}
          </Section>

          <Section index={6} label="Cities" title={plural(cities.length, "city", "cities")}>
            {cities.length === 0 ? (
              <GroupEmpty note={`No city matches "${term}".`} />
            ) : (
              <PlaceRow
                label="Cities that match"
                noun="event"
                options={cities.map((row) => ({
                  label: row.city,
                  href: `/cities/${encodeURIComponent(row.city)}`,
                  count: row.eventCount,
                  current: false,
                }))}
              />
            )}
          </Section>
        </>
      )}
    </Layout>,
  );
});

/* ------------------------------------------------------------------ join */

type JoinForm = {
  email: string;
  name: string;
  code: string;
  next?: string;
  errors: { email?: string; name?: string };
};

/**
 * §5: no card. A 420px column on bare ink, the invitation line in Fraunces
 * italic, inputs with one rule underneath. Three inputs on black looks
 * unbuilt, so the terms and the what-happens-next carry the rest of the column.
 */
function JoinPage(props: { form: JoinForm; user: LayoutUser; flash: Flash | null }) {
  const { form, user, flash } = props;
  const problems: string[] = [];
  if (form.errors.email !== undefined) problems.push(form.errors.email);
  if (form.errors.name !== undefined) problems.push(form.errors.name);

  return (
    <Layout
      title={pageTitle("Join", flash)}
      description="Email and a name. No password."
      user={user}
    >
      <FlashBanner flash={flash} />
      {problems.length > 0 ? (
        <Container>
          <div style="padding-block-start:var(--s5)">
            <Alert tone="rust">{problems.join(" ")}</Alert>
          </div>
        </Container>
      ) : null}

      <section class="section">
        <Container>
          <div class="column-420">
            <p class="index">
              <span class="index-rule" aria-hidden="true" />
              <span class="index-num">01</span>
              <span class="index-sep" aria-hidden="true">
                /
              </span>
              <span class="index-label">Membership</span>
            </p>
            <h1 class="h-page">Join</h1>
            <p class="invitation" style="margin-block-start:var(--s5)">
              Anyone can join. One click with Google, or two fields.
            </p>

            {/* One click, and it never touches a real Google account. See
                `GoogleChooserPage` below for what it actually opens. */}
            <div style="margin-block-start:var(--s6)">
              <Button
                href={`/join/google${form.next === undefined ? "" : `?next=${encodeURIComponent(form.next)}`}`}
                variant="primary"
                block={true}
              >
                <ProviderMark /> Continue with Google
              </Button>
              <p class="field-hint" style="margin-block-start:var(--s3)">
                A demo sign-in. It opens a list of made-up accounts — no real Google account is
                involved, and there is no password to type.
              </p>
            </div>

            <p class="or-rule" style="margin-block-start:var(--s6)">
              <span>or</span>
            </p>

            <form
              method="post"
              action="/auth/login"
              class="stack stack--wide"
              style="margin-block-start:var(--s7)"
            >
              {form.next !== undefined ? (
                <input type="hidden" name="next" value={form.next} />
              ) : null}
              <Field
                label="Email"
                name="email"
                type="email"
                value={form.email}
                required={true}
                error={form.errors.email}
                autocomplete="email"
                inputmode="email"
                enterkeyhint="go"
                autocapitalize="off"
                spellcheck={false}
              />
              <Field
                label="Name"
                name="name"
                value={form.name}
                error={form.errors.name}
                autocomplete="name"
                hint="Only needed the first time. A returning member keeps the name they have."
              />
              <Field
                label="Invitation code"
                name="code"
                value={form.code}
                code={true}
                hint="Optional, and not checked yet — the field shows where an invitation code goes."
              />
              <div>
                <Button type="submit" variant="primary">
                  Continue
                </Button>
              </div>
            </form>

            <div style="margin-block-start:var(--s7)">
              <p class="micro">Membership terms</p>
              <ul class="stack" style="margin-block-start:var(--s4)">
                <li class="meta">
                  Membership costs nothing. You pay for packages, one community at a time.
                </li>
                <li class="meta">
                  One ticket takes one place. Cancel the place and the ticket comes back.
                </li>
                <li class="meta">
                  Private communities are approved by the host, by hand, and can say no.
                </li>
                <li class="meta">
                  Other members see your name and your one-line headline, nothing else.
                </li>
              </ul>
            </div>

            <div style="margin-block-start:var(--s6)">
              <p class="micro">What happens next</p>
              <p class="meta" style="margin-block-start:var(--s4)">
                You are signed in the moment you continue. There is no password and nothing to
                confirm by email. Your account page holds your packages, your tickets and the
                places you hold.
              </p>
            </div>
          </div>
        </Container>
      </section>
    </Layout>
  );
}

/**
 * The mark on the sign-in button.
 *
 * Drawn here, in one path, on purpose. **Google's own mark is not used and must
 * not be** — a screen that borrows the four-colour G is a screen that claims to
 * be Google, and this one is a demo chooser with made-up accounts. A neutral
 * hairline reticle says "an account somewhere else" without pretending to be
 * anybody. 16px, 1px stroke, `currentColor` (§7).
 */
function ProviderMark() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      style="vertical-align:-2px;margin-inline-end:8px"
    >
      <g fill="none" stroke="currentColor" stroke-width="1">
        <circle cx="8" cy="8" r="6.5" />
        <path d="M1.5 8h13" />
        <path d="M8 1.5c3 2.6 3 9.4 0 13-3-3.6-3-10.4 0-13Z" />
      </g>
    </svg>
  );
}

/* ------------------------------------------------- the demo account chooser */

/** One row on the chooser: who they are, and what signing in as them gives you. */
type DemoAccount = { email: string; name: string; note: string };

/**
 * The two accounts the seed guarantees (`scripts/seed.mjs` asserts both exist),
 * with the names they are seeded under as a fallback for a database that has
 * not been seeded yet.
 */
const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { email: "member@2cc.club", name: "Alexandra Voss", note: "A member. Holds packages and tickets." },
  { email: "host@2cc.club", name: "Rafael Ortiz", note: "A host. Runs two communities as well." },
];

/**
 * The demo account chooser.
 *
 * **This screen never collects a credential and must never be made to.** There
 * is no password field, no email field, and nothing styled to look like
 * Google's own sign-in — the whole page is a list of obviously-fake accounts
 * with the word Demo on it, and every row is a plain submit button. Picking one
 * signs you in as that member, exactly as `POST /auth/login` already does with
 * an email and a name, because this product has no passwords at all (spec,
 * non-goals).
 *
 * The server session is still what authorises anything. Bookings, tickets and
 * the balance are keyed to a user row, and the server cannot read
 * `localStorage`, so one click creates or reuses the real member and their
 * session cookie. The copy in `localStorage` is written on top of that, by the
 * middleware in `src/routes/wallet.tsx`.
 */
function GoogleChooserPage(props: {
  accounts: DemoAccount[];
  guest: DemoAccount;
  next?: string;
  user: LayoutUser;
  flash: Flash | null;
}) {
  const { accounts, guest, next, user, flash } = props;

  const row = (account: DemoAccount, label: string) => (
    <form method="post" action="/auth/google" class="chooser-row">
      <input type="hidden" name="email" value={account.email} />
      <input type="hidden" name="name" value={account.name} />
      {next !== undefined ? <input type="hidden" name="next" value={next} /> : null}
      <span class="chooser-who">
        <span class="chooser-name">{account.name}</span>
        <span class="meta num">{account.email}</span>
        <span class="meta">{account.note}</span>
      </span>
      {/* The visible label is a whole word; the name it continues as is on the
          accessible name, where a screen reader reads it with the row. */}
      <Button type="submit" variant="ghost" ariaLabel={`${label} ${account.name}`}>
        Continue
      </Button>
    </form>
  );

  return (
    <Layout
      title={pageTitle("Choose a demo account", flash)}
      description="Pick one of the demo accounts. No password, and no real Google account."
      user={user}
    >
      <FlashBanner flash={flash} />

      <section class="section">
        <Container>
          <div class="column-420">
            <p class="index">
              <span class="index-rule" aria-hidden="true" />
              <span class="index-num">01</span>
              <span class="index-sep" aria-hidden="true">
                /
              </span>
              <span class="index-label">Demo sign-in</span>
            </p>
            <h1 class="h-page">Choose an account</h1>
            <p class="status status--warn" style="margin-block-start:var(--s4)">
              Demo — these accounts are made up
            </p>
            <p class="lede" style="margin-block-start:var(--s5)">
              No Google account is involved, nothing is asked for and nothing is checked. Picking a
              name signs you straight in as that member.
            </p>

            <div class="chooser" style="margin-block-start:var(--s7)" data-chooser="">
              {accounts.map((account) => row(account, "Continue as"))}
              {row(guest, "Continue as")}
            </div>

            {/* `.action-help` rather than `.meta`: it is the one that gives an
                inline link a hairline, and a link nobody can see is not a link. */}
            <p class="action-help" style="margin-block-start:var(--s6)">
              Rather type an email?{" "}
              <a href={`/join${next === undefined ? "" : `?next=${encodeURIComponent(next)}`}`}>
                Back to Join
              </a>
              .
            </p>
          </div>
        </Container>
      </section>
    </Layout>
  );
}

/**
 * "Use a different account", as an account.
 *
 * Generated per render so the button needs no typing and still lands on a
 * member of its own. The domain is not a real one, which is the point — this is
 * a demo identity, and it should read as one wherever it turns up.
 */
function guestAccount(): DemoAccount {
  const tag = newId().slice(0, 4).toUpperCase();
  return {
    email: `guest.${tag.toLowerCase()}@demo.2cc.club`,
    name: `Guest ${tag}`,
    note: "Use a different account. A new member, made on the spot.",
  };
}

pages.get("/join/google", async (c) => {
  const me = await currentUser(c);
  const flash = await readFlash(c, me);
  const next = safeNext(c.req.query("next"));

  // The seeded names, read back so the chooser cannot drift from the database.
  // A database that has not been seeded falls back to the constants, and
  // `signIn` creates the member on the first click.
  const db = getDb(c.env);
  const known = await db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(inArray(users.email, DEMO_ACCOUNTS.map((account) => account.email)))
    .limit(DEMO_ACCOUNTS.length);
  const byEmail = new Map(known.map((row) => [row.email, row.name]));
  const accounts = DEMO_ACCOUNTS.map((account) => ({
    ...account,
    name: byEmail.get(account.email) ?? account.name,
  }));

  pageHeaders(c);
  return c.html(
    <GoogleChooserPage
      accounts={accounts}
      guest={guestAccount()}
      next={next}
      user={layoutUser(me)}
      flash={flash}
    />,
  );
});

pages.get("/join", async (c) => {
  const me = await currentUser(c);
  const flash = await readFlash(c, me);
  const next = safeNext(c.req.query("next"));

  pageHeaders(c);
  return c.html(
    <JoinPage
      form={{ email: "", name: "", code: "", next, errors: {} }}
      user={layoutUser(me)}
      flash={flash}
    />,
  );
});

/* -------------------------------------------------------------- mutations */

/** An address with an `@` and no spaces. Anything stricter rejects real addresses. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

pages.post("/auth/login", async (c) => {
  const body = await c.req.parseBody();
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const next = safeNext(typeof body.next === "string" ? body.next : undefined);

  const errors: JoinForm["errors"] = {};
  if (email === "") {
    errors.email = "An email address is required.";
  } else if (!EMAIL_RE.test(email)) {
    errors.email = "That does not look like an email address.";
  }

  // A returning member keeps the name they have; only a new one must supply it.
  const existing = errors.email === undefined ? await findUserByEmail(c.env, email) : null;
  if (errors.email === undefined && existing === null && name === "") {
    errors.name = "A name is required the first time you sign in.";
  }

  if (errors.email !== undefined || errors.name !== undefined) {
    // Re-render with 400 and every typed value echoed back — nothing is lost.
    const me = await currentUser(c);
    pageHeaders(c);
    return c.html(
      <JoinPage form={{ email, name, code, next, errors }} user={layoutUser(me)} flash={null} />,
      400,
    );
  }

  const session = await signIn(c.env, email, name);
  setSessionCookie(c, session);
  return c.redirect(next ?? "/account", 302);
});

/**
 * Sign in as one of the demo accounts — the whole of the "Sign in with Google"
 * flow, and deliberately no more than `POST /auth/login` already does.
 *
 * No credential is accepted here because none exists: this product has no
 * passwords (spec, non-goals), and `/auth/login` has always signed a member in
 * from an email and a name alone. This route is that, with the typing removed.
 */
pages.post("/auth/google", async (c) => {
  const body = await c.req.parseBody();
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const next = safeNext(typeof body.next === "string" ? body.next : undefined);

  if (!EMAIL_RE.test(email) || name === "") {
    return c.json({ error: "A demo account needs an email and a name" }, 400);
  }

  const session = await signIn(c.env, email, name);
  setSessionCookie(c, session);
  return c.redirect(next ?? "/account", 302);
});

pages.post("/auth/logout", async (c) => {
  await signOut(c);
  return c.redirect("/", 302);
});

pages.post("/communities/:slug/join", async (c) => {
  const slug = c.req.param("slug");
  const body = await c.req.parseBody();
  const next = safeNext(typeof body.next === "string" ? body.next : undefined);
  const back = next ?? `/communities/${slug}`;

  const me = await currentUser(c);
  if (!me) return c.redirect(`/join?next=${encodeURIComponent(back)}`, 302);

  const found = await getCommunityBySlug(c.env, slug);
  if (!found) {
    return notFoundPage(c, me, "No such community", `Nothing here answers to "${slug}".`);
  }
  const { community, host } = found;

  // Both of these are "nothing happened", so they carry the `warn` tone: a
  // no-op rendered in the confirmation band reads as a second success.
  const membership = await getMembership(c.env, community.id, me.user.id);
  if (membership?.status === "approved") {
    await setFlash(c.env, me.session.id, flashMessage("warn", `You are already in ${community.name}.`));
    return c.redirect(back, 302);
  }
  if (membership?.status === "pending") {
    await setFlash(
      c.env,
      me.session.id,
      flashMessage("warn", `Your request is already with ${firstName(host.name)}.`),
    );
    return c.redirect(back, 302);
  }

  // No service owns this insert: `src/services/` reads memberships, and
  // `purchase()` writes one inside its own batch, but there is no join(). One
  // parameterised statement, and the unique index on (community, member) makes a
  // double submit a no-op rather than a second row.
  const status: MembershipStatus = community.isPrivate ? "pending" : "approved";
  await getDb(c.env)
    .insert(communityMembers)
    .values({ id: newId(), communityId: community.id, userId: me.user.id, role: "member", status })
    .onConflictDoNothing();

  await setFlash(
    c.env,
    me.session.id,
    flashMessage(
      "confirm",
      status === "approved"
        ? `You are in ${community.name}. A package buys the tickets that take a place.`
        : `Your request is with ${firstName(host.name)}. ${community.name} approves members by hand.`,
    ),
  );
  return c.redirect(back, 302);
});

export default pages;
