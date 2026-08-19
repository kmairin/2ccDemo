/**
 * Reading communities: the directory, one community, and its plate gallery.
 *
 * Every function takes `env` and returns typed rows. No Hono, no Response, no
 * formatting — routes shape the answer, these just fetch it.
 */
import { and, asc, count, eq, gte, ilike, or, sql, type SQL } from "drizzle-orm";
import { getDb, type DatabaseEnv } from "../db";
import { communities, events, photos, users, type CommunityCategory } from "../schema";
import {
  approvedMemberCount,
  boundLimit,
  byName,
  likeContains,
  likeExact,
  placeKey,
  publishedEventCount,
} from "./common";

/** A community as the directory shows it. Matches the contract's list item. */
export interface CommunitySummary {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  city: string;
  country: string;
  category: CommunityCategory;
  isPrivate: boolean;
  coverKey: string | null;
  /** Approved members, the host included. Same number everywhere it appears. */
  memberCount: number;
  /** Published events. Drafts are invisible to members. */
  eventCount: number;
}

/** The community page needs the story too. */
export interface CommunityDetail extends CommunitySummary {
  description: string;
}

/** Who runs it. `id` is for the "must host it" check; the JSON prints the rest. */
export interface CommunityHost {
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
  id: communities.id,
  slug: communities.slug,
  name: communities.name,
  tagline: communities.tagline,
  city: communities.city,
  country: communities.country,
  category: communities.category,
  isPrivate: communities.isPrivate,
  coverKey: communities.coverKey,
  memberCount: approvedMemberCount(communities.id),
  eventCount: publishedEventCount(communities.id),
};

/**
 * The directory, oldest community first so the order is stable between renders.
 *
 * `category` is already validated by the caller — it is a column filter, not a
 * search. `city` and `country` cannot be, because they come from the data
 * rather than from a fixed list (a new country appears the moment a community
 * is added there), so they are matched case-insensitively and an unknown one
 * is an empty list rather than an error. The three compose.
 */
export async function listCommunities(
  env: DatabaseEnv,
  options: {
    category?: CommunityCategory;
    city?: string;
    country?: string;
    limit?: number;
  } = {},
): Promise<CommunitySummary[]> {
  const db = getDb(env);
  const rows = await db
    .select(summaryColumns)
    .from(communities)
    .where(and(...communityFilters(options)))
    .orderBy(asc(communities.createdAt))
    .limit(boundLimit(options.limit));
  return rows.map(toSummary);
}

/**
 * The `where` behind both the directory and the counts below, so a filtered
 * list and the number printed above it can never drift apart. `ilike` with a
 * wildcard-free pattern is case-insensitive equality, and Drizzle parameterises
 * the pattern (AGENTS.md §5) — nothing here is concatenated into SQL.
 */
function communityFilters(options: {
  category?: CommunityCategory;
  city?: string;
  country?: string;
}): SQL[] {
  const filters: SQL[] = [];
  if (options.category) filters.push(eq(communities.category, options.category));
  if (options.city) filters.push(ilike(communities.city, likeExact(options.city)));
  if (options.country) filters.push(ilike(communities.country, likeExact(options.country)));
  return filters;
}

/**
 * Free-text search over the communities: name, tagline, description, city and
 * country. Case-insensitive substring, which is all this product needs and all
 * a reader expects from one field.
 *
 * Every term goes through `ilike` as a bound parameter. There is no string
 * concatenation anywhere in this query, which is the rule that keeps injection
 * out (AGENTS.md §5).
 */
export async function searchCommunities(
  env: DatabaseEnv,
  term: string,
  options: { limit?: number } = {},
): Promise<CommunitySummary[]> {
  const trimmed = term.trim();
  if (trimmed === "") return [];
  const pattern = likeContains(trimmed);
  const db = getDb(env);
  const rows = await db
    .select(summaryColumns)
    .from(communities)
    .where(
      or(
        ilike(communities.name, pattern),
        ilike(communities.tagline, pattern),
        ilike(communities.description, pattern),
        ilike(communities.city, pattern),
        ilike(communities.country, pattern),
      ),
    )
    .orderBy(asc(communities.createdAt))
    .limit(boundLimit(options.limit));
  return rows.map(toSummary);
}

/* ------------------------------------------------------------- geography */

/**
 * Geography is read from the data and never from a list in the code: adding a
 * community in a new country is the whole of what it takes for that country to
 * appear here, on `/countries`, in the filter rows and in the search.
 *
 * Country is the primary axis and city the drill-down, so both counts hang off
 * the same two queries: what is based here, and what is on here next.
 */

/** One city, with what is in it. `eventCount` is upcoming and published only. */
export interface CitySummary {
  city: string;
  country: string;
  communityCount: number;
  eventCount: number;
}

/** One country, with its cities and what is in them. */
export interface CountrySummary {
  country: string;
  cityCount: number;
  communityCount: number;
  eventCount: number;
}

/** `count(*)` on a grouped select, as a number rather than a driver's bigint. */
const groupCount = count().mapWith(Number);

/**
 * Every city that has a community based in it or an event coming up in it.
 *
 * `match` narrows to cities whose name contains it — that is how the search
 * page finds "Bang" — and `country` narrows to one country's cities, which is
 * the drill-down `/countries/:country` draws. Both are optional and compose.
 */
export async function listCities(
  env: DatabaseEnv,
  options: { country?: string; match?: string; now?: Date; limit?: number } = {},
): Promise<CitySummary[]> {
  const db = getDb(env);
  const from = options.now ?? new Date();
  const cap = boundLimit(options.limit);

  const communityWhere: SQL[] = [];
  const eventWhere: SQL[] = [eq(events.status, "published"), gte(events.startsAt, from)];
  if (options.country) {
    communityWhere.push(ilike(communities.country, likeExact(options.country)));
    eventWhere.push(ilike(communities.country, likeExact(options.country)));
  }
  if (options.match) {
    communityWhere.push(ilike(communities.city, likeContains(options.match)));
    eventWhere.push(ilike(events.city, likeContains(options.match)));
  }

  const [communityRows, eventRows] = await Promise.all([
    db
      .select({ city: communities.city, country: communities.country, n: groupCount })
      .from(communities)
      .where(and(...communityWhere))
      .groupBy(communities.city, communities.country)
      .orderBy(asc(communities.country), asc(communities.city))
      .limit(cap),
    // An event is in the city its own column names; its country comes from
    // the community that runs it, because `events` has none of its own.
    db
      .select({ city: events.city, country: communities.country, n: groupCount })
      .from(events)
      .innerJoin(communities, eq(communities.id, events.communityId))
      .where(and(...eventWhere))
      .groupBy(events.city, communities.country)
      .orderBy(asc(communities.country), asc(events.city))
      .limit(cap),
  ]);

  const byCity = new Map<string, CitySummary>();
  const put = (city: string, country: string): CitySummary => {
    const key = placeKey(country, city);
    let row = byCity.get(key);
    if (row === undefined) {
      row = { city, country, communityCount: 0, eventCount: 0 };
      byCity.set(key, row);
    }
    return row;
  };
  for (const row of communityRows) put(row.city, row.country).communityCount = Number(row.n);
  for (const row of eventRows) put(row.city, row.country).eventCount = Number(row.n);

  return [...byCity.values()].sort(byName((row) => `${row.country}|${row.city}`));
}

/**
 * Every country that has something, with its city, community and upcoming
 * event counts — the index `/countries` draws.
 *
 * A country exists here because a community is based in it: an event
 * belongs to a community, and the community is what carries the country, so the two
 * sets cannot disagree.
 */
export async function listCountries(
  env: DatabaseEnv,
  options: { match?: string; now?: Date; limit?: number } = {},
): Promise<CountrySummary[]> {
  const db = getDb(env);
  const from = options.now ?? new Date();
  const cap = boundLimit(options.limit);
  const match = options.match ? ilike(communities.country, likeContains(options.match)) : undefined;

  const [communityRows, eventRows, cityRows] = await Promise.all([
    db
      .select({ country: communities.country, n: groupCount })
      .from(communities)
      .where(match)
      .groupBy(communities.country)
      .orderBy(asc(communities.country))
      .limit(cap),
    db
      .select({ country: communities.country, n: groupCount })
      .from(events)
      .innerJoin(communities, eq(communities.id, events.communityId))
      .where(and(eq(events.status, "published"), gte(events.startsAt, from), match))
      .groupBy(communities.country)
      .orderBy(asc(communities.country))
      .limit(cap),
    // Cities per country, counted the same way `listCities` builds them, so
    // the number on the index equals the rows the country page prints.
    listCities(env, { match: undefined, now: from, limit: cap }),
  ]);

  const byCountry = new Map<string, CountrySummary>();
  const put = (country: string): CountrySummary => {
    const key = country.trim().toLowerCase();
    let row = byCountry.get(key);
    if (row === undefined) {
      row = { country, cityCount: 0, communityCount: 0, eventCount: 0 };
      byCountry.set(key, row);
    }
    return row;
  };
  for (const row of communityRows) put(row.country).communityCount = Number(row.n);
  for (const row of eventRows) put(row.country).eventCount = Number(row.n);
  for (const city of cityRows) {
    const key = city.country.trim().toLowerCase();
    // Only cities of a country that survived `match`; a name filter on the
    // country must not drag in cities from the ones it excluded.
    const row = byCountry.get(key);
    if (row !== undefined) row.cityCount += 1;
  }

  return [...byCountry.values()].sort(byName((row) => row.country));
}

/**
 * The cap the two lookups below read the index at. They resolve one name out
 * of it, so the bound is on how many distinct places this product can hold and
 * still answer `/countries/:country` correctly, not on a page of results.
 */
const MAX_PLACES = 100;

/** One country by name, case-insensitively, or null when nothing is there. */
export async function getCountry(
  env: DatabaseEnv,
  country: string,
  options: { now?: Date } = {},
): Promise<CountrySummary | null> {
  const wanted = country.trim().toLowerCase();
  if (wanted === "") return null;
  const rows = await listCountries(env, { match: country, now: options.now, limit: MAX_PLACES });
  return rows.find((row) => row.country.trim().toLowerCase() === wanted) ?? null;
}

/** One city by name, case-insensitively, or null when nothing is there. */
export async function getCity(
  env: DatabaseEnv,
  city: string,
  options: { now?: Date } = {},
): Promise<CitySummary | null> {
  const wanted = city.trim().toLowerCase();
  if (wanted === "") return null;
  const rows = await listCities(env, { match: city, now: options.now, limit: MAX_PLACES });
  return rows.find((row) => row.city.trim().toLowerCase() === wanted) ?? null;
}

/** One community by its URL segment, with the member who runs it. */
export async function getCommunityBySlug(
  env: DatabaseEnv,
  slug: string,
): Promise<{ community: CommunityDetail; host: CommunityHost } | null> {
  const db = getDb(env);
  const [row] = await db
    .select({
      ...summaryColumns,
      description: communities.description,
      hostId: users.id,
      hostName: users.name,
      hostHeadline: users.headline,
      hostCity: users.city,
    })
    .from(communities)
    .innerJoin(users, eq(users.id, communities.hostUserId))
    .where(eq(communities.slug, slug))
    .limit(1);
  if (!row) return null;

  return {
    community: { ...toSummary(row), description: row.description },
    host: {
      id: row.hostId,
      name: row.hostName,
      headline: row.hostHeadline,
      city: row.hostCity,
    },
  };
}

/**
 * The gallery for a community. 4–8 plates in practice; the cap is here because
 * nothing stops a host adding more.
 */
export async function listCommunityPhotos(
  env: DatabaseEnv,
  communityId: string,
  options: { limit?: number } = {},
): Promise<PhotoPlate[]> {
  const db = getDb(env);
  return db
    .select({ caption: photos.caption, seed: photos.seed, objectKey: photos.objectKey })
    .from(photos)
    .where(eq(photos.communityId, communityId))
    .orderBy(asc(photos.sortOrder), asc(photos.createdAt))
    .limit(boundLimit(options.limit));
}

/**
 * Does this member run this community? One indexed lookup — the host console asks
 * it on every request, and a wrong answer here is a 403 that should have been
 * a page.
 */
export async function isCommunityHost(
  env: DatabaseEnv,
  communityId: string,
  userId: string,
): Promise<boolean> {
  const db = getDb(env);
  const [row] = await db
    .select({ one: sql<number>`1`.mapWith(Number) })
    .from(communities)
    .where(and(eq(communities.id, communityId), eq(communities.hostUserId, userId)))
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
  category: CommunityCategory;
  isPrivate: boolean;
  coverKey: string | null;
  memberCount: number;
  eventCount: number;
}): CommunitySummary {
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
