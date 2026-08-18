/**
 * The public surface — `src/routes/pages.tsx`, mounted at `/`:
 *
 *   app.route("/", pages);
 *
 * so the paths declared here are the contract's URLs
 * (`design/reference/api-contract.md`). Seven pages and three mutations: the
 * landing, the directory, one circle, the ledger of gatherings, one gathering,
 * the calendar, the join form, and sign in / sign out / join a circle.
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
  CIRCLE_CATEGORIES,
  circleMembers,
  type CircleCategory,
  type MembershipStatus,
} from "../schema";
import { getCircleBySlug, isCircleHost, listCirclePhotos, listCircles } from "../services/circles";
import { utcDateKey } from "../services/common";
import {
  listBookingsForUser,
  listPackages,
  listPassesForUser,
  type PackageOffer,
} from "../services/commerce";
import {
  currentMonthKey,
  getEventBySlug,
  listCalendarMonth,
  listEventPhotos,
  listEvents,
  listEventsForCircle,
  parseMonth,
  type CalendarDay as CalendarSource,
  type EventSummary,
} from "../services/events";
import { getMembership, listApprovedMembers, listEventAttendees } from "../services/members";
import { ActionArea, ActionBar, PassTable, type ActionState, type PassOffer } from "../ui/booking";
import { CalendarMonth, Ledger, type CalendarDay, type LedgerGroup } from "../ui/calendar";
import {
  Alert,
  Button,
  CardGrid,
  CircleCard,
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

/** Gatherings that have not started yet, in the order the service returned them. */
function upcoming(events: EventSummary[], now: Date): EventSummary[] {
  return events.filter((e) => new Date(e.startsAt).getTime() >= now.getTime());
}

/** `€180` and the derivation `3 gatherings · €60 each`. Never "from" (§6). */
function toPassOffers(circleSlug: string, offers: PackageOffer[], next?: string): PassOffer[] {
  const query = next === undefined ? "" : `?next=${encodeURIComponent(next)}`;
  return offers.map((p) => ({
    id: p.id,
    name: p.name,
    credits: p.credits,
    price: formatMoney(p.priceCents, p.currency),
    derivation:
      p.credits === 1
        ? "1 gathering"
        : `${p.credits} gatherings · ${formatMoney(Math.round(p.priceCents / p.credits), p.currency)} each`,
    href: `/circles/${circleSlug}/passes/${p.id}/checkout${query}`,
  }));
}

function toGalleryItems(
  photos: { caption: string; seed: string; objectKey: string | null }[],
): GalleryItem[] {
  return photos.map((p) => ({ caption: p.caption, seed: p.seed, objectKey: p.objectKey }));
}

function toPerson(p: { name: string; headline: string | null; city?: string | null }): PersonEntry {
  return { name: p.name, headline: p.headline ?? "Member", city: p.city ?? undefined };
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
          <Button href="/circles" variant="ghost">
            The circles
          </Button>
          <Button href="/events" variant="ghost">
            Every gathering
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
  const [circles, events] = await Promise.all([listCircles(c.env), listEvents(c.env)]);
  const next = upcoming(events, new Date()).slice(0, 4);

  pageHeaders(c);
  return c.html(
    <Layout
      title={pageTitle("By invitation", flash)}
      description="Circles that meet on a date, at an address, with a limit on how many people can come."
      user={layoutUser(me)}
    >
      <FlashBanner flash={flash} />

      {/* §5: one sentence at --t-hero in the left 8 columns, then the subline
          that defines all four nouns in one breath. */}
      <Hero
        scale="hero"
        title="Every gathering here has a date, an address, and a limit on how many people can come."
        lede="A circle is a standing group with a host and a place. A gathering is one dated meeting of it. A pass buys 1, 3 or 6 credits for one circle, and one credit takes one place."
      />

      {/* The date and the places left are what a traveller wants, so the
          gatherings sit above the circles. */}
      <Section
        index={1}
        label="Next"
        title="The next gatherings"
        action={{ href: "/events", label: "Every gathering" }}
      >
        {next.length === 0 ? (
          <EmptyState
            title="No gatherings scheduled."
            note="Hosts post their dates a season ahead. The calendar keeps the months either side."
            action={{ href: "/calendar", label: "Open the calendar" }}
          />
        ) : (
          <CardGrid wide={true}>
            {next.map((e) => (
              <EventCard
                slug={e.slug} coverKey={e.coverKey}
                title={e.title}
                circleName={e.circle.name}
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
        label="Circles"
        title="The circles"
        action={{ href: "/circles", label: "The directory" }}
      >
        <CardGrid>
          {circles.map((circle) => (
            <CircleCard
              slug={circle.slug} coverKey={circle.coverKey}
              name={circle.name}
              tagline={circle.tagline}
              city={circle.city}
              category={circle.category}
              memberCount={circle.memberCount}
              isPrivate={circle.isPrivate}
            />
          ))}
        </CardGrid>
      </Section>

      <Section index={3} label="How it works" title="What a gathering is">
        <div class="prose">
          <p>
            A gathering is not an open invitation. It is a date, a street address, a start time in
            real minutes, and a number of chairs that runs out.
          </p>
          <p>
            Someone has already cut the ice, booked the boat or lit the fire. The host writes the
            constraint into the listing — no phones, eight seats, back by two — and everyone who
            takes a place has read it.
          </p>
          <p>
            That is what keeps a gathering small enough to be real. You are not an audience. You are
            one of the twelve.
          </p>
        </div>
      </Section>
    </Layout>,
  );
});

/* ------------------------------------------------------------- circles */

/** Micro-caps hairline row, active marked by a 1px brass underline. Never pills (§5). */
function categoryFilters(active: string | undefined): FilterOption[] {
  const options: FilterOption[] = [{ label: "All", href: "/circles", current: active === undefined }];
  for (const category of CIRCLE_CATEGORIES) {
    options.push({
      label: category,
      href: `/circles?category=${category}`,
      current: active === category,
    });
  }
  return options;
}

pages.get("/circles", async (c) => {
  const me = await currentUser(c);
  const flash = await readFlash(c, me);
  const raw = c.req.query("category");

  // An unknown category is a typo in the URL, not an empty directory (§8).
  if (raw !== undefined && raw !== "" && !(CIRCLE_CATEGORIES as readonly string[]).includes(raw)) {
    pageHeaders(c);
    return c.html(
      <Layout bodyClass="page-index" title="Circles" user={layoutUser(me)} active="circles">
        <Container>
          <div style="padding-block-start:var(--s5)">
            <Alert tone="warn">
              {`There is no "${raw}" category. The five are: ${CIRCLE_CATEGORIES.join(", ")}.`}
            </Alert>
          </div>
        </Container>
        <Hero
          index="01"
          label="Directory"
          title="Circles"
          lede="Each circle is run by one person, meets in one city, and holds a fixed number of members."
        />
        <Section index={2} label="Category" title="Pick one of the five">
          <FilterRow label="Category" options={categoryFilters(undefined)} />
        </Section>
      </Layout>,
      400,
    );
  }

  const category = raw === undefined || raw === "" ? undefined : (raw as CircleCategory);
  const circles = await listCircles(c.env, { category });

  pageHeaders(c);
  return c.html(
    <Layout bodyClass="page-index"
      title={pageTitle("Circles", flash)}
      description="Every circle, by category. One host, one city, a fixed number of members."
      user={layoutUser(me)}
      active="circles"
    >
      <FlashBanner flash={flash} />
      <Hero
        index="01"
        label="Directory"
        title="Circles"
        lede="Each circle is run by one person, meets in one city, and holds a fixed number of members."
      />
      <Section
        index={2}
        label="Category"
        title={
          category === undefined
            ? "Every circle"
            : `${category.charAt(0).toUpperCase()}${category.slice(1)} circles`
        }
      >
        <div style="margin-block-end:var(--s6)">
          <FilterRow label="Category" options={categoryFilters(category)} />
        </div>
        {circles.length === 0 ? (
          <EmptyState
            title="No circles in this category yet."
            note="The other categories all have circles taking members."
            action={{ href: "/circles", label: "Every circle" }}
          />
        ) : (
          <CardGrid>
            {circles.map((circle) => (
              <CircleCard
                slug={circle.slug} coverKey={circle.coverKey}
                name={circle.name}
                tagline={circle.tagline}
                city={circle.city}
                category={circle.category}
                memberCount={circle.memberCount}
                isPrivate={circle.isPrivate}
              />
            ))}
          </CardGrid>
        )}
      </Section>
    </Layout>,
  );
});

/* --------------------------------------------------------------- circle */

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
          href={`/join?next=${encodeURIComponent(`/circles/${slug}`)}`}
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
        <p class="action-line">You are in this circle.</p>
        <Button href="#gatherings" variant="ghost" block={true}>
          {dateCount === 0 ? "No dates yet" : dateCount === 1 ? "The one date" : `The ${dateCount} dates`}
        </Button>
        <p class="action-help">
          A place costs 1 credit. The passes are below, and your credits are on{" "}
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
          <a href="/events">other gatherings</a>.
        </p>
      </div>
    );
  }

  return (
    <div class="action">
      <p class="micro">Membership</p>
      <form method="post" action={`/circles/${slug}/join`}>
        <input type="hidden" name="next" value={`/circles/${slug}`} />
        <Button type="submit" variant="primary" block={true}>
          {isPrivate ? "Request an invitation" : "Join the circle"}
        </Button>
      </form>
      <p class="action-help">
        {isPrivate
          ? "This circle approves members by hand."
          : "Public circle. You are in as soon as you ask."}
      </p>
    </div>
  );
}

pages.get("/circles/:slug", async (c) => {
  const me = await currentUser(c);
  const slug = c.req.param("slug");
  const found = await getCircleBySlug(c.env, slug);
  if (!found) {
    return notFoundPage(
      c,
      me,
      "No such circle",
      `Nothing here answers to "${slug}". The directory lists every circle there is.`,
    );
  }
  const { circle, host } = found;
  const flash = await readFlash(c, me);

  const [packages, events, members, photos, membership] = await Promise.all([
    listPackages(c.env, circle.id),
    listEventsForCircle(c.env, circle.id),
    listApprovedMembers(c.env, circle.id),
    listCirclePhotos(c.env, circle.id),
    me ? getMembership(c.env, circle.id, me.user.id) : Promise.resolve(null),
  ]);

  const nextDates = upcoming(events, new Date());
  const hostMember = members.find((m) => m.role === "host");
  const otherMembers = members.filter((m) => m.role !== "host");
  const status = membership?.status ?? null;
  const hostFirst = firstName(host.name);

  const barAction: Child =
    me === null ? (
      <Button href={`/join?next=${encodeURIComponent(`/circles/${circle.slug}`)}`} variant="ghost">
        Sign in
      </Button>
    ) : status === "approved" ? (
      <Button href="#gatherings" variant="ghost">
        The dates
      </Button>
    ) : status === "pending" ? (
      <Button href="/events" variant="ghost">
        Other gatherings
      </Button>
    ) : (
      <form method="post" action={`/circles/${circle.slug}/join`}>
        <input type="hidden" name="next" value={`/circles/${circle.slug}`} />
        <Button type="submit" variant="ghost">
          {circle.isPrivate ? "Request" : "Join"}
        </Button>
      </form>
    );

  pageHeaders(c);
  return c.html(
    <Layout
      title={pageTitle(circle.name, flash)}
      description={circle.tagline}
      user={layoutUser(me)}
      active="circles"
      actionBar={
        <ActionBar
          title={circle.name}
          note={`${plural(circle.memberCount, "member", "members")} · ${plural(nextDates.length, "date", "dates")}`}
        >
          {barAction}
        </ActionBar>
      }
    >
      <FlashBanner flash={flash} />

      {/* §5: full-bleed cover, the name overlapping its lower edge. The
          photograph leads; the plate is what a circle without one falls back
          to (§11). */}
      <section class="section">
        <Container>
          <div class="grid--bleed">
            <Plate
              seed={circle.slug}
              category={circle.category}
              monogram={initials(circle.name)}
              shape="hero"
              density="hero"
              objectKey={circle.coverKey}
              alt={circle.name}
            />
          </div>
          <div class="eight">
            <h1 class="h-page" style="margin-top:-.4em;position:relative">
              {circle.name}
            </h1>
            <p class="lede">{circle.tagline}</p>
            <p class="meta" style="margin-block-start:var(--s4)">
              <span class="micro micro--brass">{circle.category}</span>{" · "}
              {placeLabel(circle.city, circle.country)} · <span class="num">{circle.memberCount}</span> members ·{" "}
              <span class="num">{circle.eventCount}</span> gatherings
              {circle.isPrivate ? " · by request" : ""}
            </p>
          </div>
        </Container>
      </section>

      <Section index={1} label="Story" title="What this circle is">
        <div class="row" style="align-items:flex-start;gap:var(--s7)">
          <div style="flex:9999 1 540px">
            <div class="prose">
              <p>{circle.description}</p>
            </div>
            <div class="row" style="margin-block-start:var(--s6);align-items:flex-start">
              <span class="avatar" aria-hidden="true">
                {initials(host.name)}
              </span>
              <div>
                <p class="person-name">
                  {host.name} <span class="status status--brass">Host</span>
                </p>
                <p class="person-line">{host.headline ?? "Runs this circle."}</p>
                <p class="person-line">{host.city ?? circle.city}</p>
              </div>
            </div>
          </div>
          <div class="action-sidebar bordered" style="flex:1 1 280px;padding:var(--s5)">
            <MembershipPanel
              slug={circle.slug}
              isPrivate={circle.isPrivate}
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
        label="Gatherings"
        title="What is coming up"
        id="gatherings"
        action={{ href: "/events", label: "Every gathering" }}
      >
        {nextDates.length === 0 ? (
          <EmptyState
            title="No gatherings scheduled."
            note={`${hostFirst} posts new dates here first. The other circles are running now.`}
            action={{ href: "/events", label: "Gatherings elsewhere" }}
          />
        ) : (
          <CardGrid wide={true}>
            {nextDates.map((e) => (
              <EventCard
                slug={e.slug} coverKey={e.coverKey}
                title={e.title}
                circleName={circle.name}
                city={e.city}
                venue={e.venue}
                when={formatDateRange(new Date(e.startsAt), new Date(e.endsAt))}
                placesLeft={e.placesLeft}
                category={circle.category}
              />
            ))}
          </CardGrid>
        )}
      </Section>

      <Section index={3} label="Passes" title="How a place is bought">
        <PassTable
          passes={toPassOffers(circle.slug, packages)}
          caption={`Passes for ${circle.name}`}
        />
        <p class="meta" style="margin-block-start:var(--s4)">
          One credit takes one place at one gathering. Cancel the place and the credit comes back.
        </p>
      </Section>

      <Section index={4} label="Archive" title="From the log">
        <div data-gallery="">
          {photos.length === 0 ? (
            <EmptyState
              title="No plates in the archive yet."
              note={`${hostFirst} adds them after each gathering.`}
            />
          ) : (
            <Gallery
              label={`${circle.name}, archive`}
              category={circle.category}
              items={toGalleryItems(photos)}
            />
          )}
        </div>
      </Section>

      <Section index={5} label="Members" title="Who is in this circle">
        <div data-members="">
          <MemberList
            members={otherMembers.map(toPerson)}
            total={circle.memberCount}
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

/* ------------------------------------------------------------ gatherings */

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
      circleName: e.circle.name,
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
  const events = await listEvents(c.env);
  const rows = upcoming(events, new Date());

  pageHeaders(c);
  return c.html(
    <Layout bodyClass="page-index"
      title={pageTitle("Gatherings", flash)}
      description="Every published gathering, soonest first, with the places left on each."
      user={layoutUser(me)}
      active="gatherings"
    >
      <FlashBanner flash={flash} />
      <Hero
        index="01"
        label="Gatherings"
        title="Gatherings"
        lede="Every published gathering, soonest first. The number on the right is how many places are left."
      />
      <Section
        index={2}
        label="Ledger"
        title="The dates"
        action={{ href: "/calendar", label: "By month" }}
      >
        {rows.length === 0 ? (
          <EmptyState
            title="No gatherings scheduled."
            note="Hosts post a season at a time. The circles list who is running what."
            action={{ href: "/circles", label: "The circles" }}
          />
        ) : (
          <Ledger groups={toLedgerGroups(rows)} />
        )}
      </Section>
    </Layout>,
  );
});

/* ------------------------------------------------------------- gathering */

type ActionInput = {
  signedIn: boolean;
  isPrivate: boolean;
  placesLeft: number;
  status: MembershipStatus | null;
  creditsLeft: number;
  bookedCode: string | null;
  hostFirstName: string;
  passes: PassOffer[];
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
 * checked before signed-out, because "Sign in to reserve" on a gathering with
 * no places is a dead end — the state belongs to the gathering, not to the
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
      : { kind: "join-public", passes: input.passes };
  }
  if (input.status === "pending") return { kind: "pending", hostFirstName: input.hostFirstName };
  if (input.creditsLeft > 0) {
    return {
      kind: "ready",
      bookAction: input.bookAction,
      creditsLeft: input.creditsLeft,
      creditsTotal: input.creditsLeft,
    };
  }
  return { kind: "no-credits", passes: input.passes };
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
          Other gatherings
        </Button>
      );
    default:
      return (
        <Button href="#reserve" variant="ghost">
          Take a pass
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
      "No such gathering",
      `Nothing here answers to "${slug}". The ledger lists every published date.`,
    );
  }
  const { event, circle } = found;

  // A draft belongs to its host and to nobody else — the public URL must not
  // leak one.
  if (event.status !== "published") {
    const maySee = me !== null && (await isCircleHost(c.env, circle.id, me.user.id));
    if (!maySee) {
      return notFoundPage(
        c,
        me,
        "No such gathering",
        "This date is not published. The ledger lists every gathering that is.",
      );
    }
  }

  const flash = await readFlash(c, me);
  const [packages, attendees, photos, circleEvents, membership, passes, bookings, circleRow] =
    await Promise.all([
      listPackages(c.env, circle.id),
      listEventAttendees(c.env, event.id),
      listEventPhotos(c.env, event.id),
      listEventsForCircle(c.env, circle.id),
      me ? getMembership(c.env, circle.id, me.user.id) : Promise.resolve(null),
      me ? listPassesForUser(c.env, me.user.id) : Promise.resolve([]),
      me ? listBookingsForUser(c.env, me.user.id) : Promise.resolve([]),
      getCircleBySlug(c.env, circle.slug),
    ]);

  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  const hostFirst = firstName(circleRow?.host.name ?? "");

  const creditsLeft = passes
    .filter((p) => p.circleSlug === circle.slug)
    .reduce((n, p) => n + p.creditsLeft, 0);
  const booked = bookings.find((b) => b.eventSlug === event.slug && b.status === "confirmed");
  const nextFromCircle = upcoming(circleEvents, new Date()).find((e) => e.slug !== event.slug);

  const here = `/events/${event.slug}`;
  const bookAction = `/events/${event.slug}/book`;
  const state = pickActionState({
    signedIn: me !== null,
    isPrivate: circle.isPrivate,
    placesLeft: event.placesLeft,
    status: membership?.status ?? null,
    creditsLeft,
    bookedCode: booked?.code ?? null,
    hostFirstName: hostFirst,
    passes: toPassOffers(circle.slug, packages, here),
    joinHref: `/join?next=${encodeURIComponent(here)}`,
    requestAction: `/circles/${circle.slug}/join`,
    bookAction,
    next: here,
    nextUp:
      nextFromCircle === undefined
        ? undefined
        : {
            title: nextFromCircle.title,
            when: formatDay(new Date(nextFromCircle.startsAt)),
            href: `/events/${nextFromCircle.slug}`,
          },
  });

  pageHeaders(c);
  return c.html(
    <Layout
      title={pageTitle(event.title, flash)}
      description={event.summary}
      user={layoutUser(me)}
      active="gatherings"
      actionBar={
        <ActionBar
          title={event.title}
          note={`1 credit · ${event.placesLeft} of ${event.capacity} places left`}
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
                  category={circle.category}
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
                  <dt class="micro">Circle</dt>
                  <dd>
                    <a href={`/circles/${circle.slug}`}>{circle.name}</a>
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
                circle={{ slug: circle.slug, name: circle.name }}
                placesLeft={event.placesLeft}
                capacity={event.capacity}
                state={state}
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
              category={circle.category}
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
        <Hero index="01" label="Calendar" title="Calendar" lede="Published gatherings, by day." />
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
      description="Every published gathering, laid out by the day it falls on."
      user={layoutUser(me)}
      active="calendar"
    >
      <FlashBanner flash={flash} />
      <Hero
        index="01"
        label="Calendar"
        title="Calendar"
        lede="Published gatherings by day. Days with nothing are left empty, which is most of them."
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
              Most people arrive here because a member told them to.
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
                  Membership costs nothing. You pay for passes, one circle at a time.
                </li>
                <li class="meta">
                  One credit takes one place. Cancel the place and the credit comes back.
                </li>
                <li class="meta">
                  Private circles are approved by the host, by hand, and can say no.
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
                confirm by email. Your account page holds your passes, your credits and your
                tickets.
              </p>
            </div>
          </div>
        </Container>
      </section>
    </Layout>
  );
}

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

pages.post("/auth/logout", async (c) => {
  await signOut(c);
  return c.redirect("/", 302);
});

pages.post("/circles/:slug/join", async (c) => {
  const slug = c.req.param("slug");
  const body = await c.req.parseBody();
  const next = safeNext(typeof body.next === "string" ? body.next : undefined);
  const back = next ?? `/circles/${slug}`;

  const me = await currentUser(c);
  if (!me) return c.redirect(`/join?next=${encodeURIComponent(back)}`, 302);

  const found = await getCircleBySlug(c.env, slug);
  if (!found) {
    return notFoundPage(c, me, "No such circle", `Nothing here answers to "${slug}".`);
  }
  const { circle, host } = found;

  // Both of these are "nothing happened", so they carry the `warn` tone: a
  // no-op rendered in the confirmation band reads as a second success.
  const membership = await getMembership(c.env, circle.id, me.user.id);
  if (membership?.status === "approved") {
    await setFlash(c.env, me.session.id, flashMessage("warn", `You are already in ${circle.name}.`));
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
  // parameterised statement, and the unique index on (circle, member) makes a
  // double submit a no-op rather than a second row.
  const status: MembershipStatus = circle.isPrivate ? "pending" : "approved";
  await getDb(c.env)
    .insert(circleMembers)
    .values({ id: newId(), circleId: circle.id, userId: me.user.id, role: "member", status })
    .onConflictDoNothing();

  await setFlash(
    c.env,
    me.session.id,
    flashMessage(
      "confirm",
      status === "approved"
        ? `You are in ${circle.name}. A pass buys the credits that take a place.`
        : `Your request is with ${firstName(host.name)}. ${circle.name} approves members by hand.`,
    ),
  );
  return c.redirect(back, 302);
});

export default pages;
