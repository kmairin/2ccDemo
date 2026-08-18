/**
 * Builds the deployed database on first use, if nobody has yet.
 *
 * The deploy pipeline ships the Worker but never creates tables, and the app is
 * given no connection string to point drizzle-kit at, so the first deploy of
 * this project answered `{"error":"Internal server error"}` on every page that
 * reads data. There is no dashboard step that fixes that, so the app fixes it
 * itself: the first request that needs data creates the schema and the demo
 * world from the committed statements in `bootstrap-sql.ts`.
 *
 * Deliberately narrow:
 *
 *   - It only fires when the `circles` TABLE IS ABSENT, asked of
 *     `information_schema`. That distinguishes "this database is empty" from
 *     "the database is briefly unreachable" — a connection error throws and is
 *     left alone, so a blip never triggers a rebuild.
 *   - Every statement is re-runnable (`CREATE TABLE IF NOT EXISTS`,
 *     `ON CONFLICT DO NOTHING`), so two isolates racing on a cold start cannot
 *     leave a half-built schema.
 *   - It runs once per isolate, and never drops or overwrites anything.
 *
 * Locally this never fires: `npm run db:migrate` has already made the tables.
 *
 * This is demo scaffolding, not a migration system. Real schema changes still go
 * through `src/schema.ts` + `npm run db:generate`. When the demo is over, delete
 * this file, its call in `src/index.ts`, and `src/bootstrap-sql.ts`.
 */
import { sql } from "drizzle-orm";
import { BOOTSTRAP_STATEMENTS } from "./bootstrap-sql";
import { batch, getDb, type DatabaseEnv } from "./db";
import { createLogger, type LoggerEnv } from "./logger";

type EnsureEnv = DatabaseEnv & LoggerEnv;

/** One attempt per isolate. Concurrent callers await the same promise. */
let inFlight: Promise<void> | null = null;

/**
 * What went wrong last time we tried to build the schema.
 *
 * Deployed, there is no console and no way to run a query by hand, so a
 * bootstrap that half-works is otherwise invisible — the app just serves empty
 * lists. This holds the first few failures so `GET /api/health?schema=1` can
 * report them. It contains our own SQL and the database's error text: no user
 * data, no secrets. Remove it with the rest of the bootstrap scaffolding.
 */
export const bootstrapReport: {
  ran: boolean;
  applied: number;
  failed: number;
  failures: { statement: string; error: string }[];
} = { ran: false, applied: 0, failed: 0, failures: [] };

/** First scalar of the first row. The data-service proxy returns positional arrays. */
function scalar(rows: unknown): number {
  const first: unknown = (rows as unknown[])[0];
  if (Array.isArray(first)) return Number(first[0] ?? 0);
  const obj = first as Record<string, unknown> | undefined;
  return Number(Object.values(obj ?? {})[0] ?? 0);
}

/**
 * Is the app's world already here?
 *
 * Asking information_schema first — rather than `select from circles` — is what
 * separates "no schema" from "cannot reach the database right now": an
 * unreachable database throws, and the caller leaves it alone.
 *
 * Having the TABLE is not enough. The first deployment created all ten tables
 * and then landed **no rows**, so every page answered 200 with an empty list,
 * which is worse than an error because nothing looks wrong. A circles table
 * with zero rows means the data never arrived, so treat it as not-yet-built.
 */
async function worldExists(env: EnsureEnv): Promise<boolean> {
  const db = getDb(env);
  const tables = scalar(
    await db.execute(
      sql`select count(*)::int from information_schema.tables
          where table_schema = 'public' and table_name = 'circles'`,
    ),
  );
  if (tables === 0) return false;

  // Not just circles. The deployed run stopped part-way and left circles
  // populated but events, members and photos empty — and a circles-only check
  // then treats that as "built" and never retries. Ask for the tables that come
  // last in the load order too.
  const circles = scalar(await db.execute(sql`select count(*)::int from circles`));
  if (circles === 0) return false;

  // Duplicates mean an earlier run inserted the same rows twice — which is what
  // happens when the primary keys were never created, so ON CONFLICT DO NOTHING
  // had nothing to conflict with. Rebuild: the load now clears each table first,
  // so a rebuild restores exactly the seeded world.
  const distinct = scalar(await db.execute(sql`select count(distinct id)::int from circles`));
  if (distinct !== circles) return false;
  const events = scalar(await db.execute(sql`select count(*)::int from events`));
  if (events === 0) return false;
  return scalar(await db.execute(sql`select count(*)::int from bookings`)) > 0;
}

async function build(env: EnsureEnv): Promise<void> {
  const log = createLogger(env);
  const db = getDb(env);
  let applied = 0;
  let failed = 0;

  /**
   * Send the statements in CHUNKS, not one at a time.
   *
   * Each round trip to the data service is a subrequest, and a Worker gets a
   * limited number per request. Executing 518 statements individually silently
   * hit that ceiling on the deployed app: it got through users, circles and
   * packages — 47 inserts — and then the request was cut off mid-run, leaving
   * events, members, photos and bookings empty with no error recorded anywhere,
   * because the isolate died before it could record one.
   *
   * `batch` from src/db.ts sends many statements in one round trip. It is
   * all-or-nothing, so a chunk that fails is retried statement by statement to
   * find out which one — costing subrequests only when something is wrong.
   */
  const CHUNK = 40;
  const asQuery = (statement: string) => ({ toSQL: () => ({ sql: statement, params: [] as unknown[] }) });

  for (let i = 0; i < BOOTSTRAP_STATEMENTS.length; i += CHUNK) {
    const chunk = BOOTSTRAP_STATEMENTS.slice(i, i + CHUNK);
    try {
      await batch(env, chunk.map(asQuery));
      applied += chunk.length;
    } catch {
      for (const statement of chunk) {
        try {
          await db.execute(sql.raw(statement));
          applied++;
        } catch (err) {
          failed++;
          const error = err instanceof Error ? err.message : String(err);
          if (bootstrapReport.failures.length < 8) {
            bootstrapReport.failures.push({ statement: statement.slice(0, 200), error });
          }
          if (failed <= 3) {
            log.error("bootstrap statement failed", { statement: statement.slice(0, 120), err: error });
          }
        }
      }
    }
  }

  bootstrapReport.ran = true;
  bootstrapReport.applied = applied;
  bootstrapReport.failed = failed;
  log.info("database bootstrapped", { applied, failed, total: BOOTSTRAP_STATEMENTS.length });
}

/**
 * Call before serving anything that reads data. Cheap after the first request:
 * one `information_schema` count, then a resolved promise for the isolate's life.
 */
export function ensureSchema(env: EnsureEnv): Promise<void> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      if (await worldExists(env)) return;
      await build(env);
    } catch (err) {
      // Could not even ask — almost certainly the database being unreachable.
      // Let the request fail normally and allow a later request to retry.
      createLogger(env).warn("could not check the schema", {
        err: err instanceof Error ? err.message : String(err),
      });
      inFlight = null;
    }
  })();

  return inFlight;
}
