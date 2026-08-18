/**
 * Reading gatherings: the list, one gathering, a circle's gatherings, and the
 * month the calendar draws.
 *
 * `placesLeft` is computed here from `placesLeft()` in `./common`, never
 * open-coded, so the directory, the gathering page and the calendar all print
 * the same number.
 */
import { and, asc, eq, gte, lt, type SQL } from "drizzle-orm";
import { getDb, type DatabaseEnv } from "../db";
import { circles, events, photos, type EventStatus } from "../schema";
import { boundLimit, confirmedBookingCount, placesLeft, utcDateKey } from "./common";
import type { PhotoPlate } from "./circles";

/** A gathering as a card shows it. Matches the contract's list item. */
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
  /**
   * The cover photograph's storage key, or null to fall back to the generated
   * plate. Always null at present: the deployed database refuses every ALTER
   * TABLE, so the `cover_key` column exists locally but cannot be added to
   * production. Kept in the shape so the UI is ready when the cover moves onto
   * the `photos` table, which needs no schema change.
   */
  coverKey: string | null;
  /** capacity − confirmed bookings, floored at zero. */
  placesLeft: number;
  circle: { slug: string; name: string };
}

/** The gathering page needs the long copy and the status as well. */
export interface EventDetail extends EventSummary {
  description: string;
  status: EventStatus;
  circleId: string;
}

/** The circle a gathering belongs to, as the gathering page kicker needs it. */
export interface EventCircle {
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
  circleSlug: circles.slug,
  circleName: circles.name,
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
  confirmed: number;
  circleSlug: string;
  circleName: string;
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
    coverKey: null,
    placesLeft: placesLeft(row.capacity, row.confirmed),
    circle: { slug: row.circleSlug, name: row.circleName },
  };
}

/** Published only, soonest first. `circleSlug` narrows it to one circle. */
export async function listEvents(
  env: DatabaseEnv,
  options: { circleSlug?: string; limit?: number } = {},
): Promise<EventSummary[]> {
  const db = getDb(env);
  const filters: SQL[] = [eq(events.status, "published")];
  if (options.circleSlug) filters.push(eq(circles.slug, options.circleSlug));

  const rows = await db
    .select(summaryColumns)
    .from(events)
    .innerJoin(circles, eq(circles.id, events.circleId))
    .where(and(...filters))
    .orderBy(asc(events.startsAt), asc(events.slug))
    .limit(boundLimit(options.limit));
  return rows.map(toSummary);
}

/** A circle's own gatherings, for the circle page. Published only. */
export async function listEventsForCircle(
  env: DatabaseEnv,
  circleId: string,
  options: { limit?: number } = {},
): Promise<EventSummary[]> {
  const db = getDb(env);
  const rows = await db
    .select(summaryColumns)
    .from(events)
    .innerJoin(circles, eq(circles.id, events.circleId))
    .where(and(eq(events.circleId, circleId), eq(events.status, "published")))
    .orderBy(asc(events.startsAt), asc(events.slug))
    .limit(boundLimit(options.limit));
  return rows.map(toSummary);
}

/**
 * One gathering by slug, with its circle. Any status — a draft is still
 * reachable by its host, and the caller decides what to do with that.
 */
export async function getEventBySlug(
  env: DatabaseEnv,
  slug: string,
): Promise<{ event: EventDetail; circle: EventCircle } | null> {
  const db = getDb(env);
  const [row] = await db
    .select({
      ...summaryColumns,
      description: events.description,
      status: events.status,
        circleId: circles.id,
      circleTagline: circles.tagline,
      circleCity: circles.city,
      circleCountry: circles.country,
      circleCategory: circles.category,
      circleIsPrivate: circles.isPrivate,
    })
    .from(events)
    .innerJoin(circles, eq(circles.id, events.circleId))
    .where(eq(events.slug, slug))
    .limit(1);
  if (!row) return null;

  return {
    event: {
      ...toSummary(row),
      description: row.description,
      status: row.status,
      circleId: row.circleId,
    },
    circle: {
      id: row.circleId,
      slug: row.circleSlug,
      name: row.circleName,
      tagline: row.circleTagline,
      city: row.circleCity,
      country: row.circleCountry,
      category: row.circleCategory,
      isPrivate: row.circleIsPrivate,
    },
  };
}

/** The gallery for a gathering. 3–5 plates in practice. */
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
 * Every day of one month, each with its published gatherings in time order.
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
    .innerJoin(circles, eq(circles.id, events.circleId))
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
