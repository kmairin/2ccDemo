/**
 * Generates `src/bootstrap-sql.ts` — the schema and demo data as an ordered list
 * of SQL statements.
 *
 * WHY THIS EXISTS. `npm run db:migrate` applies migrations to the database on
 * YOUR machine. The deployed app reaches its own database through the platform's
 * data service, with no connection string anywhere, so there is nothing for
 * drizzle-kit to point at — and the deploy pipeline never creates tables. A
 * freshly deployed app therefore answers 500 on every page that reads data,
 * which is exactly what happened on the first deploy of this project.
 *
 * The data service does expose a general SQL path (`env.DB.query`), so the app
 * can create its own schema once, from inside a request. This script bakes the
 * statements in; `POST /api/admin/bootstrap` runs them.
 *
 *   npm run db:bundle     # after any schema or seed change
 *
 * Regenerate and commit whenever `src/schema.ts` or `scripts/seed.mjs` changes,
 * or the deployed database will be built from a stale picture.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/loop_dev";

const PG_DUMP =
  process.env.PG_DUMP ?? "/opt/homebrew/opt/postgresql@16/bin/pg_dump";

/**
 * Split on semicolons, but only those outside a single-quoted string. Circle
 * descriptions contain punctuation, and a naive `split(";")` would cut a
 * statement in half and produce SQL that fails halfway through the bootstrap.
 */
function splitStatements(sql) {
  const out = [];
  let buf = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    // A `--` comment must be dropped BEFORE looking for a terminator: pg_dump's
    // own headers read "-- Name: circles; Type: TABLE; Schema: public" and those
    // semicolons would otherwise split one CREATE TABLE into four fragments.
    if (!inString && ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (ch === "'") {
      // '' inside a string is an escaped quote, not a terminator.
      if (inString && sql[i + 1] === "'") {
        buf += "''";
        i++;
        continue;
      }
      inString = !inString;
      buf += ch;
      continue;
    }
    if (ch === ";" && !inString) {
      const s = buf.trim();
      if (s) out.push(s);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

const raw = execFileSync(
  PG_DUMP,
  [
    "--no-owner",
    "--no-privileges",
    "--no-comments",
    "--inserts",
    "--quote-all-identifiers",
    // Sessions are per-browser and must not be copied into production.
    // The TABLE still has to exist, so only its DATA is excluded.
    "--exclude-table-data=public.sessions",
    // drizzle-kit's own ledger lives in another schema and is meaningless there.
    "--exclude-schema=drizzle",
    DATABASE_URL,
  ],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);

// psql meta-commands (\restrict, \unrestrict, \connect) are not SQL and carry
// no terminating semicolon, so they glue themselves to the next statement.
// Strip them line-wise before anything else looks at the text.
const sqlOnly = raw
  .split("\n")
  .filter((line) => !/^\\/.test(line.trim()))
  .join("\n");

const statements = splitStatements(sqlOnly)
  .map((s) => s.replace(/^--.*$/gm, "").trim())
  .filter(Boolean)
  // `SET`, `SELECT pg_catalog...` and ownership lines are pg_dump session
  // preamble; the data service runs each statement on its own connection and
  // rejects some of them outright.
  .filter((s) => !/^(SET|SELECT pg_catalog)/i.test(s))
  .filter((s) => !/^CREATE SCHEMA/i.test(s));

/**
 * Make every statement safe to run twice.
 *
 * Two isolates can take a first request at the same moment and both decide the
 * database is empty. Without this, the loser leaves a half-built schema behind.
 * With it, a re-run is a no-op instead of a mess.
 */
const idempotent = statements.map((s) => {
  if (/^CREATE TABLE /i.test(s)) return s.replace(/^CREATE TABLE /i, "CREATE TABLE IF NOT EXISTS ");
  if (/^CREATE UNIQUE INDEX /i.test(s))
    return s.replace(/^CREATE UNIQUE INDEX /i, "CREATE UNIQUE INDEX IF NOT EXISTS ");
  if (/^CREATE INDEX /i.test(s)) return s.replace(/^CREATE INDEX /i, "CREATE INDEX IF NOT EXISTS ");
  if (/^INSERT INTO /i.test(s)) return `${s} ON CONFLICT DO NOTHING`;
  // ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS; make it conditional.
  const constraint = s.match(/^ALTER TABLE ONLY "([^"]+)"\."([^"]+)"\s+ADD CONSTRAINT "([^"]+)"/i);
  if (constraint) {
    const [, schema, table, name] = constraint;
    return `DO $$ BEGIN ${s}; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$`
      .replace(/\s+/g, " ")
      .replace("__NAME__", `${schema}.${table}.${name}`);
  }
  return s;
});

const kinds = {};
for (const s of idempotent) {
  const k = (s.match(/^[A-Z ]+/i) || ["?"])[0].trim().split(/\s+/).slice(0, 2).join(" ");
  kinds[k] = (kinds[k] || 0) + 1;
}

const body = `/**
 * GENERATED by \`npm run db:bundle\` — do not edit by hand.
 *
 * The schema and demo data for this app, as ordered SQL statements. Used once by
 * \`POST /api/admin/bootstrap\` to build the deployed database, which the deploy
 * pipeline does not create. See scripts/bootstrap-sql.mjs for why.
 *
 * Regenerate after any change to src/schema.ts or scripts/seed.mjs.
 */

/** ${idempotent.length} statements: ${Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(", ")}. */
export const BOOTSTRAP_STATEMENTS: readonly string[] = ${JSON.stringify(idempotent, null, 0)};
`;

writeFileSync("src/bootstrap-sql.ts", body);
console.log(
  `src/bootstrap-sql.ts: ${idempotent.length} statements, ${(body.length / 1024).toFixed(0)} KB`,
);
for (const [k, v] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}
