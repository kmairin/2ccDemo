/**
 * One-time bootstrap for the DEPLOYED database.
 *
 * The deploy pipeline ships the Worker but never creates tables, and the
 * platform gives the app no connection string to point drizzle-kit at — so a
 * freshly deployed app answers 500 on every page that reads data. This route
 * runs the committed schema and demo data through the data service's SQL path,
 * once, so the live site has something to serve.
 *
 * It is dangerous by nature, so it is fenced four ways:
 *
 *   1. It does not exist unless `ADMIN_TOKEN` is set in the Loop dashboard.
 *      With no token configured the route answers 404 like any unknown path —
 *      it does not advertise itself.
 *   2. The token must be at least 24 characters, so a guessable one cannot arm it.
 *   3. It refuses to run against a database that already holds circles, unless
 *      `?force=1` is passed deliberately.
 *   4. It is POST only, and the token never appears in a URL or a log line.
 *
 * Delete this route, and unset the token, once the demo is over.
 */
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { BOOTSTRAP_STATEMENTS } from "../bootstrap-sql";
import { getDb, type DatabaseEnv } from "../db";
import { createLogger, type LoggerEnv } from "../logger";

type AdminEnv = DatabaseEnv & LoggerEnv & { ADMIN_TOKEN?: string };

const admin = new Hono<{ Bindings: AdminEnv }>();

/** The shortest token we will accept. Short secrets are guessable secrets. */
const MIN_TOKEN_LENGTH = 24;

/**
 * Compare without leaking length or position through timing. Not the weak link
 * in a system reachable only over TLS, but there is no reason to hand it away.
 */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

admin.post("/bootstrap", async (c) => {
  const configured = c.env.ADMIN_TOKEN;

  // Not armed: behave exactly like a route that was never written.
  if (!configured || configured.length < MIN_TOKEN_LENGTH) return c.notFound();

  const offered = c.req.header("x-admin-token") ?? "";
  if (!tokensMatch(offered, configured)) return c.notFound();

  const log = createLogger(c.env);
  const db = getDb(c.env);
  const force = c.req.query("force") === "1";

  // Refuse to overwrite a database that is already carrying data.
  let existing = 0;
  try {
    const rows = await db.execute(sql`select count(*)::int as n from circles`);
    // The data-service proxy hands rows back as POSITIONAL ARRAYS, not mapped
    // objects (src/db.ts says so for batch and staleRead). Reading `.n` here
    // silently produced undefined, so the guard never fired and a second run
    // tried to rebuild a populated database. Accept either shape.
    const first: unknown = (rows as unknown as unknown[])[0];
    existing = Array.isArray(first)
      ? Number(first[0] ?? 0)
      : Number((first as { n?: number } | undefined)?.n ?? 0);
  } catch {
    // No `circles` table yet — the expected state on a first run.
    existing = 0;
  }

  if (existing > 0 && !force) {
    return c.json(
      {
        status: "already_populated",
        circles: existing,
        hint: "Pass ?force=1 to run anyway. It will error on objects that already exist.",
      },
      409,
    );
  }

  const started = Date.now();
  let applied = 0;
  const failures: { index: number; statement: string; error: string }[] = [];

  for (const [index, statement] of BOOTSTRAP_STATEMENTS.entries()) {
    try {
      await db.execute(sql.raw(statement));
      applied++;
    } catch (err) {
      // Collect rather than abort: one duplicate index should not strand the
      // database half-built, and the response has to say exactly what failed.
      failures.push({
        index,
        statement: statement.slice(0, 120),
        error: err instanceof Error ? err.message : String(err),
      });
      if (failures.length > 25) break;
    }
  }

  log.info("bootstrap finished", { applied, failed: failures.length });

  return c.json(
    {
      status: failures.length === 0 ? "ok" : "partial",
      applied,
      total: BOOTSTRAP_STATEMENTS.length,
      failed: failures.length,
      ms: Date.now() - started,
      failures: failures.slice(0, 10),
    },
    failures.length === 0 ? 200 : 500,
  );
});

export default admin;
