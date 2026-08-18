/**
 * The people in a circle, the people coming to a gathering, and one member's
 * own profile.
 *
 * Three rules the product cares about live here rather than in a template:
 * pending members are never returned by the public list, the host is always
 * first in it, and **no function in this file ever selects `users.email`**. The
 * email is the identity (see `src/auth.ts`); a public profile that printed it
 * would hand every member's address to anyone who opened the page.
 */
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { getDb, type DatabaseEnv } from "../db";
import {
  bookings,
  circleMembers,
  circles,
  events,
  users,
  type CircleCategory,
  type MemberRole,
  type MembershipStatus,
} from "../schema";
import { boundLimit } from "./common";

/** A member of a circle, as the members strip and the host console show them. */
export interface CircleMemberProfile {
  /** The `circle_members` row id — what the approve form posts to. */
  membershipId: string;
  userId: string;
  name: string;
  headline: string | null;
  city: string | null;
  role: MemberRole;
  status: MembershipStatus;
}

/** Someone with a confirmed place at a gathering. */
export interface AttendeeProfile {
  userId: string;
  name: string;
  headline: string | null;
  city: string | null;
}

/** One line of "circles I have joined", for `/api/me` and `/account`. */
export interface MembershipSummary {
  circleSlug: string;
  circleName: string;
  status: MembershipStatus;
  role: MemberRole;
}

const profileColumns = {
  membershipId: circleMembers.id,
  userId: users.id,
  name: users.name,
  headline: users.headline,
  city: users.city,
  role: circleMembers.role,
  status: circleMembers.status,
};

/** Host first, then in the order they joined. One `case` beats sorting in JS. */
const hostFirst = sql`case when ${circleMembers.role} = ${"host"} then 0 else 1 end`;

/**
 * The approved members of a circle — the public list. Never returns a pending
 * or declined row, so a page cannot leak one by forgetting to filter.
 */
export async function listApprovedMembers(
  env: DatabaseEnv,
  circleId: string,
  options: { limit?: number } = {},
): Promise<CircleMemberProfile[]> {
  const db = getDb(env);
  return db
    .select(profileColumns)
    .from(circleMembers)
    .innerJoin(users, eq(users.id, circleMembers.userId))
    .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.status, "approved")))
    .orderBy(asc(hostFirst), asc(circleMembers.createdAt))
    .limit(boundLimit(options.limit));
}

/** The queue in the host console. Oldest request first — it has waited longest. */
export async function listPendingMembers(
  env: DatabaseEnv,
  circleId: string,
  options: { limit?: number } = {},
): Promise<CircleMemberProfile[]> {
  const db = getDb(env);
  return db
    .select(profileColumns)
    .from(circleMembers)
    .innerJoin(users, eq(users.id, circleMembers.userId))
    .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.status, "pending")))
    .orderBy(asc(circleMembers.createdAt))
    .limit(boundLimit(options.limit));
}

/** One member's standing in one circle, or null if they have never asked. */
export async function getMembership(
  env: DatabaseEnv,
  circleId: string,
  userId: string,
): Promise<CircleMemberProfile | null> {
  const db = getDb(env);
  const [row] = await db
    .select(profileColumns)
    .from(circleMembers)
    .innerJoin(users, eq(users.id, circleMembers.userId))
    .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * Who is coming. Confirmed bookings only — a cancelled booking keeps its row so
 * the ticket history survives, and must never show up here.
 */
export async function listEventAttendees(
  env: DatabaseEnv,
  eventId: string,
  options: { limit?: number } = {},
): Promise<AttendeeProfile[]> {
  const db = getDb(env);
  return db
    .select({
      userId: users.id,
      name: users.name,
      headline: users.headline,
      city: users.city,
    })
    .from(bookings)
    .innerJoin(users, eq(users.id, bookings.userId))
    .where(and(eq(bookings.eventId, eventId), eq(bookings.status, "confirmed")))
    .orderBy(asc(bookings.createdAt))
    .limit(boundLimit(options.limit));
}

/** Every circle this member has a row in, pending ones included — it is their own list. */
export async function listMembershipsForUser(
  env: DatabaseEnv,
  userId: string,
  options: { limit?: number } = {},
): Promise<MembershipSummary[]> {
  const db = getDb(env);
  return db
    .select({
      circleSlug: circles.slug,
      circleName: circles.name,
      status: circleMembers.status,
      role: circleMembers.role,
    })
    .from(circleMembers)
    .innerJoin(circles, eq(circles.id, circleMembers.circleId))
    .where(eq(circleMembers.userId, userId))
    .orderBy(asc(circleMembers.createdAt))
    .limit(boundLimit(options.limit));
}

/* ------------------------------------------------- one member's own profile */

/**
 * A member as their public profile shows them.
 *
 * There is deliberately no `email` field. `users.email` is the sign-in
 * identity, and the only place it is ever printed is the member's own account
 * page, from their own session — never from here, and never from
 * `/members/:id`.
 */
export interface MemberProfile {
  id: string;
  name: string;
  headline: string | null;
  city: string | null;
  bio: string | null;
}

/** One circle a member belongs to, as their profile lists it. Approved only. */
export interface MemberCircle {
  slug: string;
  name: string;
  tagline: string;
  city: string;
  category: CircleCategory;
  role: MemberRole;
}

/** A place this member holds at a gathering still to come. */
export interface MemberEvent {
  slug: string;
  title: string;
  venue: string;
  city: string;
  /** ISO 8601, UTC. The renderer decides the time zone, not the query. */
  startsAt: string;
  circleSlug: string;
  circleName: string;
}

/** The four columns a member may change about themselves. */
export interface ProfileEdit {
  name: string;
  headline: string | null;
  city: string | null;
  bio: string | null;
}

/**
 * One member by id, or null when the id names nobody — which is what makes
 * `/members/:id` a 404 rather than a blank page. The column list is explicit
 * so `email` cannot arrive here by widening a `select()`.
 */
export async function getMemberProfile(
  env: DatabaseEnv,
  userId: string,
): Promise<MemberProfile | null> {
  const db = getDb(env);
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      headline: users.headline,
      city: users.city,
      bio: users.bio,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

/**
 * The circles this member is in — **approved only**. A pending request is
 * between them and the host, and a public profile must not announce it.
 * `listMembershipsForUser` above is the member's own list and does include
 * pending ones; the two are not interchangeable.
 */
export async function listApprovedCirclesForMember(
  env: DatabaseEnv,
  userId: string,
  options: { limit?: number } = {},
): Promise<MemberCircle[]> {
  const db = getDb(env);
  return db
    .select({
      slug: circles.slug,
      name: circles.name,
      tagline: circles.tagline,
      city: circles.city,
      category: circles.category,
      role: circleMembers.role,
    })
    .from(circleMembers)
    .innerJoin(circles, eq(circles.id, circleMembers.circleId))
    .where(and(eq(circleMembers.userId, userId), eq(circleMembers.status, "approved")))
    // Circles they run first, then in the order they joined — the same
    // ordering the members strip uses, for the same reason.
    .orderBy(asc(hostFirst), asc(circleMembers.createdAt))
    .limit(boundLimit(options.limit));
}

/**
 * Gatherings this member is going to: confirmed bookings on published dates
 * that have not happened yet, soonest first. A cancelled booking and a draft
 * gathering both drop out in SQL rather than in the template.
 */
export async function listUpcomingEventsForMember(
  env: DatabaseEnv,
  userId: string,
  now: Date,
  options: { limit?: number } = {},
): Promise<MemberEvent[]> {
  const db = getDb(env);
  const rows = await db
    .select({
      slug: events.slug,
      title: events.title,
      venue: events.venue,
      city: events.city,
      startsAt: events.startsAt,
      circleSlug: circles.slug,
      circleName: circles.name,
    })
    .from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId))
    .innerJoin(circles, eq(circles.id, events.circleId))
    .where(
      and(
        eq(bookings.userId, userId),
        eq(bookings.status, "confirmed"),
        eq(events.status, "published"),
        gte(events.startsAt, now),
      ),
    )
    .orderBy(asc(events.startsAt))
    .limit(boundLimit(options.limit));

  return rows.map((row) => ({ ...row, startsAt: row.startsAt.toISOString() }));
}

/**
 * Save what a member typed about themselves. One statement, so there is
 * nothing for `batch()` to make atomic — and the empty optional fields are
 * stored as NULL rather than `""`, so a profile shows a line or shows nothing
 * instead of showing a blank one.
 *
 * The caller validates and trims (see `src/routes/profile.tsx`); this writes.
 */
export async function updateMemberProfile(
  env: DatabaseEnv,
  userId: string,
  edit: ProfileEdit,
): Promise<void> {
  const db = getDb(env);
  await db
    .update(users)
    .set({ name: edit.name, headline: edit.headline, city: edit.city, bio: edit.bio })
    .where(eq(users.id, userId));
}
