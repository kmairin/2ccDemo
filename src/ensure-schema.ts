/**
 * Builds the deployed database on first use, if nobody has yet.
 *
 * The deploy pipeline ships the Worker but never creates tables, and the app is
 * given no connection string to point drizzle-kit at, so the first deploy of
 * this project answered `{"error":"Internal server error"}` on every page that
 * reads data. There is no dashboard step that fixes that, so the app fixes it
 * itself: requests that need data build the schema and the demo world from the
 * committed statements in `bootstrap-sql.ts`.
 *
 * ## The rule this file exists to obey
 *
 * **A page request must never spend its budget on the bootstrap.**
 *
 * That rule is written in blood. The previous version ran the whole build
 * inside whichever request arrived first and waited for all of it. Deployed,
 * that request took **157 seconds and then answered 500** — and so did every
 * other page, for hours. A Worker gets a limited number of subrequests and a
 * limited amount of wall time per request; the bootstrap ate both, so by the
 * time the page ran its own query there was nothing left to spend and the query
 * threw. The site was not slow, it was down, and it stayed down because every
 * new request repeated the same doomed 157 seconds.
 *
 * So the work is now **budgeted** and **resumable**:
 *
 *   - `ROUNDTRIP_BUDGET` caps how many round trips one request may spend here.
 *     When the budget runs out the request stops and returns. The page then
 *     renders with whatever is in the database — possibly not much, on the very
 *     first request, but it renders, in milliseconds, instead of dying.
 *   - Progress is written to `app_meta.data_cursor`, so the next request picks
 *     up where this one stopped instead of starting over. A healthy database
 *     finishes the whole load in the first request; a slow or unhappy one takes
 *     several, and the site is up and improving the whole time.
 *
 * Anything that cannot be made cheap is made rare instead: the destructive
 * rebuild happens once per seed version, behind a lease, never per request.
 *
 * This is demo scaffolding, not a migration system. Real schema changes still go
 * through `src/schema.ts` + `npm run db:generate`. When the demo is over, delete
 * this file, its call in `src/index.ts`, and `src/bootstrap-sql.ts`.
 */
import { sql } from "drizzle-orm";
import { BOOTSTRAP_STATEMENTS, BOOTSTRAP_VERSION } from "./bootstrap-sql";
import { batch, getDb, type DatabaseEnv } from "./db";
import { createLogger, type LoggerEnv } from "./logger";

/**
 * The statements fall into two halves with different rules.
 *
 * SCHEMA — CREATE TABLE, indexes, constraints. Every one is idempotent and
 * cheap, and it must run before anything else, because `app_meta` — where all
 * the progress below is recorded — is itself one of these statements.
 *
 * DATA — DELETE then INSERT. 468 statements, and the expensive half. This is
 * the part that gets a budget and a cursor.
 */
const isDataStatement = (statement: string) => /^(DELETE FROM|INSERT INTO)/i.test(statement);

/**
 * The deployed database rejects EVERY `ALTER TABLE`.
 *
 * Its tables are `schema_locked`, so `ADD COLUMN` comes back with "this schema
 * change is disallowed because table … is locked", and unlocking needs a
 * single-statement implicit transaction, which the data service does not give
 * us. Local Postgres has no such lock, which is why this only ever failed in
 * production. So: never send an ALTER. A column added later arrives by dropping
 * the table and recreating it, which the version bump already implies.
 */
const isAlter = (statement: string) => /^ALTER TABLE/i.test(statement);
const isCreateTable = (statement: string) => /^CREATE TABLE/i.test(statement);

/**
 * `ALTER TABLE … SET (schema_locked = …)` is emitted by newer pg_dump and is
 * rejected by both the deployed database and older Postgres. It does nothing we
 * need, and 47 guaranteed failures per run bury the ones that matter.
 */
const isNoise = (statement: string) => /SET \(schema_locked/i.test(statement);

/** Safe on every cold start: creates anything absent, changes nothing present. */
const CREATE_STATEMENTS = BOOTSTRAP_STATEMENTS.filter(
  (s) => !isDataStatement(s) && !isNoise(s) && !isAlter(s),
);

/**
 * A full reset, used only when the seed version changes. Dropping is the only
 * way a new column reaches this database. Everything here is regenerated from
 * the seed, so the sole real cost is `sessions` — signed-in visitors are signed
 * out by a seed change.
 */
const TABLES_IN_DROP_ORDER = [
  "bookings", "passes", "orders", "circle_members", "photos",
  "events", "packages", "circles", "sessions", "users",
];
const RESET_STATEMENTS = [
  ...TABLES_IN_DROP_ORDER.map((t) => `DROP TABLE IF EXISTS "public"."${t}" CASCADE`),
  ...BOOTSTRAP_STATEMENTS.filter((s) => isCreateTable(s) && !isNoise(s)),
  ...BOOTSTRAP_STATEMENTS.filter(
    (s) => !isDataStatement(s) && !isNoise(s) && !isAlter(s) && !isCreateTable(s),
  ),
];
const DATA_STATEMENTS = BOOTSTRAP_STATEMENTS.filter(isDataStatement);

/**
 * Which columns each table is supposed to have, read out of the CREATE TABLE
 * statements themselves so it cannot drift from the bundle.
 */
const EXPECTED_COLUMNS: Map<string, string[]> = new Map(
  BOOTSTRAP_STATEMENTS.filter(isCreateTable).map((statement) => {
    const table = /CREATE TABLE (?:IF NOT EXISTS )?"public"\."(\w+)"/i.exec(statement)?.[1] ?? "";
    const body = statement.slice(statement.indexOf("(") + 1);
    const columns: string[] = [];
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      // A column definition opens with the quoted column name. Table-level
      // constraints (PRIMARY KEY, CONSTRAINT …) do not, so they are skipped.
      if (!trimmed.startsWith('"')) continue;
      const name = /^"(\w+)"/.exec(trimmed)?.[1];
      if (name) columns.push(name);
    }
    return [table, columns] as [string, string[]];
  }),
);

/**
 * How many round trips one request may spend building the database.
 *
 * The number that matters is not this one but the one it protects: a Worker's
 * per-request subrequest allowance, which the old unbudgeted build exhausted
 * before the page could run a single query of its own. Twenty is enough to send
 * all twelve data chunks plus the bookkeeping in one go when the database is
 * healthy, and small enough that the page always has room left to render.
 */
export const ROUNDTRIP_BUDGET = 20;

/** Statements per round trip. Twelve chunks covers the 468 data statements. */
const CHUNK = 40;

/**
 * How long one request may spend building the database before it gives up and
 * serves the page. The page is the product; the bootstrap is scaffolding, and
 * scaffolding does not get to decide whether the site answers.
 */
const DEADLINE_MS = 5_000;

/**
 * How long a rebuild may hold the lease before another isolate may take it.
 *
 * Long enough that a slow-but-working rebuild is not interrupted, short enough
 * that an isolate killed mid-rebuild does not lock the database out of ever
 * being built. A request that cannot get the lease does not wait for it — it
 * serves the page.
 */
const LEASE_MS = 60_000;

type EnsureEnv = DatabaseEnv & LoggerEnv;

/**
 * Set once this isolate has seen the world complete. Not a cache of work in
 * flight: each request does its own bounded slice, so there is nothing to share
 * and nothing to await. The old `inFlight` promise made every concurrent
 * request wait on the same doomed 157-second build.
 */
let settled = false;

/**
 * What the last attempt did, for `GET /api/health?schema=1`.
 *
 * Deployed, there is no console and no way to run a query by hand, so a
 * bootstrap that half-works is otherwise invisible — the app just serves empty
 * lists. This holds counts and the first few failures. It contains our own SQL
 * and the database's error text: no user data, no secrets. Remove it with the
 * rest of the bootstrap scaffolding.
 */
export const bootstrapReport: {
  ran: boolean;
  applied: number;
  failed: number;
  /** The seed this build of the app carries. */
  version: string;
  /** What the database says it was last built from — `null` before the first check. */
  storedVersion: string | null;
  /** How many data statements have landed, of how many. */
  cursor: number;
  total: number;
  /** Set when a request stopped early because it ran out of budget. */
  budgetExhausted: boolean;
  /**
   * How long each round trip took, deployed. The budget bounds the WORK loop,
   * and the first two attempts at this fix both failed because the time was
   * being spent somewhere else entirely — thirty-three seconds with `applied`
   * and `failed` both zero. Numbers beat another guess.
   */
  timings: { step: string; ms: number }[];
  failures: { statement: string; error: string }[];
} = {
  ran: false,
  applied: 0,
  failed: 0,
  version: BOOTSTRAP_VERSION,
  storedVersion: null,
  cursor: 0,
  total: DATA_STATEMENTS.length,
  budgetExhausted: false,
  timings: [],
  failures: [],
};

/**
 * Two limits, because counting round trips is not enough.
 *
 * The first version of this counted trips alone, capped at twenty, and the site
 * still hung for ninety seconds a request. Twenty round trips is only cheap if
 * a round trip is cheap, and against an unhappy database it is not — the count
 * bounds how much work is attempted, and says nothing about how long that takes.
 *
 * So the deadline is the limit that actually protects the page, and it is
 * checked before every trip. Whatever the database is doing, this request stops
 * asking after DEADLINE_MS and lets the page render.
 */
class Budget {
  constructor(
    private left: number,
    private readonly until: number,
  ) {}
  get spent(): boolean {
    return this.left <= 0 || Date.now() >= this.until;
  }
  take(): boolean {
    if (this.spent) {
      bootstrapReport.budgetExhausted = true;
      return false;
    }
    this.left--;
    return true;
  }
}

/** Time one round trip into the report, so a slow call names itself. */
async function timed<T>(step: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await run();
  } finally {
    if (bootstrapReport.timings.length < 24) {
      bootstrapReport.timings.push({ step, ms: Date.now() - started });
    }
  }
}

/** First column of the first row, as text. `null` when there is no row. */
function firstText(rows: unknown): string | null {
  const first: unknown = (rows as unknown[])[0];
  if (first === undefined) return null;
  const value = Array.isArray(first) ? first[0] : Object.values(first as object)[0];
  return value === null || value === undefined ? null : String(value);
}

/** First scalar of the first row. The data-service proxy returns positional arrays. */
function scalar(rows: unknown): number {
  return Number(firstText(rows) ?? 0);
}

/** Read one `app_meta` key. `null` when the table or the row is absent. */
async function readMeta(env: EnsureEnv, key: string): Promise<string | null> {
  return timed(`read:${key}`, async () =>
    firstText(
      await getDb(env).execute(sql`select "value" from "app_meta" where "key" = ${key}`),
    ),
  );
}

/** Write one `app_meta` key. Upsert: a rebuild may be this database's tenth. */
async function writeMeta(env: EnsureEnv, key: string, value: string): Promise<void> {
  await timed(`write:${key}`, async () =>
    getDb(env).execute(
    sql`insert into "app_meta" ("key", "value") values (${key}, ${value})
        on conflict ("key") do update set "value" = excluded."value"`,
    ),
  );
}

/**
 * Claim the right to rebuild, for this request only.
 *
 * Without this, every isolate that arrives while the world is empty starts its
 * own `DROP TABLE … CASCADE` and its own reload, on the same tables, at the same
 * moment — so they block on each other's locks and wipe each other's progress.
 * The winner is decided by the database in one statement: the `where` clause
 * only fires when the existing lease has expired, and `returning` comes back
 * empty for everyone who lost.
 */
async function claimLease(env: EnsureEnv): Promise<boolean> {
  const now = Date.now();
  try {
    const rows = await timed("lease", async () =>
      getDb(env).execute(
      sql`insert into "app_meta" ("key", "value") values ('bootstrap_lease', ${String(now + LEASE_MS)})
          on conflict ("key") do update set "value" = excluded."value"
          where "app_meta"."value" < ${String(now)}
          returning "key"`,
      ),
    );
    return (rows as unknown as unknown[]).length > 0;
  } catch {
    // Fail OPEN. The lease only keeps two isolates from rebuilding the same
    // tables at once, and the budget above is what actually keeps a request
    // safe. If this database will not do a conditional upsert with RETURNING,
    // the cost of failing closed is that the world never loads at all and every
    // page serves empty for good — much worse than the contention it prevents.
    return true;
  }
}

/** Let the next request start immediately rather than waiting out the lease. */
async function releaseLease(env: EnsureEnv): Promise<void> {
  await writeMeta(env, "bootstrap_lease", "0");
}

/**
 * Is anything the bundle declares actually missing from this database?
 *
 * This is the question the seed version was standing in for, and standing in
 * badly. A seed change bumps the version whether or not the SHAPE changed, and
 * the answer was used to justify dropping every table — on a database where a
 * batch of `DROP TABLE` never returns at all. Deployed, that hang was the whole
 * outage: the bookkeeping around it took 247ms and the drop took forever.
 *
 * So ask the real question, in one round trip. Nothing missing means nothing to
 * rebuild, and the data can simply be loaded into the tables already there.
 */
async function missingColumns(env: EnsureEnv): Promise<string[]> {
  const rows = (await timed("columns", async () =>
    getDb(env).execute(
      sql`select "table_name", "column_name" from "information_schema"."columns"
          where "table_schema" = 'public'`,
    ),
  )) as unknown as unknown[];

  const present = new Set<string>();
  for (const row of rows) {
    const [table, column] = Array.isArray(row) ? row : Object.values(row as object);
    present.add(`${String(table)}.${String(column)}`);
  }

  const missing: string[] = [];
  for (const [table, columns] of EXPECTED_COLUMNS) {
    for (const column of columns) {
      if (!present.has(`${table}.${column}`)) missing.push(`${table}.${column}`);
    }
  }
  return missing;
}

/**
 * Does the world look like somebody loaded it?
 *
 * Having the TABLE is not enough. One deployment created all ten tables and then
 * landed **no rows**, so every page answered 200 with an empty list, which is
 * worse than an error because nothing looks wrong. Ask the tables that come last
 * in the load order too: a run that stopped part-way leaves `circles` populated
 * and `bookings` empty.
 */
async function looksPopulated(env: EnsureEnv): Promise<boolean> {
  const db = getDb(env);
  const circles = scalar(await db.execute(sql`select count(*)::int from circles`));
  if (circles === 0) return false;
  const events = scalar(await db.execute(sql`select count(*)::int from events`));
  if (events === 0) return false;
  return scalar(await db.execute(sql`select count(*)::int from bookings`)) > 0;
}

/**
 * Send statements in chunks, spending one round trip each, until the work is
 * done or the budget is gone. Returns how far it got.
 *
 * `batch` is all-or-nothing, so a chunk that fails is retried statement by
 * statement — which costs a round trip per statement and is exactly how the old
 * version burned 157 seconds. Here those retries come out of the same budget as
 * everything else, so a failing chunk slows the load down but can no longer take
 * the site with it.
 */
async function apply(
  env: EnsureEnv,
  statements: readonly string[],
  from: number,
  budget: Budget,
  { oneAtATime = false }: { oneAtATime?: boolean } = {},
): Promise<number> {
  const db = getDb(env);
  const asQuery = (statement: string) => ({
    toSQL: () => ({ sql: statement, params: [] as unknown[] }),
  });
  let cursor = from;

  while (cursor < statements.length && !budget.spent) {
    const chunk = statements.slice(cursor, oneAtATime ? cursor + 1 : cursor + CHUNK);
    if (!budget.take()) break;
    try {
      /**
       * DDL never goes in a batch.
       *
       * A batch is one transaction, and a transaction containing `DROP TABLE`
       * simply never returns on the deployed database — the request that sent
       * one sat there until it was abandoned, with the timing report showing
       * 247ms of bookkeeping either side and nothing at all for the drop. The
       * schema passes therefore send one statement at a time, which is the only
       * shape of DDL this database has ever accepted. Data is ordinary DML and
       * batches perfectly well.
       */
      if (oneAtATime) throw new Error("ddl is sent one statement at a time");
      await timed(`batch@${cursor}`, () => batch(env, chunk.map(asQuery)));
      cursor += chunk.length;
      bootstrapReport.applied += chunk.length;
      continue;
    } catch {
      // Find out which statement in the chunk is unhappy, one at a time, and
      // keep the ones that do work. Each costs a round trip from the budget.
      for (const statement of chunk) {
        if (!budget.take()) return cursor;
        try {
          await db.execute(sql.raw(statement));
          bootstrapReport.applied++;
        } catch (err) {
          bootstrapReport.failed++;
          // Drizzle rewraps whatever the driver threw as "Failed query: <sql>",
          // which says nothing about WHY. The database's own words are on
          // `cause`, and without them a deployed failure is undiagnosable:
          // there is no console here and no way to run the statement by hand.
          const cause = (err as { cause?: unknown } | undefined)?.cause;
          const reason = cause instanceof Error ? cause.message : cause ? String(cause) : "";
          const error = `${err instanceof Error ? err.message : String(err)}${reason ? ` | cause: ${reason}` : ""}`;
          if (bootstrapReport.failures.length < 8) {
            bootstrapReport.failures.push({
              statement: statement.slice(0, 200),
              error: error.slice(0, 400),
            });
          }
        }
        // Advance past a failure as well as a success. A statement rejected by
        // this database will be rejected again next request, and stopping on it
        // would stall the load for good.
        cursor++;
      }
    }
  }
  return cursor;
}

/** `"<version>:<n>"` — a cursor is only meaningful for the seed that wrote it. */
function readCursor(stored: string | null): number {
  if (!stored) return 0;
  const [version, n] = stored.split(":");
  if (version !== BOOTSTRAP_VERSION) return 0;
  const parsed = Number(n);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Do one bounded slice of the build. Returns true when the world is complete
 * and this isolate never needs to look again.
 *
 * Every pass carries its own cursor in `app_meta`, so a request that runs out
 * of budget mid-pass is resumed by the next one rather than starting over. That
 * is not a nicety: with `batch` unavailable, a single pass costs one round trip
 * per statement, and without cursors the schema pass would spend the whole
 * budget every request and the data load would never begin at all. The test
 * suite pins exactly that case.
 */
async function step(env: EnsureEnv, budget: Budget, deadline: number): Promise<boolean> {
  const log = createLogger(env);

  /**
   * Read the bookkeeping first, and let a failure mean "there is no schema
   * yet". `app_meta` is the first statement in the create pass, so if it can be
   * read the tables have been created at least once — and the create pass, 33
   * statements that would otherwise be re-sent on every single request, can be
   * skipped entirely. That read is the only cost of the steady state.
   */
  let storedVersion: string | null = null;
  try {
    storedVersion = await readMeta(env, "seed_version");
  } catch {
    // No `app_meta`, so nothing to resume and nowhere to record progress.
    // Create the schema and stop there; the next request loads the data.
    // Its own trip allowance, because the create pass must be able to finish
    // even when every statement costs a trip of its own — but the SAME
    // deadline, so a slow database cannot turn it into a ninety-second page.
    await apply(env, CREATE_STATEMENTS, 0, new Budget(CREATE_STATEMENTS.length + 2, deadline), {
      oneAtATime: true,
    });
    return false;
  }

  bootstrapReport.storedVersion = storedVersion;
  if (storedVersion === BOOTSTRAP_VERSION) return true;

  // Somebody else is already rebuilding. Serve the page instead of queueing up
  // behind them — that queue is what turned one slow build into a dead site.
  if (!(await claimLease(env))) return false;

  try {
    bootstrapReport.ran = true;

    // The seed changed, so the shape may have changed too, and this database
    // will not accept an ALTER. Drop and recreate — once per version, and only
    // marked done when the pass has actually run to the end, so an interrupted
    // rebuild is never mistaken for a finished one.
    if ((await readMeta(env, "schema_version")) !== BOOTSTRAP_VERSION) {
      const missing = await missingColumns(env);
      if (missing.length === 0) {
        // The tables already have every column this bundle declares, so there
        // is nothing a rebuild would achieve — and rebuilding is the one thing
        // this database will not do. Record the shape as current and go and
        // load the data, which is all that was ever actually missing.
        log.info("schema already matches the bundle; skipping the rebuild", {
          tables: EXPECTED_COLUMNS.size,
        });
        await writeMeta(env, "schema_version", BOOTSTRAP_VERSION);
      } else {
        log.info("rebuilding: the deployed schema is missing columns", {
          missing: missing.slice(0, 8).join(", "),
          count: missing.length,
        });
        const from = readCursor(await readMeta(env, "reset_cursor"));
        const reached = await apply(env, RESET_STATEMENTS, from, budget, { oneAtATime: true });
        await writeMeta(env, "reset_cursor", `${BOOTSTRAP_VERSION}:${reached}`);
        if (reached < RESET_STATEMENTS.length) {
          log.info("bootstrap rebuilding, will resume next request", {
            reset: reached,
            of: RESET_STATEMENTS.length,
          });
          return false;
        }
        await writeMeta(env, "schema_version", BOOTSTRAP_VERSION);
        // The tables were just recreated empty, so any earlier data cursor is a
        // claim about rows that no longer exist.
        await writeMeta(env, "data_cursor", `${BOOTSTRAP_VERSION}:0`);
      }
    }

    const cursor = await apply(
      env,
      DATA_STATEMENTS,
      readCursor(await readMeta(env, "data_cursor")),
      budget,
    );
    await writeMeta(env, "data_cursor", `${BOOTSTRAP_VERSION}:${cursor}`);
    bootstrapReport.cursor = cursor;

    if (cursor < DATA_STATEMENTS.length) {
      log.info("bootstrap paused, will resume next request", {
        cursor,
        total: DATA_STATEMENTS.length,
      });
      return false;
    }

    // Ask the world rather than counting errors. Re-running against a database
    // that already has its constraints fails every `ADD CONSTRAINT` by design,
    // so `failed === 0` is the wrong test for "did this work".
    if (!(await looksPopulated(env))) {
      log.error("bootstrap ran to the end and the world is still empty", {
        applied: bootstrapReport.applied,
        failed: bootstrapReport.failed,
      });
      return false;
    }

    await writeMeta(env, "seed_version", BOOTSTRAP_VERSION);
    bootstrapReport.storedVersion = BOOTSTRAP_VERSION;
    log.info("database bootstrapped", {
      applied: bootstrapReport.applied,
      failed: bootstrapReport.failed,
      version: BOOTSTRAP_VERSION,
    });
    return true;
  } finally {
    await releaseLease(env);
  }
}

/**
 * Call before serving anything that reads data.
 *
 * Never throws and never blocks for long: the caller gets control back inside
 * its budget whatever the database is doing, and renders the page with what is
 * there. Free after the world is complete — one flag, no round trips.
 */
export async function ensureSchema(env: EnsureEnv): Promise<void> {
  if (settled) return;
  try {
    const deadline = Date.now() + DEADLINE_MS;

    /**
     * The deadline is enforced HERE, around everything, not only inside the
     * work loop.
     *
     * Checking it before each statement was not enough: deployed, this spent
     * thirty-three seconds with `applied` and `failed` both zero, because the
     * time went to the bookkeeping round trips either side of the loop — the
     * lease, the cursor reads, the cursor write — and none of those passed
     * through the budget. Racing the whole thing is the only bound that does
     * not depend on guessing which call is the slow one.
     *
     * Losing the race abandons the attempt, not the progress: every pass
     * records how far it got, so the next request resumes. The page is what
     * matters, and the page now gets control back on time whatever the
     * database is doing.
     */
    const finished = await Promise.race([
      step(env, new Budget(ROUNDTRIP_BUDGET, deadline), deadline),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), DEADLINE_MS)),
    ]);
    if (finished) settled = true;
  } catch (err) {
    // Almost certainly the database being unreachable. Let the request carry on
    // and let a later one retry; a blip must not take the page down with it.
    createLogger(env).warn("could not build the schema", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Test seam: forget that this isolate ever checked. */
export function resetEnsureSchemaForTests(): void {
  settled = false;
}
