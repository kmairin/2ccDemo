/**
 * Your database connection. Everything that talks to Postgres goes through here.
 *
 * You should rarely need to change this file. Add TABLES in `src/schema.ts` and
 * QUERIES in your routes; this is just the plumbing that connects them.
 *
 * ---
 *
 * How it works, because the two environments differ and that surprises people:
 *
 *   deployed   your app -> the SV Cloud data service -> your Postgres database
 *   locally    your app -> a Postgres running on your own machine
 *
 * Both go through the SAME Drizzle driver (`pg-proxy`), so a query that works in
 * one works in the other. Only the transport underneath changes. That is
 * deliberate: "works on my machine" is not a debugging experience anyone enjoys.
 *
 * Deployed, your app has no database password and never sees one — it holds a
 * token that only unlocks its own database, and the data service does the rest.
 * That is why there is no connection string to copy anywhere.
 *
 * **This app is not locked to SV Cloud.** It is a plain Worker (a V8 isolate),
 * and the branch below means that anywhere the data-service binding is absent,
 * it talks to whatever `DATABASE_URL` points at. Deploy it on any host that runs
 * isolates, point it at your own Postgres, and it runs unchanged.
 */
import { drizzle } from "drizzle-orm/pg-proxy";
import * as schema from "./schema";

/** One row, as a positional array — what the proxy driver hands back. */
type Row = unknown[];

/**
 * Force the extended wire protocol on local queries.
 *
 * postgres.js otherwise picks the protocol from whether parameters were passed
 * (`simple: args.length === 0` in its source), and the SIMPLE protocol returns
 * every column as a **string** — so a parameterless `count(*)` would come back
 * as `"5"` locally and `5` deployed. That is precisely the "works on my machine"
 * divergence this file exists to prevent.
 *
 * The option is honoured at runtime; postgres.js just does not list it in its
 * published `UnsafeQueryOptions` type, which is what the cast is for.
 */
const EXTENDED_PROTOCOL = { simple: false, prepare: false } as { prepare?: boolean };

export interface DatabaseEnv {
  /** The SV Cloud data service. Present when deployed, absent locally. */
  DB?: {
    query(
      token: string,
      sql: string,
      params: unknown[],
      method: string,
      /** See `regionFromCf` — only meaningful for a `staleRead`. */
      callerRegion?: string,
    ): Promise<{ rows: Row[] }>;
    batch(
      token: string,
      statements: { sql: string; params: unknown[] }[],
      callerRegion?: string,
    ): Promise<{ rows: Row[] }[]>;
  };
  /** Your app's access token. Managed by Loop; you never set this by hand. */
  LOOP_DB_TOKEN?: string;
  /**
   * A direct Postgres connection string. Used when there is no data-service
   * binding — locally (see wrangler.toml), and anywhere else this app is
   * deployed. Ignored while running on SV Cloud.
   */
  DATABASE_URL?: string;
}

/**
 * Local transport: talk to Postgres on your own machine.
 *
 * Imported lazily so the `postgres` package is only pulled in during local
 * development. Deployed, this branch never runs.
 */
async function localQuery(url: string, sql: string, params: unknown[]): Promise<Row[]> {
  const { default: postgres } = await import("postgres");
  const client = postgres(url, { max: 1 });
  try {
    // `.values()` returns positional arrays, which is what the driver expects.
    return (await client.unsafe(sql, params as never[], EXTENDED_PROTOCOL).values()) as Row[];
  } finally {
    // Always close. A connection left open per request will exhaust your local
    // Postgres within a few minutes of hot reloading.
    await client.end();
  }
}

/**
 * Best-effort: which of the platform's three database regions is nearest a
 * request, from Cloudflare's own geolocation (`request.cf`). Only useful
 * together with `staleRead` on a project connected with `topology: "global"`
 * — see that function's doc for why, and AGENTS.md §5 for when to reach for
 * either at all.
 *
 * Coarse on purpose: continent alone can't place North America, so `region`
 * (a US state name, when Cloudflare has one) does that split; everywhere else
 * falls back by nearest of the three. Returning `undefined` (unmapped
 * continent, or no `cf` at all — `wrangler dev` and most local requests don't
 * carry one) is always safe: the data service falls back to this project's
 * own home region, exactly as if `staleRead` were never given a region.
 */
export function regionFromCf(cf: IncomingRequestCfProperties | undefined): string | undefined {
  if (!cf?.continent) return undefined;
  if (cf.continent === "NA") {
    const west = new Set([
      "California",
      "Oregon",
      "Washington",
      "Nevada",
      "Arizona",
      "Idaho",
      "Utah",
      "Montana",
      "Wyoming",
      "Colorado",
      "New Mexico",
      "Alaska",
      "Hawaii",
      "British Columbia",
      "Alberta",
    ]);
    // "aws-us-west-2" (Oregon), not "-1" (N. California) — this platform's
    // west-coast pool is us-west-2. Verified against the real cluster.
    return typeof cf.region === "string" && west.has(cf.region) ? "aws-us-west-2" : "aws-us-east-1";
  }
  if (cf.continent === "AS" || cf.continent === "OC") return "aws-ap-southeast-1";
  // EU/AF/SA/AN: no pool of ours is truly close. aws-us-east-1 is the
  // least-bad fallback for EU/AF; SA is arguable either way. Refine this
  // table for your own project's actual user base rather than trusting it as
  // gospel.
  return "aws-us-east-1";
}

function requireToken(env: DatabaseEnv): string {
  const token = env.LOOP_DB_TOKEN;
  if (!token) {
    throw new Error(
      "LOOP_DB_TOKEN is missing. This is managed by Loop — if you are seeing this on the deployed app, reconnect the project from your dashboard.",
    );
  }
  return token;
}

/**
 * Build the database client for one request.
 *
 * Call this inside a handler with `c.env`, not at module scope: `env` does not
 * exist until a request arrives.
 *
 *   const db = getDb(c.env);
 *   const rows = await db.select().from(posts).where(eq(posts.id, id));
 */
export function getDb(env: DatabaseEnv) {
  return drizzle(
    async (sql, params, _method) => {
      if (env.DB) {
        return { rows: (await env.DB.query(requireToken(env), sql, params, _method)).rows };
      }
      if (!env.DATABASE_URL) {
        throw new Error(
          "No database available. Set DATABASE_URL (wrangler.toml sets it for local development) and make sure Postgres is reachable — see INSTALL.md.",
        );
      }
      return { rows: await localQuery(env.DATABASE_URL, sql, params) };
    },
    { schema },
  );
}

/**
 * Run several statements as ONE transaction — all of them land, or none do.
 *
 * Use it when a half-finished change would be wrong: moving money between two
 * rows, creating an order and decrementing stock, deleting a post and its
 * comments.
 *
 *   import { sql } from "drizzle-orm";
 *   await batch(c.env, [
 *     db.insert(orders).values({ id, total }),
 *     db.update(stock).set({ qty: sql`qty - 1` }).where(eq(stock.sku, sku)),
 *   ]);
 *
 * Note `db.transaction()` does NOT work here and will throw. That is on purpose:
 * an open transaction would hold a shared connection while your code thinks, and
 * one slow request would stall everyone's app. Batch gets you the same guarantee
 * without holding anything open.
 */
export async function batch(
  env: DatabaseEnv,
  queries: { toSQL(): { sql: string; params: unknown[] } }[],
): Promise<Row[][]> {
  const statements = queries.map((q) => {
    const { sql, params } = q.toSQL();
    return { sql, params };
  });

  if (env.DB) {
    const results = await env.DB.batch(requireToken(env), statements);
    return results.map((r) => r.rows);
  }

  if (!env.DATABASE_URL) {
    throw new Error("No database available. See INSTALL.md for local setup.");
  }
  const { default: postgres } = await import("postgres");
  const client = postgres(env.DATABASE_URL, { max: 1 });
  try {
    return await client.begin(async (tx) => {
      const out: Row[][] = [];
      for (const statement of statements) {
        const rows = await tx
          .unsafe(statement.sql, statement.params as never[], EXTENDED_PROTOCOL)
          .values();
        out.push(rows as Row[]);
      }
      return out;
    });
  } finally {
    await client.end();
  }
}

/** Postgres interval literal — reject anything that is not one before it is interpolated. */
const INTERVAL_RE = /^\d+(ms|s|min)$/;

/**
 * Matches Drizzle's compiled output for a single, unaliased, unjoined table —
 * `from "table_name"` — so the clause below can be inserted right after it.
 * Deliberately narrow: see `staleRead`'s doc for why a join or subquery is
 * refused rather than silently mis-placing the clause.
 */
const FROM_SINGLE_TABLE_RE = /\bfrom\s+"[a-zA-Z_][a-zA-Z0-9_]*"/i;

/**
 * A bounded-staleness read: this ONE query may be served by a nearby replica
 * instead of your project's home region, returning a row that is up to
 * `maxStaleness` old. Only useful on a project connected with
 * `topology: "global"` (see README/AGENTS.md §5) — on a `topology: "pinned"`
 * project this still runs correctly, it just has nothing nearer to reach, so
 * the clause is a no-op rather than an error.
 *
 * **Only a single row looked up by an equality match on a primary or unique
 * key** — verified live against this platform's own cluster: CockroachDB
 * refuses bounded staleness for anything it cannot prove touches exactly one
 * range at plan time. A bare `WHERE id = $1` qualifies; a `LIMIT`-only scan,
 * a multi-row `WHERE id IN (...)`, and `count(*)` all failed live with
 * `unimplemented: cannot use bounded staleness for queries that may touch
 * more than one range or require an index join` — so this is NOT the tool
 * for a feed, a leaderboard, or any listing. It's for "the one post this URL
 * names," "this user's own profile by id" — reads that are already a single
 * point lookup and would benefit from running near the reader instead of
 * this project's home region. Never on something the user just wrote and
 * expects to see immediately (their own new comment, their updated profile):
 * a stale replica would not have that write yet.
 *
 * **Only a single, unaliased, unjoined table.** The clause has to attach
 * syntactically right after the table reference (`FROM "posts" AS OF SYSTEM
 * TIME ... WHERE ...`) — CockroachDB rejects it anywhere else, including at
 * the end of the statement. A query this function cannot place the clause
 * into (a join, a subquery, a CTE) throws before it reaches the database
 * rather than sending SQL that would fail with a confusing syntax error.
 *
 * **Rows come back as positional arrays, like `batch()`, NOT the mapped
 * objects `await db.select()...` normally gives you** — `getDb`'s Drizzle
 * instance does the object-mapping, and this bypasses it to insert the SQL
 * clause Drizzle has no vocabulary for. Destructure by column position, or
 * `.toSQL()` only the parts you need and re-select fewer columns.
 *
 * `region` should come from `regionFromCf(c.req.raw.cf)` in your route
 * handler — this function does not read the request itself, same reason
 * `getDb`/`batch` take `env` rather than the whole request context.
 *
 * **Breaks the "works the same locally" promise the rest of this file keeps**
 * — `with_max_staleness` is CockroachDB SQL, and your local Postgres (see
 * INSTALL.md) does not have it, so this throws locally rather than running.
 * Deployed-only, by nature of what it does; there is no local equivalent to
 * fall back to.
 *
 *   const rows = await staleRead<[id: string, title: string]>(
 *     c.env,
 *     db.select({ id: posts.id, title: posts.title }).from(posts).where(eq(posts.id, postId)),
 *     { region: regionFromCf(c.req.raw.cf) },
 *   );
 *   const [id, title] = rows[0] ?? [];
 */
export async function staleRead<T = Row>(
  env: DatabaseEnv,
  query: { toSQL(): { sql: string; params: unknown[] } },
  options: { region?: string; maxStaleness?: string } = {},
): Promise<T[]> {
  const maxStaleness = options.maxStaleness ?? "10s";
  if (!INTERVAL_RE.test(maxStaleness)) {
    throw new Error(`staleRead: "${maxStaleness}" is not a Postgres interval literal (e.g. "10s").`);
  }
  const { sql: baseSql, params } = query.toSQL();
  const match = baseSql.match(FROM_SINGLE_TABLE_RE);
  if (!match || match.index === undefined) {
    throw new Error(
      'staleRead: could not find a plain FROM "table" to attach AS OF SYSTEM TIME to — ' +
        "this only supports a single, unaliased, unjoined table. See this function's doc.",
    );
  }
  const insertAt = match.index + match[0].length;
  const sql =
    `${baseSql.slice(0, insertAt)} AS OF SYSTEM TIME with_max_staleness('${maxStaleness}')` +
    baseSql.slice(insertAt);

  if (env.DB) {
    const { rows } = await env.DB.query(requireToken(env), sql, params, "all", options.region);
    return rows as T[];
  }
  if (!env.DATABASE_URL) {
    throw new Error("No database available. See INSTALL.md for local setup.");
  }
  return localQuery(env.DATABASE_URL, sql, params) as Promise<T[]>;
}
