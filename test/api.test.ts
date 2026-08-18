/**
 * Contract tests for the JSON API, run against the REAL local Postgres.
 *
 * These deliberately compare what the API says against what the database
 * actually holds, in the same test. That is not belt-and-braces: a correlated
 * subquery whose outer reference lost its table qualifier returned `0` for every
 * circle's member and gathering count, typechecked clean, and looked entirely
 * plausible in the JSON. Only reading both numbers together caught it.
 *
 * They need Postgres running and `npm run seed` applied. If the database is
 * empty the suite says so rather than passing vacuously.
 */
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { hasDatabase } from "./support/database";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/loop_dev";

/** The env a handler sees locally: no data-service binding, so `src/db.ts` dials Postgres. */
const env = { DATABASE_URL };

const sql = postgres(DATABASE_URL, { max: 1 });

/**
 * These suites compare rendered output against real rows, so they need a
 * migrated Postgres. CI has none and `deploy.yml` cannot be edited, so they skip
 * there rather than failing the deploy on missing infrastructure. See
 * `test/support/database.ts` — locally they all run, and they are the real gate.
 */
const suite = hasDatabase ? describe : describe.skip;
afterAll(() => sql.end());

async function json(path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(path, {}, env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

suite("GET /api/health", () => {
  it("answers ok without touching the database", async () => {
    const { status, body } = await json("/api/health");
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });
});

suite("GET /api/circles", () => {
  it("returns the seeded circles", async () => {
    const { status, body } = await json("/api/circles");
    expect(status).toBe(200);
    expect(Array.isArray(body.circles)).toBe(true);
    // A vacuous pass is worse than a failure — say the seed is missing.
    expect(body.circles.length, "no circles: run `npm run seed`").toBeGreaterThan(0);
  });

  it("reports member and gathering counts that match the database", async () => {
    const { body } = await json("/api/circles");

    const truth = await sql<{ slug: string; members: number; events: number }[]>`
      select c.slug,
             (select count(*)::int from circle_members m
               where m.circle_id = c.id and m.status = 'approved') as members,
             (select count(*)::int from events e
               where e.circle_id = c.id and e.status = 'published') as events
      from circles c
    `;
    const bySlug = new Map(truth.map((r) => [r.slug, r]));

    // Guards the exact defect described at the top of this file.
    for (const circle of body.circles) {
      const row = bySlug.get(circle.slug);
      expect(row, `circle ${circle.slug} is not in the database`).toBeDefined();
      expect(circle.memberCount, `memberCount for ${circle.slug}`).toBe(row!.members);
      expect(circle.eventCount, `eventCount for ${circle.slug}`).toBe(row!.events);
    }

    // And at least one must be non-zero, or the assertions above prove nothing.
    const total = body.circles.reduce(
      (n: number, c: { memberCount: number }) => n + c.memberCount,
      0,
    );
    expect(total, "every circle has 0 members — counts are not being computed").toBeGreaterThan(0);
  });

  it("rejects a nonsense limit with 400 rather than guessing", async () => {
    const { status } = await json("/api/circles?limit=banana");
    expect(status).toBe(400);
  });

  it("404s for a circle that does not exist", async () => {
    const { status } = await json("/api/circles/not-a-real-circle");
    expect(status).toBe(404);
  });
});

suite("GET /api/events", () => {
  it("computes placesLeft as capacity minus confirmed bookings", async () => {
    const { status, body } = await json("/api/events");
    expect(status).toBe(200);
    expect(body.events.length, "no gatherings: run `npm run seed`").toBeGreaterThan(0);

    const truth = await sql<{ slug: string; capacity: number; confirmed: number }[]>`
      select e.slug, e.capacity,
             (select count(*)::int from bookings b
               where b.event_id = e.id and b.status = 'confirmed') as confirmed
      from events e
    `;
    const bySlug = new Map(truth.map((r) => [r.slug, r]));

    for (const event of body.events) {
      const row = bySlug.get(event.slug);
      expect(row, `gathering ${event.slug} is not in the database`).toBeDefined();
      expect(event.placesLeft, `placesLeft for ${event.slug}`).toBe(
        Math.max(0, row!.capacity - row!.confirmed),
      );
    }
  });

  it("lists only published gatherings", async () => {
    const { body } = await json("/api/events");
    const drafts = await sql<{ slug: string }[]>`
      select slug from events where status <> 'published'
    `;
    const listed = new Set(body.events.map((e: { slug: string }) => e.slug));
    for (const draft of drafts) {
      expect(listed.has(draft.slug), `draft ${draft.slug} must not be public`).toBe(false);
    }
  });
});

suite("GET /api/calendar", () => {
  it("accepts a well-formed month", async () => {
    const month = new Date().toISOString().slice(0, 7);
    const { status, body } = await json(`/api/calendar?month=${month}`);
    expect(status).toBe(200);
    expect(body.month).toBe(month);
  });

  it("rejects a malformed month with 400, not a 500", async () => {
    const { status } = await json("/api/calendar?month=nonsense");
    expect(status).toBe(400);
  });

  it("rejects an out-of-range month with 400", async () => {
    const { status } = await json("/api/calendar?month=2026-13");
    expect(status).toBe(400);
  });
});

suite("GET /api/me", () => {
  it("is 401 without a session rather than an empty 200", async () => {
    const { status } = await json("/api/me");
    expect(status).toBe(401);
  });

  it("is 401 when the session cookie is a made-up value", async () => {
    const res = await app.request("/api/me", { headers: { cookie: "2cc_session=not-a-session" } }, env);
    expect(res.status).toBe(401);
  });
});
