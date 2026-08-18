/**
 * The deployed bootstrap, tested against the failure that took the site down.
 *
 * Production spent **157 seconds inside one page request** and then answered
 * 500, on every page, for hours. The cause was not bad SQL — the same 468
 * statements apply cleanly in 0.1s against local Postgres. It was that the
 * build was unbounded: when `batch` fails, every statement is retried on its own
 * round trip, and 468 round trips exhaust a Worker's per-request subrequest
 * allowance and wall clock, so the page's own query had nothing left to spend
 * and threw.
 *
 * So the invariant worth defending is not "the bootstrap succeeds" — it is
 * **"one request does a bounded amount of work, whatever the database does"**.
 * That is what the first test here pins, by making every batch fail.
 *
 * Runs against its own database so it can drop and rebuild without disturbing
 * `loop_dev`, which the dev server and the rest of the suite are using.
 */
import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";

const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/loop_dev";
const TEST_DB = "loop_bootstrap_test";
const TEST_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);

/** Every batch fails, which is the deployed behaviour this file exists for. */
const batchAlwaysFails = vi.hoisted(() => ({ on: false }));
vi.mock("../src/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db")>();
  return {
    ...actual,
    batch: async (...args: Parameters<typeof actual.batch>) => {
      if (batchAlwaysFails.on) throw new Error("batch unavailable");
      return actual.batch(...args);
    },
  };
});

const { BOOTSTRAP_STATEMENTS } = await import("../src/bootstrap-sql");
const { ensureSchema, bootstrapReport, resetEnsureSchemaForTests, ROUNDTRIP_BUDGET } =
  await import("../src/ensure-schema");

const SCHEMA_ONLY = BOOTSTRAP_STATEMENTS.filter(
  (s) =>
    !/^(DELETE FROM|INSERT INTO)/i.test(s) &&
    !/SET \(schema_locked/i.test(s) &&
    !/^ALTER TABLE/i.test(s),
);
const DATA_TOTAL = BOOTSTRAP_STATEMENTS.filter((s) =>
  /^(DELETE FROM|INSERT INTO)/i.test(s),
).length;

/**
 * Availability is decided at module scope, not in `beforeAll`.
 *
 * `describe.runIf` is evaluated when the file is collected, which happens
 * before any hook runs — so a flag set in `beforeAll` is still false when it is
 * read, and the whole suite reports as SKIPPED while looking green.
 */
async function makeTestDatabase(): Promise<boolean> {
  const admin = postgres(ADMIN_URL, { max: 1, connect_timeout: 3 });
  try {
    await admin.unsafe(`create database ${TEST_DB}`);
    return true;
  } catch (err) {
    // Already there from an earlier run is fine; unreachable Postgres is not.
    return /already exists/i.test(err instanceof Error ? err.message : String(err));
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {});
  }
}

const available = await makeTestDatabase();
const client = available ? postgres(TEST_URL, { max: 1, connect_timeout: 3 }) : undefined!;
const env = { DATABASE_URL: TEST_URL };

if (!available) {
  console.warn("\n  \u26a0 No reachable Postgres — the bootstrap suite is SKIPPED.\n");
}

afterAll(async () => {
  await client?.end({ timeout: 1 }).catch(() => {});
});

/**
 * Put the database in the state production was actually in: every table
 * present with the right columns, **zero rows**, and no bookkeeping.
 */
async function asProduction(): Promise<void> {
  await client.unsafe(`drop schema public cascade; create schema public;`);
  for (const s of SCHEMA_ONLY) await client.unsafe(s).catch(() => {});
  await client.unsafe(`delete from app_meta`);
  resetEnsureSchemaForTests();
  bootstrapReport.applied = 0;
  bootstrapReport.failed = 0;
  bootstrapReport.failures.length = 0;
}

const rows = async (table: string): Promise<number> =>
  Number((await client.unsafe(`select count(*)::int as n from ${table}`))[0].n);

describe.runIf(available)("the deployed bootstrap", () => {
  it("does a bounded amount of work per request even when every batch fails", async () => {
    await asProduction();
    batchAlwaysFails.on = true;
    try {
      const before = Date.now();
      await ensureSchema(env);
      const elapsed = Date.now() - before;

      // THE regression. Unbounded, this request executes all 468 data
      // statements one at a time — which deployed cost 157 seconds and the
      // whole site. Each statement is one round trip, so the count of
      // statements touched is the count of round trips spent.
      const touched = bootstrapReport.applied + bootstrapReport.failed;
      expect(touched).toBeLessThanOrEqual(ROUNDTRIP_BUDGET);
      expect(touched).toBeLessThan(DATA_TOTAL);
      expect(bootstrapReport.budgetExhausted).toBe(true);
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      batchAlwaysFails.on = false;
    }
  });

  it("resumes across requests until the world is complete", async () => {
    await asProduction();
    batchAlwaysFails.on = true;
    try {
      /**
       * Each request is a fresh isolate doing its own bounded slice. A degraded
       * database makes the load take more requests; it must never make it stop.
       *
       * Progress is the sum of both cursors, because the early requests are
       * spending their budget rebuilding the schema and have not reached the
       * data yet — that is work, and it has to count as work, or a suite that
       * demands rows on request two fails a bootstrap that is behaving.
       */
      const progress = async (): Promise<number> => {
        const meta = await client.unsafe(`select key, value from app_meta`);
        const at = (key: string) => {
          const row = meta.find((m) => m.key === key);
          return row ? Number(String(row.value).split(":")[1] ?? 0) : 0;
        };
        return at("reset_cursor") + at("data_cursor");
      };

      let last = -1;
      let requests = 0;
      for (; requests < 200; requests++) {
        resetEnsureSchemaForTests();
        await ensureSchema(env);
        const now = await progress();
        expect(now).toBeGreaterThan(last); // never stalls
        last = now;
        const done = (
          await client.unsafe(`select value from app_meta where key = 'seed_version'`)
        )[0]?.value;
        if (done === bootstrapReport.version) break;
      }

      expect(requests).toBeLessThan(199);
      expect(await rows("circles")).toBe(6);
      expect(await rows("events")).toBe(23);
      expect(await rows("bookings")).toBe(116);
      expect(await rows("photos")).toBe(123);
    } finally {
      batchAlwaysFails.on = false;
    }
    // Deliberately the slow path: ~28 requests, every statement on its own
    // round trip, each of which opens and closes a local connection.
  }, 120_000);

  it("builds the whole world in one request when the database is healthy", async () => {
    await asProduction();
    await ensureSchema(env);

    expect(await rows("circles")).toBe(6);
    expect(await rows("events")).toBe(23);
    expect(await rows("photos")).toBe(123);
    const version = (
      await client.unsafe(`select value from app_meta where key = 'seed_version'`)
    )[0]?.value;
    expect(version).toBe(bootstrapReport.version);
  });

  it("costs nothing once the world is complete", async () => {
    await asProduction();
    await ensureSchema(env);

    // Same isolate, already settled: no further statements, no round trips.
    const applied = bootstrapReport.applied;
    await ensureSchema(env);
    await ensureSchema(env);
    expect(bootstrapReport.applied).toBe(applied);
  });

  it("lets a second isolate serve the page instead of queueing behind a rebuild", async () => {
    await asProduction();
    // Somebody else holds a live lease, so this request must decline the work
    // and return — promptly — rather than pile onto the same tables.
    await client.unsafe(
      `insert into app_meta (key, value) values ('bootstrap_lease', '${Date.now() + 60_000}')
       on conflict (key) do update set value = excluded.value`,
    );
    resetEnsureSchemaForTests();
    bootstrapReport.applied = 0;

    const before = Date.now();
    await ensureSchema(env);
    expect(Date.now() - before).toBeLessThan(5_000);
    expect(await rows("circles")).toBe(0); // it did not touch the data
  });
});
