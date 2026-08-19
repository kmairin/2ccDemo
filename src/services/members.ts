/**
 * The people in a community, the people coming to an event, and one member's
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
  communityMembers,
  communities,
  events,
  users,
  type CommunityCategory,
  type MemberRole,
  type MembershipStatus,
} from "../schema";
import { boundLimit } from "./common";

/** A member of a community, as the members strip and the host console show them. */
export interface CommunityMemberProfile {
  /** The `circle_members` row id — what the approve form posts to. */
  membershipId: string;
  userId: string;
  name: string;
  headline: string | null;
  city: string | null;
  role: MemberRole;
  status: MembershipStatus;
}

/** Someone with a confirmed place at an event. */
export interface AttendeeProfile {
  userId: string;
  name: string;
  headline: string | null;
  city: string | null;
}

/** One line of "communities I have joined", for `/api/me` and `/account`. */
export interface MembershipSummary {
  communitySlug: string;
  communityName: string;
  status: MembershipStatus;
  role: MemberRole;
}

const profileColumns = {
  membershipId: communityMembers.id,
  userId: users.id,
  name: users.name,
  headline: users.headline,
  city: users.city,
  role: communityMembers.role,
  status: communityMembers.status,
};

/** Host first, then in the order they joined. One `case` beats sorting in JS. */
const hostFirst = sql`case when ${communityMembers.role} = ${"host"} then 0 else 1 end`;

/**
 * The approved members of a community — the public list. Never returns a pending
 * or declined row, so a page cannot leak one by forgetting to filter.
 */
export async function listApprovedMembers(
  env: DatabaseEnv,
  communityId: string,
  options: { limit?: number } = {},
): Promise<CommunityMemberProfile[]> {
  const db = getDb(env);
  return db
    .select(profileColumns)
    .from(communityMembers)
    .innerJoin(users, eq(users.id, communityMembers.userId))
    .where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.status, "approved")))
    .orderBy(asc(hostFirst), asc(communityMembers.createdAt))
    .limit(boundLimit(options.limit));
}

/** The queue in the host console. Oldest request first — it has waited longest. */
export async function listPendingMembers(
  env: DatabaseEnv,
  communityId: string,
  options: { limit?: number } = {},
): Promise<CommunityMemberProfile[]> {
  const db = getDb(env);
  return db
    .select(profileColumns)
    .from(communityMembers)
    .innerJoin(users, eq(users.id, communityMembers.userId))
    .where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.status, "pending")))
    .orderBy(asc(communityMembers.createdAt))
    .limit(boundLimit(options.limit));
}

/** One member's standing in one community, or null if they have never asked. */
export async function getMembership(
  env: DatabaseEnv,
  communityId: string,
  userId: string,
): Promise<CommunityMemberProfile | null> {
  const db = getDb(env);
  const [row] = await db
    .select(profileColumns)
    .from(communityMembers)
    .innerJoin(users, eq(users.id, communityMembers.userId))
    .where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, userId)))
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

/** Every community this member has a row in, pending ones included — it is their own list. */
export async function listMembershipsForUser(
  env: DatabaseEnv,
  userId: string,
  options: { limit?: number } = {},
): Promise<MembershipSummary[]> {
  const db = getDb(env);
  return db
    .select({
      communitySlug: communities.slug,
      communityName: communities.name,
      status: communityMembers.status,
      role: communityMembers.role,
    })
    .from(communityMembers)
    .innerJoin(communities, eq(communities.id, communityMembers.communityId))
    .where(eq(communityMembers.userId, userId))
    .orderBy(asc(communityMembers.createdAt))
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

/** One community a member belongs to, as their profile lists it. Approved only. */
export interface MemberCommunity {
  slug: string;
  name: string;
  tagline: string;
  city: string;
  category: CommunityCategory;
  role: MemberRole;
}

/** A place this member holds at an event still to come. */
export interface MemberEvent {
  slug: string;
  title: string;
  venue: string;
  city: string;
  /** ISO 8601, UTC. The renderer decides the time zone, not the query. */
  startsAt: string;
  communitySlug: string;
  communityName: string;
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
 * The communities this member is in — **approved only**. A pending request is
 * between them and the host, and a public profile must not announce it.
 * `listMembershipsForUser` above is the member's own list and does include
 * pending ones; the two are not interchangeable.
 */
export async function listApprovedCommunitiesForMember(
  env: DatabaseEnv,
  userId: string,
  options: { limit?: number } = {},
): Promise<MemberCommunity[]> {
  const db = getDb(env);
  return db
    .select({
      slug: communities.slug,
      name: communities.name,
      tagline: communities.tagline,
      city: communities.city,
      category: communities.category,
      role: communityMembers.role,
    })
    .from(communityMembers)
    .innerJoin(communities, eq(communities.id, communityMembers.communityId))
    .where(and(eq(communityMembers.userId, userId), eq(communityMembers.status, "approved")))
    // Communities they run first, then in the order they joined — the same
    // ordering the members strip uses, for the same reason.
    .orderBy(asc(hostFirst), asc(communityMembers.createdAt))
    .limit(boundLimit(options.limit));
}

/**
 * Events this member is going to: confirmed bookings on published dates
 * that have not happened yet, soonest first. A cancelled booking and a draft
 * event both drop out in SQL rather than in the template.
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
      communitySlug: communities.slug,
      communityName: communities.name,
    })
    .from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId))
    .innerJoin(communities, eq(communities.id, events.communityId))
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
