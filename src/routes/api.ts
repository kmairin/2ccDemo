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
import { getCircleBySlug, listCirclePhotos, listCircles } from "../services/circles";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../services/common";
import {
  currentMonthKey,
  getEventBySlug,
  listCalendarMonth,
  listEventPhotos,
  listEvents,
  listEventsForCircle,
  parseMonth,
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

/** Liveness. Trivial and dependency-free so it answers even when the database is not. */
api.get("/health", async (c) => {
  // `?schema=1` reports how the one-time bootstrap went. Deployed there is no
  // console, so without this a half-applied bootstrap just looks like an app
  // that serves empty lists. Counts and our own SQL errors only.
  if (c.req.query("schema") === "1") {
    const { bootstrapReport } = await import("../ensure-schema");
    return c.json({ status: "ok", bootstrap: bootstrapReport });
  }
  return c.json({ status: "ok" });
});

/** The directory. `?category=` filters, `?limit=` bounds. */
api.get("/circles", async (c) => {
  const limit = readLimit(c);
  if (limit instanceof Response) return limit;
  const category = readCategory(c);
  if (category instanceof Response) return category;

  const circles = await listCircles(c.env, { category, limit });
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

/** Published gatherings, soonest first. `?circle=<slug>` filters. */
api.get("/events", async (c) => {
  const limit = readLimit(c);
  if (limit instanceof Response) return limit;

  const circleSlug = c.req.query("circle");
  if (circleSlug) {
    // A filter naming a circle that does not exist is a 404, not an empty list —
    // the two mean different things to whoever is reading the response.
    const circle = await getCircleBySlug(c.env, circleSlug);
    if (!circle) return c.json({ error: "Circle not found" }, 404);
  }

  const events = await listEvents(c.env, { circleSlug, limit });
  return c.json({ events });
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
