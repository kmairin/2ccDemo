/**
 * The pieces every service in this folder shares: the row cap, and the two
 * counts the product keeps quoting back at people.
 *
 * `placesLeft` and `memberCount` appear on the directory, the circle page, the
 * gathering page and the host console. They are defined once, here, because a
 * number that disagrees with itself across two pages is the kind of bug nobody
 * reports and everybody notices.
 */
import { and, eq, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { bookings, circleMembers, events } from "../schema";

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
 * table, so `where ${circleMembers.circleId} = ${circles.id}` compiles to
 * `where "circle_id" = "id"` — and inside the subquery both bare names then
 * resolve against `circle_members`. Every row compares its own `circle_id` to
 * its own `id`, which is never true, so the count is 0 with no error anywhere.
 * That is exactly what it did: 0 members and 0 gatherings on every circle.
 *
 * Built through `qb` the same correlation compiles to
 * `"circle_members"."circle_id" = "circles"."id"` whether or not the outer
 * query joins — the qualification comes from the builder rather than from
 * guessing the outer query's shape. `test/service-count-sql.test.ts` pins it.
 *
 * `::int` because `count(*)` is a bigint and some drivers hand a bigint back as
 * a string; `mapWith(Number)` makes that impossible to observe either way.
 */

/** Confirmed bookings against one gathering. */
export function confirmedBookingCount(eventId: AnyColumn): SQL<number> {
  const sub = qb
    .select({ n: sql`count(*)::int` })
    .from(bookings)
    .where(and(eq(bookings.eventId, eventId), eq(bookings.status, "confirmed")));
  return sql<number>`(${sub})`.mapWith(Number);
}

/** Approved members of one circle — the host's row included, it is a member row too. */
export function approvedMemberCount(circleId: AnyColumn): SQL<number> {
  const sub = qb
    .select({ n: sql`count(*)::int` })
    .from(circleMembers)
    .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.status, "approved")));
  return sql<number>`(${sub})`.mapWith(Number);
}

/** Published gatherings of one circle. Drafts are invisible to members. */
export function publishedEventCount(circleId: AnyColumn): SQL<number> {
  const sub = qb
    .select({ n: sql`count(*)::int` })
    .from(events)
    .where(and(eq(events.circleId, circleId), eq(events.status, "published")));
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
