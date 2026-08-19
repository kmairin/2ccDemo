/**
 * The JSON API — `src/routes/api.ts`, mounted at `/api`:
 *
 *   app.route("/api", api);
 *
 * so the paths declared here are the contract's URLs
 * (`design/reference/api-contract.md`). The end-to-end gate drives these exact
 * URLs and keys; a rename is a gate failure, not a style choice.
 *
 * Handlers stay thin (AGENTS.md §8): validate what crossed the network, call a
 * service in `src/services/`, shape the response. Anything that reads the
 * database lives in a service, not here.
 */
import { Hono, type Context } from "hono";
import { requireApiUser, type AuthEnv } from "../auth";
import { COMMUNITY_CATEGORIES, type CommunityCategory } from "../schema";
import {
  getCommunityBySlug,
  listCommunityPhotos,
  listCommunities,
  listCities,
  listCountries,
  searchCommunities,
} from "../services/communities";
import { DEFAULT_LIMIT, MAX_LIMIT, SEARCH_MAX_LENGTH } from "../services/common";
import {
  currentMonthKey,
  getEventBySlug,
  listCalendarMonth,
  listEventPhotos,
  listEvents,
  listEventsForCommunity,
  parseMonth,
  searchEvents,
} from "../services/events";
import { listEventAttendees, listApprovedMembers, listMembershipsForUser } from "../services/members";
import {
  listBookingsForUser,
  listHostedCommunities,
  listPackages,
  listPackagesForUser,
} from "../services/commerce";

const api = new Hono<{ Bindings: AuthEnv }>();

type ApiContext = Context<{ Bindings: AuthEnv }>;

/**
 * `?limit=` — an integer from 1 to 100, defaulting to 50 (AGENTS.md §5). A
 * malformed one is a 400 with the range in it, never a silent fallback: a
 * caller asking for 500 rows should be told they cannot have them.
 *
 * Returns either the number or the 400 to send, so the handler reads:
 * `const limit = readLimit(c); if (limit instanceof Response) return limit;`
 */
function readLimit(c: ApiContext): number | Response {
  const raw = c.req.query("limit");
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    return c.json({ error: `limit must be a whole number between 1 and ${MAX_LIMIT}` }, 400);
  }
  return value;
}

/** `?category=` — one of the five, or a 400 that names them. */
function readCategory(c: ApiContext): CommunityCategory | undefined | Response {
  const raw = c.req.query("category");
  if (raw === undefined || raw === "") return undefined;
  if (!(COMMUNITY_CATEGORIES as readonly string[]).includes(raw)) {
    return c.json({ error: `category must be one of: ${COMMUNITY_CATEGORIES.join(", ")}` }, 400);
  }
  return raw as CommunityCategory;
}

/**
 * `?city=` and `?country=`. Unlike `?category=` these cannot be checked
 * against a list: geography comes from the data, so a new country appears the
 * moment a community is based in it. They are trimmed and bounded instead, and
 * a name nothing answers to returns an empty list rather than a 400 — an empty
 * result and a bad request mean different things to whoever is reading this.
 */
function readPlace(c: ApiContext): { city?: string; country?: string } {
  const clean = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed === "") return undefined;
    return trimmed.slice(0, SEARCH_MAX_LENGTH);
  };
  return { city: clean(c.req.query("city")), country: clean(c.req.query("country")) };
}

/** Liveness. Trivial and dependency-free so it answers even when the database is not. */
api.get("/health", async (c) => {
  // `?schema=1` reports how the one-time bootstrap went. Deployed there is no
  // console, so without this a half-applied bootstrap just looks like an app
  // that serves empty lists. Counts and our own SQL errors only.
  if (c.req.query("schema") === "1") {
    const { bootstrapReport } = await import("../ensure-schema");
    // Also dump app_meta and the row counts. Three fixes in a row have been
    // aimed at a bootstrap whose internal state was invisible from outside, and
    // each guess cost a deploy cycle. Bookkeeping values and counts only.
    const meta: Record<string, string> = {};
    const counts: Record<string, number> = {};
    try {
      const { getDb } = await import("../db");
      const { sql } = await import("drizzle-orm");
      const db = getDb(c.env);
      const rows = (await db.execute(
        sql`select "key", "value" from "app_meta" order by "key"`,
      )) as unknown as unknown[];
      for (const r of rows) {
        const [k, v] = Array.isArray(r) ? r : Object.values(r as object);
        meta[String(k)] = String(v);
      }
      // SQL names, not UI names. `communities` was in this list for a while and
      // reported -1 on every request, which read as a broken table when the
      // table is simply called `circles` (src/schema.ts).
      for (const t of [
        "circles",
        "events",
        "packages",
        "photos",
        "bookings",
        "wallets",
        "wallet_txns",
      ]) {
        try {
          const n = (await db.execute(sql.raw(`select count(*)::int from "${t}"`))) as unknown as unknown[];
          const first = n[0];
          counts[t] = Number(Array.isArray(first) ? first[0] : Object.values(first as object)[0]);
        } catch {
          counts[t] = -1;
        }
      }
    } catch (err) {
      meta.error = err instanceof Error ? err.message.slice(0, 160) : String(err);
    }

    /**
     * The wallet read the header middleware does, and its error in full.
     *
     * Deployed, every signed-in page 500d while every signed-out page was fine,
     * which narrows it to this one query — and there is no console here to ask
     * why. Reports the table's real columns beside the failure so a mismatch
     * between the bundle and the database is visible in one request.
     */
    const wallet: Record<string, unknown> = {};
    try {
      const { getDb } = await import("../db");
      const { sql } = await import("drizzle-orm");
      const db = getDb(c.env);
      const cols = (await db.execute(
        sql`select "column_name" from "information_schema"."columns"
            where "table_schema" = 'public' and "table_name" = 'wallets'
            order by "ordinal_position"`,
      )) as unknown as unknown[];
      wallet.columns = cols.map((r) =>
        String(Array.isArray(r) ? r[0] : Object.values(r as object)[0]),
      );
      await db.execute(
        sql.raw(`select "balance_cents", "currency" from "wallets" where "user_id" = '_probe' limit 1`),
      );
      wallet.select = "ok";
    } catch (err) {
      const cause = (err as { cause?: unknown } | undefined)?.cause;
      wallet.select = `${err instanceof Error ? err.message : String(err)}${
        cause ? ` | cause: ${cause instanceof Error ? cause.message : String(cause)}` : ""
      }`.slice(0, 400);
    }

    return c.json({ status: "ok", bootstrap: bootstrapReport, meta, counts, wallet });
  }

  // TEMPORARY diagnostic. `?schema=1` reports what the isolate ANSWERING IT has
  // done, and this route is the one route that never builds anything — so it
  // kept answering with an empty report while the pages next door were failing,
  // which is worse than no diagnostic at all. This runs one bounded step and
  // reports that step's own failures, on the same isolate, so the database's
  // error text can actually be read from outside. Bounded by the same budget
  // and deadline as any page request. Remove with the rest of the scaffolding.
  if (c.req.query("bootstrap") === "1") {
    const { ensureSchema, bootstrapReport } = await import("../ensure-schema");
    await ensureSchema(c.env);
    return c.json({ status: "ok", bootstrap: bootstrapReport });
  }

  // TEMPORARY diagnostic. Deployed there is no console and no way to run a
  // query by hand, so when a page 500s the only alternative is guessing at the
  // schema. Reports column names and the error text of the query the directory
  // actually runs. No user data. Remove with the rest of the bootstrap
  // scaffolding.
  if (c.req.query("probe") === "1") {
    const { getDb } = await import("../db");
    const { sql } = await import("drizzle-orm");
    const db = getDb(c.env);
    const out: Record<string, unknown> = {};
    try {
      const cols = await db.execute(
        sql`select "column_name" from "information_schema"."columns"
            where "table_name" = 'circles' order by "column_name"`,
      );
      out.communityColumns = (cols as unknown as unknown[]).map((r) =>
        Array.isArray(r) ? r[0] : Object.values(r as object)[0],
      );
    } catch (err) {
      out.communityColumnsError = err instanceof Error ? err.message : String(err);
    }
    try {
      const { listCommunities } = await import("../services/communities");
      out.listCommunities = (await listCommunities(c.env, { limit: 2 })).length;
    } catch (err) {
      out.listCommunitiesError = (err instanceof Error ? err.message : String(err)).slice(0, 400);
    }
    return c.json({ status: "ok", probe: out });
  }
  return c.json({ status: "ok" });
});

/** The directory. `?category=`, `?city=` and `?country=` filter and compose; `?limit=` bounds. */
api.get("/communities", async (c) => {
  const limit = readLimit(c);
  if (limit instanceof Response) return limit;
  const category = readCategory(c);
  if (category instanceof Response) return category;
  const place = readPlace(c);

  const communities = await listCommunities(c.env, { category, ...place, limit });
  return c.json({ communities });
});

/** One community: the story, who runs it, what it sells, what is on, who is in, its plates. */
api.get("/communities/:slug", async (c) => {
  const limit = readLimit(c);
  if (limit instanceof Response) return limit;

  const found = await getCommunityBySlug(c.env, c.req.param("slug"));
  if (!found) return c.json({ error: "Community not found" }, 404);
  const { community, host } = found;

  const [packages, events, members, photos] = await Promise.all([
    listPackages(c.env, community.id),
    listEventsForCommunity(c.env, community.id, { limit }),
    listApprovedMembers(c.env, community.id, { limit }),
    listCommunityPhotos(c.env, community.id, { limit }),
  ]);

  return c.json({
    community,
    host: { name: host.name, headline: host.headline },
    packages,
    events,
    members: members.map((m) => ({
      name: m.name,
      headline: m.headline,
      city: m.city,
      role: m.role,
    })),
    photos,
  });
});

/** Published events, soonest first. `?community=`, `?city=` and `?country=` filter. */
api.get("/events", async (c) => {
  const limit = readLimit(c);
  if (limit instanceof Response) return limit;
  const place = readPlace(c);

  const communitySlug = c.req.query("community");
  if (communitySlug) {
    // A filter naming a community that does not exist is a 404, not an empty list —
    // the two mean different things to whoever is reading the response.
    const community = await getCommunityBySlug(c.env, communitySlug);
    if (!community) return c.json({ error: "Community not found" }, 404);
  }

  const events = await listEvents(c.env, { communitySlug, ...place, limit });
  return c.json({ events });
});

/**
 * One field across the whole product: community names, taglines and
 * descriptions, event titles and summaries, and the names of cities and
 * countries. Case-insensitive substring, grouped, each group bounded by the
 * same `?limit=` as every other list.
 *
 * An empty `q` is an empty result, not a 400 — the page behind this renders a
 * prompt for it. Past `SEARCH_MAX_LENGTH` it is a payload rather than a search.
 */
api.get("/search", async (c) => {
  const limit = readLimit(c);
  if (limit instanceof Response) return limit;

  const raw = c.req.query("q") ?? "";
  if (raw.length > SEARCH_MAX_LENGTH) {
    return c.json({ error: `q must be ${SEARCH_MAX_LENGTH} characters or fewer` }, 400);
  }

  const query = raw.trim();
  if (query === "") {
    return c.json({ query, communities: [], events: [], countries: [], cities: [] });
  }

  const now = new Date();
  const [communities, events, countries, cities] = await Promise.all([
    searchCommunities(c.env, query, { limit }),
    searchEvents(c.env, query, { from: now, limit }),
    listCountries(c.env, { match: query, now, limit }),
    listCities(c.env, { match: query, now, limit }),
  ]);
  return c.json({ query, communities, events, countries, cities });
});

/** One event, with its community, who is coming, and its plates. */
api.get("/events/:slug", async (c) => {
  const limit = readLimit(c);
  if (limit instanceof Response) return limit;

  const found = await getEventBySlug(c.env, c.req.param("slug"));
  if (!found) return c.json({ error: "Event not found" }, 404);
  const { event, community } = found;

  const [attendees, photos] = await Promise.all([
    listEventAttendees(c.env, event.id, { limit }),
    listEventPhotos(c.env, event.id, { limit }),
  ]);

  return c.json({
    event,
    community,
    attendees: attendees.map((a) => ({ name: a.name, headline: a.headline })),
    photos,
  });
});

/**
 * One month of the calendar. `?month=YYYY-MM`, absent means this month, and
 * anything else is a 400 rather than a quiet fallback — a typo in the URL
 * should not look like an empty month.
 */
api.get("/calendar", async (c) => {
  const limit = readLimit(c);
  if (limit instanceof Response) return limit;

  const raw = c.req.query("month") ?? currentMonthKey(new Date());
  const parsed = parseMonth(raw);
  if (!parsed) return c.json({ error: "month must be in YYYY-MM form, e.g. 2026-09" }, 400);

  const days = await listCalendarMonth(c.env, parsed.year, parsed.month, { limit });
  return c.json({
    month: `${parsed.year}-${String(parsed.month).padStart(2, "0")}`,
    days,
  });
});

/**
 * The signed-in member's own state. This is what the gate reads to check
 * tickets, so the keys and their types are fixed: `ticketsTotal` and
 * `ticketsUsed` are numbers, and `hosting` is in creation order.
 */
api.get("/me", async (c) => {
  const me = await requireApiUser(c);
  if (me instanceof Response) return me;

  const [memberships, packages, bookings, hosting] = await Promise.all([
    listMembershipsForUser(c.env, me.user.id),
    listPackagesForUser(c.env, me.user.id),
    listBookingsForUser(c.env, me.user.id),
    listHostedCommunities(c.env, me.user.id),
  ]);

  return c.json({
    user: { id: me.user.id, email: me.user.email, name: me.user.name },
    memberships: memberships.map((m) => ({ communitySlug: m.communitySlug, status: m.status })),
    packages: packages.map((p) => ({
      id: p.id,
      communitySlug: p.communitySlug,
      ticketsTotal: p.ticketsTotal,
      ticketsUsed: p.ticketsUsed,
    })),
    bookings: bookings.map((b) => ({
      code: b.code,
      eventSlug: b.eventSlug,
      status: b.status,
    })),
    hosting: hosting.map((h) => ({ slug: h.slug, name: h.name })),
  });
});

export default api;
