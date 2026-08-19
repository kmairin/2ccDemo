/**
 * The pieces every service in this folder shares: the row cap, and the two
 * counts the product keeps quoting back at people.
 *
 * `placesLeft` and `memberCount` appear on the directory, the community page, the
 * event page and the host console. They are defined once, here, because a
 * number that disagrees with itself across two pages is the kind of bug nobody
 * reports and everybody notices.
 */
import { and, eq, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { bookings, communityMembers, events } from "../schema";

/**
 * A dialect-only query builder: it compiles SQL and never connects to anything.
 *
 * This is what lets the count helpers below stay pure fragment builders — no
 * `env`, no `getDb`, no database — while still being built rather than written
 * out as text. Safe at module scope, which `getDb(env)` would not be
 * (AGENTS.md §5: build the client inside a handler).
 */
const qb = new QueryBuilder();

/** AGENTS.md §5: every query that could grow carries a LIMIT. */
export const DEFAULT_LIMIT = 50;
/** The ceiling a caller can raise `?limit=` to. */
export const MAX_LIMIT = 100;

/**
 * Clamp a limit that has already been validated (or was never supplied).
 * Routes reject a malformed `?limit=` with a 400 before calling a service;
 * this is the second line of defence for internal callers.
 */
export function boundLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

/**
 * The three counts below are correlated subqueries, and each is BUILT with `qb`
 * rather than written out inside a `sql` template. That is a correctness
 * requirement, not a style preference.
 *
 * Interpolating a Column into a `sql` template inside a `.select()` field list
 * makes Drizzle emit it **unqualified** when the surrounding query has a single
 * table, so `where ${communityMembers.communityId} = ${communities.id}` compiles to
 * `where "circle_id" = "id"` — and inside the subquery both bare names then
 * resolve against `circle_members`. Every row compares its own `circle_id` to
 * its own `id`, which is never true, so the count is 0 with no error anywhere.
 * That is exactly what it did: 0 members and 0 events on every community.
 *
 * Built through `qb` the same correlation compiles to
 * `"circle_members"."circle_id" = "communities"."id"` whether or not the outer
 * query joins — the qualification comes from the builder rather than from
 * guessing the outer query's shape. `test/service-count-sql.test.ts` pins it.
 *
 * `::int` because `count(*)` is a bigint and some drivers hand a bigint back as
 * a string; `mapWith(Number)` makes that impossible to observe either way.
 */

/** Confirmed bookings against one event. */
export function confirmedBookingCount(eventId: AnyColumn): SQL<number> {
  const sub = qb
    .select({ n: sql`count(*)::int` })
    .from(bookings)
    .where(and(eq(bookings.eventId, eventId), eq(bookings.status, "confirmed")));
  return sql<number>`(${sub})`.mapWith(Number);
}

/** Approved members of one community — the host's row included, it is a member row too. */
export function approvedMemberCount(communityId: AnyColumn): SQL<number> {
  const sub = qb
    .select({ n: sql`count(*)::int` })
    .from(communityMembers)
    .where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.status, "approved")));
  return sql<number>`(${sub})`.mapWith(Number);
}

/** Published events of one community. Drafts are invisible to members. */
export function publishedEventCount(communityId: AnyColumn): SQL<number> {
  const sub = qb
    .select({ n: sql`count(*)::int` })
    .from(events)
    .where(and(eq(events.communityId, communityId), eq(events.status, "published")));
  return sql<number>`(${sub})`.mapWith(Number);
}

/**
 * The one definition of "places left": capacity minus confirmed bookings, never
 * below zero. Every page that prints the number calls this.
 */
export function placesLeft(capacity: number, confirmed: number): number {
  return Math.max(0, Number(capacity) - Number(confirmed));
}

/** `2026-09-14` for a Date, in UTC — the key the calendar groups days by. */
export function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------- search and place */

/**
 * The longest `?q=` the search route accepts. Past this it is not a search,
 * it is a payload, and the route answers 400 rather than asking Postgres to
 * scan for a 4KB substring.
 */
export const SEARCH_MAX_LENGTH = 100;

/**
 * Turn a value the reader typed into a LIKE pattern.
 *
 * Drizzle parameterises the pattern, so nothing here is about injection —
 * `ilike(col, value)` never concatenates (AGENTS.md §5). It is about meaning:
 * inside a pattern `%` and `_` are wildcards, so a search for `100%` would
 * otherwise match every row, and `/cities/S_o Paulo` would resolve a city
 * nobody asked for. Postgres reads a backslash as the escape by default, and
 * the backslash itself has to be escaped first or it eats the one after it.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Case-insensitive equality, written as a wildcard-free pattern. */
export function likeExact(value: string): string {
  return escapeLike(value.trim());
}

/** Case-insensitive substring — the whole of `ilike` matching in this product. */
export function likeContains(value: string): string {
  return `%${escapeLike(value.trim())}%`;
}

/**
 * One definition of a place, used by the filter rows, the `?city=`/`?country=`
 * filters, the city and country pages and the search — for the same reason
 * `placesLeft` has one definition. Both are deliberately literal:
 *
 *   - a **community** is in the city and country its own columns name;
 *   - a **event** is in the city its own column names, and in the country
 *     of the community that runs it (`events` has no country of its own).
 *
 * So a Monaco community sailing out of Cap-d'Ail lists that event under
 * Cap-d'Ail, which is where it actually is, and under Monaco the country.
 * Every count on a page then equals the rows printed under it.
 */
export function placeKey(country: string, city: string): string {
  return `${country.trim().toLowerCase()}|${city.trim().toLowerCase()}`;
}

/** Countries and cities sort by name, so the index is stable between renders. */
export function byName<T>(pick: (row: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const left = pick(a);
    const right = pick(b);
    return left < right ? -1 : left > right ? 1 : 0;
  };
}
