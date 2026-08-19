/**
 * Reading events: the list, one event, a community's events, and the
 * month the calendar draws.
 *
 * `placesLeft` is computed here from `placesLeft()` in `./common`, never
 * open-coded, so the directory, the event page and the calendar all print
 * the same number.
 */
import { and, asc, eq, gte, ilike, lt, or, type SQL } from "drizzle-orm";
import { getDb, type DatabaseEnv } from "../db";
import { communities, events, photos, type EventStatus } from "../schema";
import {
  boundLimit,
  confirmedBookingCount,
  likeContains,
  likeExact,
  placesLeft,
  utcDateKey,
} from "./common";
import type { PhotoPlate } from "./communities";

/** An event as a card shows it. Matches the contract's list item. */
export interface EventSummary {
  id: string;
  slug: string;
  title: string;
  summary: string;
  venue: string;
  city: string;
  /** ISO 8601, UTC. The renderer decides the time zone, not the query. */
  startsAt: string;
  endsAt: string;
  capacity: number;
  coverKey: string | null;
  /** capacity − confirmed bookings, floored at zero. */
  placesLeft: number;
  community: { slug: string; name: string };
}

/** The event page needs the long copy and the status as well. */
export interface EventDetail extends EventSummary {
  description: string;
  status: EventStatus;
  communityId: string;
}

/** The community an event belongs to, as the event page kicker needs it. */
export interface EventCommunity {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  city: string;
  country: string;
  category: string;
  isPrivate: boolean;
}

/** One day of the calendar grid. Days with nothing keep an empty list. */
export interface CalendarDay {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  events: EventSummary[];
}

/**
 * Pure SQL fragments — `confirmedBookingCount` is a built subquery (see
 * `./common`) and touches no database, so this is safe at module scope.
 */
const summaryColumns = {
  coverKey: events.coverKey,
  id: events.id,
  slug: events.slug,
  title: events.title,
  summary: events.summary,
  venue: events.venue,
  city: events.city,
  startsAt: events.startsAt,
  endsAt: events.endsAt,
  capacity: events.capacity,
  confirmed: confirmedBookingCount(events.id),
  communitySlug: communities.slug,
  communityName: communities.name,
};

type SummaryRow = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  venue: string;
  city: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  coverKey: string | null;
  confirmed: number;
  communitySlug: string;
  communityName: string;
};

function toSummary(row: SummaryRow): EventSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    venue: row.venue,
    city: row.city,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    capacity: Number(row.capacity),
    coverKey: row.coverKey,
    placesLeft: placesLeft(row.capacity, row.confirmed),
    community: { slug: row.communitySlug, name: row.communityName },
  };
}

/**
 * Published only, soonest first.
 *
 * `communitySlug` narrows it to one community. `city` is where the event is
 * actually held; `country` is the country of the community that runs it, because
 * `events` carries no country of its own — the one definition of a place, set
 * out in `./common`. `from` drops anything that has already started, in SQL,
 * so a count taken from this list is a count of what is still to come.
 *
 * All four compose, and all four are parameterised through Drizzle. Neither
 * city nor country can be validated against a fixed list: they come from the
 * data, so a name nothing answers to is an empty list, not an error.
 */
export async function listEvents(
  env: DatabaseEnv,
  options: {
    communitySlug?: string;
    city?: string;
    country?: string;
    from?: Date;
    limit?: number;
  } = {},
): Promise<EventSummary[]> {
  const db = getDb(env);
  const filters: SQL[] = [eq(events.status, "published")];
  if (options.communitySlug) filters.push(eq(communities.slug, options.communitySlug));
  if (options.city) filters.push(ilike(events.city, likeExact(options.city)));
  if (options.country) filters.push(ilike(communities.country, likeExact(options.country)));
  if (options.from) filters.push(gte(events.startsAt, options.from));

  const rows = await db
    .select(summaryColumns)
    .from(events)
    .innerJoin(communities, eq(communities.id, events.communityId))
    .where(and(...filters))
    .orderBy(asc(events.startsAt), asc(events.slug))
    .limit(boundLimit(options.limit));
  return rows.map(toSummary);
}

/**
 * Free-text search over the events: title, summary, city, and the country
 * of the community that runs it, so "Thailand" finds the evening in Bangkok.
 * Published only, soonest first — a search result you cannot book is noise.
 *
 * `ilike` binds every pattern as a parameter; nothing here is concatenated
 * into SQL (AGENTS.md §5).
 */
export async function searchEvents(
  env: DatabaseEnv,
  term: string,
  options: { from?: Date; limit?: number } = {},
): Promise<EventSummary[]> {
  const trimmed = term.trim();
  if (trimmed === "") return [];
  const pattern = likeContains(trimmed);
  const db = getDb(env);

  const filters: SQL[] = [eq(events.status, "published")];
  if (options.from) filters.push(gte(events.startsAt, options.from));
  const matched = or(
    ilike(events.title, pattern),
    ilike(events.summary, pattern),
    ilike(events.city, pattern),
    ilike(events.venue, pattern),
    ilike(communities.country, pattern),
  );
  if (matched) filters.push(matched);

  const rows = await db
    .select(summaryColumns)
    .from(events)
    .innerJoin(communities, eq(communities.id, events.communityId))
    .where(and(...filters))
    .orderBy(asc(events.startsAt), asc(events.slug))
    .limit(boundLimit(options.limit));
  return rows.map(toSummary);
}

/** A community's own events, for the community page. Published only. */
export async function listEventsForCommunity(
  env: DatabaseEnv,
  communityId: string,
  options: { limit?: number } = {},
): Promise<EventSummary[]> {
  const db = getDb(env);
  const rows = await db
    .select(summaryColumns)
    .from(events)
    .innerJoin(communities, eq(communities.id, events.communityId))
    .where(and(eq(events.communityId, communityId), eq(events.status, "published")))
    .orderBy(asc(events.startsAt), asc(events.slug))
    .limit(boundLimit(options.limit));
  return rows.map(toSummary);
}

/**
 * One event by slug, with its community. Any status — a draft is still
 * reachable by its host, and the caller decides what to do with that.
 */
export async function getEventBySlug(
  env: DatabaseEnv,
  slug: string,
): Promise<{ event: EventDetail; community: EventCommunity } | null> {
  const db = getDb(env);
  const [row] = await db
    .select({
      ...summaryColumns,
      description: events.description,
      status: events.status,
    coverKey: events.coverKey,
      communityId: communities.id,
      communityTagline: communities.tagline,
      communityCity: communities.city,
      communityCountry: communities.country,
      communityCategory: communities.category,
      communityIsPrivate: communities.isPrivate,
    })
    .from(events)
    .innerJoin(communities, eq(communities.id, events.communityId))
    .where(eq(events.slug, slug))
    .limit(1);
  if (!row) return null;

  return {
    event: {
      ...toSummary(row),
      description: row.description,
      status: row.status,
      communityId: row.communityId,
    },
    community: {
      id: row.communityId,
      slug: row.communitySlug,
      name: row.communityName,
      tagline: row.communityTagline,
      city: row.communityCity,
      country: row.communityCountry,
      category: row.communityCategory,
      isPrivate: row.communityIsPrivate,
    },
  };
}

/** The gallery for an event. 3–5 plates in practice. */
export async function listEventPhotos(
  env: DatabaseEnv,
  eventId: string,
  options: { limit?: number } = {},
): Promise<PhotoPlate[]> {
  const db = getDb(env);
  return db
    .select({ caption: photos.caption, seed: photos.seed, objectKey: photos.objectKey })
    .from(photos)
    .where(eq(photos.eventId, eventId))
    .orderBy(asc(photos.sortOrder), asc(photos.createdAt))
    .limit(boundLimit(options.limit));
}

/* --------------------------------------------------------------- calendar */

/** `2026-09` and nothing else. Years are bounded so a typo cannot ask for year 0. */
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * Parse `?month=YYYY-MM`. Returns null for anything else, which the route turns
 * into a 400 — never a 500, and never a silent fallback to this month.
 */
export function parseMonth(raw: string): { year: number; month: number } | null {
  const match = MONTH_RE.exec(raw.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1970 || year > 2999) return null;
  return { year, month };
}

/** `YYYY-MM` for a Date in UTC — the default when `?month=` is absent. */
export function currentMonthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/**
 * Every day of one month, each with its published events in time order.
 *
 * Empty days are present with an empty list: the month view draws a grid, and a
 * missing key there is a hole rather than a quiet evening. Grouping is by UTC
 * date, the same zone `src/lib/format.ts` defaults to.
 */
export async function listCalendarMonth(
  env: DatabaseEnv,
  year: number,
  month: number,
  options: { limit?: number } = {},
): Promise<CalendarDay[]> {
  const db = getDb(env);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const until = new Date(Date.UTC(year, month, 1));

  const rows = await db
    .select(summaryColumns)
    .from(events)
    .innerJoin(communities, eq(communities.id, events.communityId))
    .where(
      and(
        eq(events.status, "published"),
        gte(events.startsAt, from),
        lt(events.startsAt, until),
      ),
    )
    .orderBy(asc(events.startsAt), asc(events.slug))
    .limit(boundLimit(options.limit));

  const byDay = new Map<string, EventSummary[]>();
  // `Date.UTC(year, month, 0)` is the last day of `month` — its date is the
  // number of days in it, leap years included.
  const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= dayCount; day++) {
    byDay.set(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, []);
  }
  for (const row of rows) {
    byDay.get(utcDateKey(row.startsAt))?.push(toSummary(row));
  }

  return [...byDay.entries()].map(([date, dayEvents]) => ({ date, events: dayEvents }));
}
