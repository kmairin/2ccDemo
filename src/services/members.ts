/**
 * The people in a circle, and the people coming to a gathering.
 *
 * Two rules the product cares about live here rather than in a template:
 * pending members are never returned by the public list, and the host is always
 * first in it.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, type DatabaseEnv } from "../db";
import {
  bookings,
  circleMembers,
  circles,
  users,
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
