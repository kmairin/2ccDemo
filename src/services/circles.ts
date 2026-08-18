/**
 * Reading circles: the directory, one circle, and its plate gallery.
 *
 * Every function takes `env` and returns typed rows. No Hono, no Response, no
 * formatting — routes shape the answer, these just fetch it.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, type DatabaseEnv } from "../db";
import { circles, photos, users, type CircleCategory } from "../schema";
import { approvedMemberCount, boundLimit, publishedEventCount } from "./common";

/** A circle as the directory shows it. Matches the contract's list item. */
export interface CircleSummary {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  city: string;
  country: string;
  category: CircleCategory;
  isPrivate: boolean;
  coverKey: string | null;
  /** Approved members, the host included. Same number everywhere it appears. */
  memberCount: number;
  /** Published gatherings. Drafts are invisible to members. */
  eventCount: number;
}

/** The circle page needs the story too. */
export interface CircleDetail extends CircleSummary {
  description: string;
}

/** Who runs it. `id` is for the "must host it" check; the JSON prints the rest. */
export interface CircleHost {
  id: string;
  name: string;
  headline: string | null;
  city: string | null;
}

/**
 * One plate in a gallery. `objectKey` is the upgrade path: null renders a
 * generated plate, set renders `<img src="/assets/…">` from the bucket, so
 * dropping real photographs into `design/assets/` later swaps them in with no
 * code change.
 */
type PhotoRow = typeof photos.$inferSelect;
export interface PhotoPlate {
  caption: PhotoRow["caption"];
  seed: PhotoRow["seed"];
  objectKey: PhotoRow["objectKey"];
}

/**
 * The columns the directory reads, plus the two counts, in one round trip.
 * Pure SQL fragments — nothing here touches the database, so it is safe at
 * module scope (AGENTS.md §5: the client is built inside a handler).
 */
const summaryColumns = {
  id: circles.id,
  slug: circles.slug,
  name: circles.name,
  tagline: circles.tagline,
  city: circles.city,
  country: circles.country,
  category: circles.category,
  isPrivate: circles.isPrivate,
  coverKey: circles.coverKey,
  memberCount: approvedMemberCount(circles.id),
  eventCount: publishedEventCount(circles.id),
};

/**
 * The directory, oldest circle first so the order is stable between renders.
 * `category` is already validated by the caller — it is a column filter, not a
 * search.
 */
export async function listCircles(
  env: DatabaseEnv,
  options: { category?: CircleCategory; limit?: number } = {},
): Promise<CircleSummary[]> {
  const db = getDb(env);
  const rows = await db
    .select(summaryColumns)
    .from(circles)
    .where(options.category ? eq(circles.category, options.category) : undefined)
    .orderBy(asc(circles.createdAt))
    .limit(boundLimit(options.limit));
  return rows.map(toSummary);
}

/** One circle by its URL segment, with the member who runs it. */
export async function getCircleBySlug(
  env: DatabaseEnv,
  slug: string,
): Promise<{ circle: CircleDetail; host: CircleHost } | null> {
  const db = getDb(env);
  const [row] = await db
    .select({
      ...summaryColumns,
      description: circles.description,
      hostId: users.id,
      hostName: users.name,
      hostHeadline: users.headline,
      hostCity: users.city,
    })
    .from(circles)
    .innerJoin(users, eq(users.id, circles.hostUserId))
    .where(eq(circles.slug, slug))
    .limit(1);
  if (!row) return null;

  return {
    circle: { ...toSummary(row), description: row.description },
    host: {
      id: row.hostId,
      name: row.hostName,
      headline: row.hostHeadline,
      city: row.hostCity,
    },
  };
}

/**
 * The gallery for a circle. 4–8 plates in practice; the cap is here because
 * nothing stops a host adding more.
 */
export async function listCirclePhotos(
  env: DatabaseEnv,
  circleId: string,
  options: { limit?: number } = {},
): Promise<PhotoPlate[]> {
  const db = getDb(env);
  return db
    .select({ caption: photos.caption, seed: photos.seed, objectKey: photos.objectKey })
    .from(photos)
    .where(eq(photos.circleId, circleId))
    .orderBy(asc(photos.sortOrder), asc(photos.createdAt))
    .limit(boundLimit(options.limit));
}

/**
 * Does this member run this circle? One indexed lookup — the host console asks
 * it on every request, and a wrong answer here is a 403 that should have been
 * a page.
 */
export async function isCircleHost(
  env: DatabaseEnv,
  circleId: string,
  userId: string,
): Promise<boolean> {
  const db = getDb(env);
  const [row] = await db
    .select({ one: sql<number>`1`.mapWith(Number) })
    .from(circles)
    .where(and(eq(circles.id, circleId), eq(circles.hostUserId, userId)))
    .limit(1);
  return row !== undefined;
}

/** Shared by both selects above — the counts arrive as numbers, keep them that way. */
function toSummary(row: {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  city: string;
  country: string;
  category: CircleCategory;
  isPrivate: boolean;
  coverKey: string | null;
  memberCount: number;
  eventCount: number;
}): CircleSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    city: row.city,
    country: row.country,
    category: row.category,
    isPrivate: row.isPrivate,
    coverKey: row.coverKey,
    memberCount: Number(row.memberCount),
    eventCount: Number(row.eventCount),
  };
}
