/**
 * A guard on the SHAPE of the SQL the count helpers emit.
 *
 * `test/api.test.ts` catches a wrong count by comparing it against the
 * database, which needs Postgres seeded. This file catches the same class of
 * bug with no database at all, by asserting the one property that was violated:
 * the correlation to the OUTER table must be table-qualified.
 *
 * The bug it pins: interpolating a Column into a `sql` template inside a
 * `.select()` field list makes Drizzle emit it unqualified when the outer query
 * has a single table, so `where "circle_id" = "id"` compared each
 * `circle_members` row to its own id, matched nothing, and reported 0 members
 * for every circle — typechecking clean and looking plausible in the JSON.
 */
import { QueryBuilder } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { circles, events } from "../src/schema";
import {
  approvedMemberCount,
  confirmedBookingCount,
  publishedEventCount,
} from "../src/services/common";

const qb = new QueryBuilder();

/** Single-table outer query — the shape that produced the bug. */
const circleCounts = qb
  .select({
    slug: circles.slug,
    memberCount: approvedMemberCount(circles.id),
    eventCount: publishedEventCount(circles.id),
  })
  .from(circles)
  .toSQL().sql;

/** Joined outer query — the shape that happened to escape it. */
const eventCounts = qb
  .select({ slug: events.slug, confirmed: confirmedBookingCount(events.id) })
  .from(events)
  .innerJoin(circles, undefined)
  .toSQL().sql;

describe("count fragments correlate to a qualified outer column", () => {
  it("qualifies the outer reference in a single-table query", () => {
    expect(circleCounts).toContain('"circle_members"."circle_id" = "circles"."id"');
    expect(circleCounts).toContain('"events"."circle_id" = "circles"."id"');
  });

  it("qualifies the outer reference in a joined query too", () => {
    expect(eventCounts).toContain('"bookings"."event_id" = "events"."id"');
  });

  it("never emits a bare unqualified correlation", () => {
    // This is the exact broken text: `"circle_id" = "id"`, with no table on
    // either side. If it ever reappears, every count silently becomes 0.
    for (const emitted of [circleCounts, eventCounts]) {
      expect(emitted).not.toMatch(/"(circle_id|event_id)" = "id"/);
    }
  });

  it("parameterises the status it filters on rather than inlining it", () => {
    expect(circleCounts).not.toContain("'approved'");
    expect(circleCounts).toMatch(/"circle_members"\."status" = \$\d+/);
  });
});
