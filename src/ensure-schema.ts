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
import { getDb, type DatabaseEnv } from "./db";
import { createLogger, type LoggerEnv } from "./logger";

type EnsureEnv = DatabaseEnv & LoggerEnv;

/** One attempt per isolate. Concurrent callers await the same promise. */
let inFlight: Promise<void> | null = null;

async function circlesTableExists(env: EnsureEnv): Promise<boolean> {
  const db = getDb(env);
  // Asking information_schema — rather than `select from circles` — is what
  // separates "no schema" from "cannot reach the database right now".
  const rows = await db.execute(
    sql`select count(*)::int from information_schema.tables
        where table_schema = 'public' and table_name = 'circles'`,
  );
  const first: unknown = (rows as unknown as unknown[])[0];
  // The data-service proxy returns positional arrays, not mapped objects.
  const n = Array.isArray(first)
    ? Number(first[0] ?? 0)
    : Number((first as { count?: number } | undefined)?.count ?? 0);
  return n > 0;
}

async function build(env: EnsureEnv): Promise<void> {
  const log = createLogger(env);
  const db = getDb(env);
  let applied = 0;
  let failed = 0;

  for (const statement of BOOTSTRAP_STATEMENTS) {
    try {
      await db.execute(sql.raw(statement));
      applied++;
    } catch (err) {
      failed++;
      // Log the first few only: a broken bootstrap would otherwise write 500
      // lines and bury the cause.
      if (failed <= 3) {
        log.error("bootstrap statement failed", {
          statement: statement.slice(0, 120),
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
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
      if (await circlesTableExists(env)) return;
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
