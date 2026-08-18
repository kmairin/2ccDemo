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
 *   - It only fires when the world is absent OR was built from a DIFFERENT
 *     SEED than the one shipped in this deploy (`app_meta.seed_version` against
 *     `BOOTSTRAP_VERSION`). Table presence is asked of `information_schema`,
 *     which distinguishes "this database is empty" from "the database is
 *     briefly unreachable" — a connection error throws and is left alone, so a
 *     blip never triggers a rebuild.
 *   - Every statement is re-runnable (`CREATE TABLE IF NOT EXISTS`,
 *     `ON CONFLICT DO NOTHING`), so two isolates racing on a cold start cannot
 *     leave a half-built schema.
 *   - It runs once per isolate.
 *
 * Locally it fires at most once per seed change — `npm run db:migrate` and
 * `npm run seed` have already built the same world, so the rebuild reloads it
 * and then the recorded version matches for good.
 *
 * This is demo scaffolding, not a migration system. Real schema changes still go
 * through `src/schema.ts` + `npm run db:generate`. When the demo is over, delete
 * this file, its call in `src/index.ts`, and `src/bootstrap-sql.ts`.
 */
import { sql } from "drizzle-orm";
import { BOOTSTRAP_STATEMENTS, BOOTSTRAP_VERSION } from "./bootstrap-sql";
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
  /** The seed this build of the app carries. */
  version: string;
  /** What the database says it was last built from — `null` before the first check. */
  storedVersion: string | null;
  failures: { statement: string; error: string }[];
} = {
  ran: false,
  applied: 0,
  failed: 0,
  version: BOOTSTRAP_VERSION,
  storedVersion: null,
  failures: [],
};

/** First scalar of the first row. The data-service proxy returns positional arrays. */
function scalar(rows: unknown): number {
  const first: unknown = (rows as unknown[])[0];
  if (Array.isArray(first)) return Number(first[0] ?? 0);
  const obj = first as Record<string, unknown> | undefined;
  return Number(Object.values(obj ?? {})[0] ?? 0);
}

/** First column of the first row, as text. `null` when there is no row. */
function firstText(rows: unknown): string | null {
  const first: unknown = (rows as unknown[])[0];
  if (first === undefined) return null;
  const value = Array.isArray(first) ? first[0] : Object.values(first as object)[0];
  return value === null || value === undefined ? null : String(value);
}

/** Does a table exist? Asked of information_schema, so a missing table is not an error. */
async function tableExists(env: EnsureEnv, name: string): Promise<boolean> {
  const db = getDb(env);
  return (
    scalar(
      await db.execute(
        sql`select count(*)::int from information_schema.tables
            where table_schema = 'public' and table_name = ${name}`,
      ),
    ) > 0
  );
}

/**
 * Which seed was this database built from? `null` if nobody has ever said.
 *
 * Checks that `app_meta` exists before reading it. Selecting from a missing
 * table throws, and `ensureSchema` reads a throw as "the database is
 * unreachable" and skips the rebuild — which would make the very database that
 * most needs rebuilding the one that never does.
 */
async function storedSeedVersion(env: EnsureEnv): Promise<string | null> {
  if (!(await tableExists(env, "app_meta"))) return null;
  const db = getDb(env);
  return firstText(
    await db.execute(sql`select "value" from "app_meta" where "key" = 'seed_version'`),
  );
}

/**
 * Record which seed the world was built from. Upsert, because a rebuild may be
 * the second, third or tenth this database has seen.
 */
async function writeSeedVersion(env: EnsureEnv): Promise<void> {
  await getDb(env).execute(
    sql`insert into "app_meta" ("key", "value") values ('seed_version', ${BOOTSTRAP_VERSION})
        on conflict ("key") do update set "value" = excluded."value"`,
  );
}

/**
 * Does the world look like somebody loaded it?
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
async function looksPopulated(env: EnsureEnv): Promise<boolean> {
  const db = getDb(env);
  if (!(await tableExists(env, "circles"))) return false;

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

/**
 * Is the app's world already here, AND is it the world this deploy ships?
 *
 * The second half is the part that was missing. Every check above asks whether
 * the database looks UNBUILT, and a seed change does not make it look unbuilt:
 * when every circle and gathering gained a photograph and 123 gallery rows
 * gained an object key, production stayed fully populated, so nothing fired and
 * the live site served the old photo-less rows through deploy after deploy.
 *
 * `app_meta.seed_version` closes that gap. It is written at the end of a
 * rebuild and compared here, so "already built" means built from THIS seed.
 * Absent or stale — including on every database built before this marker
 * existed — is a rebuild.
 */
async function worldExists(env: EnsureEnv): Promise<boolean> {
  if (!(await looksPopulated(env))) return false;
  const stored = await storedSeedVersion(env);
  bootstrapReport.storedVersion = stored;
  return stored === BOOTSTRAP_VERSION;
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
          // Drizzle rewraps whatever the driver threw as "Failed query: <sql>",
          // which says nothing about WHY. The database's own words are on
          // `cause`, and without them a deployed failure is undiagnosable: there
          // is no console here and no way to run the statement by hand.
          const cause = (err as { cause?: unknown } | undefined)?.cause;
          const reason = cause instanceof Error ? cause.message : cause ? String(cause) : "";
          const error = `${err instanceof Error ? err.message : String(err)}${reason ? ` | cause: ${reason}` : ""}`;
          if (bootstrapReport.failures.length < 8) {
            bootstrapReport.failures.push({ statement: statement.slice(0, 200), error: error.slice(0, 400) });
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

  /**
   * Stamp the version — but only if the data actually landed.
   *
   * "Successful" cannot mean `failed === 0`. Re-running against a database that
   * already has its constraints fails every `ALTER TABLE … ADD CONSTRAINT`, by
   * design (see the generator), and gating the stamp on a clean run would mean
   * the marker is never written on exactly the databases it exists for — so
   * every request in every isolate would rebuild, forever.
   *
   * So ask the world instead of counting errors: if the rows are there, the
   * rebuild did its job and this seed is what the database now holds.
   */
  try {
    if (await looksPopulated(env)) {
      await writeSeedVersion(env);
      bootstrapReport.storedVersion = BOOTSTRAP_VERSION;
    } else {
      log.error("bootstrap left the world empty; seed version not recorded", { applied, failed });
    }
  } catch (err) {
    // A rebuild that worked but could not record itself will simply run again.
    // Wasteful, not wrong — and far better than claiming a version that is not
    // in the database.
    log.error("could not record the seed version", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  log.info("database bootstrapped", {
    applied,
    failed,
    total: BOOTSTRAP_STATEMENTS.length,
    version: BOOTSTRAP_VERSION,
  });
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
