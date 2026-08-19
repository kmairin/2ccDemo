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
 * for every community — typechecking clean and looking plausible in the JSON.
 */
import { QueryBuilder } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { communities, events } from "../src/schema";
import {
  approvedMemberCount,
  confirmedBookingCount,
  publishedEventCount,
} from "../src/services/common";

const qb = new QueryBuilder();

/** Single-table outer query — the shape that produced the bug. */
const communityCounts = qb
  .select({
    slug: communities.slug,
    memberCount: approvedMemberCount(communities.id),
    eventCount: publishedEventCount(communities.id),
  })
  .from(communities)
  .toSQL().sql;

/** Joined outer query — the shape that happened to escape it. */
const eventCounts = qb
  .select({ slug: events.slug, confirmed: confirmedBookingCount(events.id) })
  .from(events)
  .innerJoin(communities, undefined)
  .toSQL().sql;

describe("count fragments correlate to a qualified outer column", () => {
  it("qualifies the outer reference in a single-table query", () => {
    expect(communityCounts).toContain('"circle_members"."circle_id" = "circles"."id"');
    expect(communityCounts).toContain('"events"."circle_id" = "circles"."id"');
  });

  it("qualifies the outer reference in a joined query too", () => {
    expect(eventCounts).toContain('"bookings"."event_id" = "events"."id"');
  });

  it("never emits a bare unqualified correlation", () => {
    // This is the exact broken text: `"circle_id" = "id"`, with no table on
    // either side. If it ever reappears, every count silently becomes 0.
    for (const emitted of [communityCounts, eventCounts]) {
      expect(emitted).not.toMatch(/"(circle_id|event_id)" = "id"/);
    }
  });

  it("parameterises the status it filters on rather than inlining it", () => {
    expect(communityCounts).not.toContain("'approved'");
    expect(communityCounts).toMatch(/"circle_members"\."status" = \$\d+/);
  });
});
