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
import { CIRCLE_CATEGORIES, type CircleCategory } from "../schema";
import {
  getCircleBySlug,
  listCirclePhotos,
  listCircles,
  listCities,
  listCountries,
  searchCircles,
} from "../services/circles";
import { DEFAULT_LIMIT, MAX_LIMIT, SEARCH_MAX_LENGTH } from "../services/common";
import {
  currentMonthKey,
  getEventBySlug,
  listCalendarMonth,
  listEventPhotos,
  listEvents,
  listEventsForCircle,
  parseMonth,
  searchEvents,
} from "../services/events";
import { listEventAttendees, listApprovedMembers, listMembershipsForUser } from "../services/members";
import {
  listBookingsForUser,
  listHostedCircles,
  listPackages,
  listPassesForUser,
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
function readCategory(c: ApiContext): CircleCategory | undefined | Response {
  const raw = c.req.query("category");
  if (raw === undefined || raw === "") return undefined;
  if (!(CIRCLE_CATEGORIES as readonly string[]).includes(raw)) {
    return c.json({ error: `category must be one of: ${CIRCLE_CATEGORIES.join(", ")}` }, 400);
  }
  return raw as CircleCategory;
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
    return c.json({ status: "ok", bootstrap: bootstrapReport });
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
      out.circleColumns = (cols as unknown as unknown[]).map((r) =>
        Array.isArray(r) ? r[0] : Object.values(r as object)[0],
      );
    } catch (err) {
      out.circleColumnsError = err instanceof Error ? err.message : String(err);
    }
    try {
      const { listCircles } = await import("../services/circles");
      out.listCircles = (await listCircles(c.env, { limit: 2 })).length;
    } catch (err) {
      out.listCirclesError = (err instanceof Error ? err.message : String(err)).slice(0, 400);
    }
    return c.json({ status: "ok", probe: out });
  }
  return c.json({ status: "ok" });
});

/** The directory. `?category=`, `?city=` and `?country=` filter and compose; `?limit=` bounds. */
api.get("/circles", async (c) => {
  const limit = readLimit(c);
  if (limit instanceof Response) return limit;
  const category = readCategory(c);
  if (category instanceof Response) return category;
  const place = readPlace(c);

  const circles = await listCircles(c.env, { category, ...place, limit });
  return c.json({ circles });
});

/** One circle: the story, who runs it, what it sells, what is on, who is in, its plates. */
api.get("/circles/:slug", async (c) => {
  const limit = readLimit(c);
  if (limit instanceof Response) return limit;

  const found = await getCircleBySlug(c.env, c.req.param("slug"));
  if (!found) return c.json({ error: "Circle not found" }, 404);
  const { circle, host } = found;

  const [packages, events, members, photos] = await Promise.all([
    listPackages(c.env, circle.id),
    listEventsForCircle(c.env, circle.id, { limit }),
    listApprovedMembers(c.env, circle.id, { limit }),
    listCirclePhotos(c.env, circle.id, { limit }),
  ]);

  return c.json({
    circle,
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

/** Published gatherings, soonest first. `?circle=`, `?city=` and `?country=` filter. */
api.get("/events", async (c) => {
  const limit = readLimit(c);
  if (limit instanceof Response) return limit;
  const place = readPlace(c);

  const circleSlug = c.req.query("circle");
  if (circleSlug) {
    // A filter naming a circle that does not exist is a 404, not an empty list —
    // the two mean different things to whoever is reading the response.
    const circle = await getCircleBySlug(c.env, circleSlug);
    if (!circle) return c.json({ error: "Circle not found" }, 404);
  }

  const events = await listEvents(c.env, { circleSlug, ...place, limit });
  return c.json({ events });
});

/**
 * One field across the whole product: community names, taglines and
 * descriptions, gathering titles and summaries, and the names of cities and
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
    searchCircles(c.env, query, { limit }),
    searchEvents(c.env, query, { from: now, limit }),
    listCountries(c.env, { match: query, now, limit }),
    listCities(c.env, { match: query, now, limit }),
  ]);
  return c.json({ query, communities, events, countries, cities });
});

/** One gathering, with its circle, who is coming, and its plates. */
api.get("/events/:slug", async (c) => {
  const limit = readLimit(c);
  if (limit instanceof Response) return limit;

  const found = await getEventBySlug(c.env, c.req.param("slug"));
  if (!found) return c.json({ error: "Gathering not found" }, 404);
  const { event, circle } = found;

  const [attendees, photos] = await Promise.all([
    listEventAttendees(c.env, event.id, { limit }),
    listEventPhotos(c.env, event.id, { limit }),
  ]);

  return c.json({
    event,
    circle,
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
 * credits, so the keys and their types are fixed: `creditsTotal` and
 * `creditsUsed` are numbers, and `hosting` is in creation order.
 */
api.get("/me", async (c) => {
  const me = await requireApiUser(c);
  if (me instanceof Response) return me;

  const [memberships, passes, bookings, hosting] = await Promise.all([
    listMembershipsForUser(c.env, me.user.id),
    listPassesForUser(c.env, me.user.id),
    listBookingsForUser(c.env, me.user.id),
    listHostedCircles(c.env, me.user.id),
  ]);

  return c.json({
    user: { id: me.user.id, email: me.user.email, name: me.user.name },
    memberships: memberships.map((m) => ({ circleSlug: m.circleSlug, status: m.status })),
    passes: passes.map((p) => ({
      id: p.id,
      circleSlug: p.circleSlug,
      creditsTotal: p.creditsTotal,
      creditsUsed: p.creditsUsed,
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
