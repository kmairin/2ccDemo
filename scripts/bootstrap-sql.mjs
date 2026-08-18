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
 *
 * The file also carries a `BOOTSTRAP_VERSION` — a hash of the statements — which
 * is what lets an ALREADY-POPULATED deployed database notice that the seed
 * changed and rebuild itself. See that constant below, and src/ensure-schema.ts.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
    // `app_meta` is this script's own bookkeeping, not app data. A local
    // rebuild creates it here too, and dumping it would make the generated
    // file depend on whether the last local bootstrap had run — which would
    // change BOOTSTRAP_VERSION without the seed changing at all. The single
    // definition below is the only one.
    "--exclude-table=public.app_meta",
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
  if (/^CREATE TABLE /i.test(s)) {
    // Every table in this schema is keyed on "id". Declaring it inline means the
    // key exists even where a separate ALTER would not run, which is what makes
    // ON CONFLICT DO NOTHING actually do something.
    const withPk = s.replace(/\n\);?\s*$/, ',\n    PRIMARY KEY ("id")\n)');
    return withPk.replace(/^CREATE TABLE /i, "CREATE TABLE IF NOT EXISTS ");
  }
  if (/^CREATE UNIQUE INDEX /i.test(s))
    return s.replace(/^CREATE UNIQUE INDEX /i, "CREATE UNIQUE INDEX IF NOT EXISTS ");
  if (/^CREATE INDEX /i.test(s)) return s.replace(/^CREATE INDEX /i, "CREATE INDEX IF NOT EXISTS ");
  if (/^INSERT INTO /i.test(s)) return `${s} ON CONFLICT DO NOTHING`;
  // ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS. It is left as plain SQL
  // and allowed to fail on a re-run: the caller retries a failed chunk
  // statement by statement, so an already-present constraint costs nothing.
  const constraint = s.match(/^ALTER TABLE ONLY "([^"]+)"\."([^"]+)"\s+ADD CONSTRAINT "([^"]+)"/i);
  if (constraint) {
    const [, schema, table, name] = constraint;
    // Adding a constraint that is already there raises several different
    // SQLSTATEs depending on kind (primary key, unique, foreign key), and a
    // half-caught set leaves expected noise in the failure report that would
    // hide a real problem. These statements are purely "make sure this exists".
    return s.replace(/\s+/g, " ");
  }
  return s;
});

/**
 * Order the data by dependency, not alphabetically.
 *
 * pg_dump emits INSERTs in alphabetical table order — `bookings` long before the
 * `users` and `events` rows they point at. That only survives because pg_dump
 * adds foreign keys *after* the data. Run the same script a second time, when
 * the constraints already exist, and every child insert fails: 446 of 518
 * statements, which is exactly how the deployed database ended up with all ten
 * tables and no rows.
 *
 * Parents first makes the whole file re-runnable.
 */
const TABLE_ORDER = [
  "users", "circles", "packages", "events", "circle_members",
  "orders", "passes", "photos", "bookings", "sessions",
];

function tableOf(statement) {
  const m = statement.match(/^INSERT INTO "public"\."([^"]+)"/i);
  return m ? m[1] : null;
}

const ddlBefore = idempotent.filter((s) => /^CREATE TABLE/i.test(s));
const inserts = idempotent.filter((s) => /^INSERT INTO/i.test(s));
const ddlAfter = idempotent.filter((s) => !/^CREATE TABLE/i.test(s) && !/^INSERT INTO/i.test(s));

const unknownTables = [...new Set(inserts.map(tableOf))].filter((t) => t && !TABLE_ORDER.includes(t));
if (unknownTables.length) {
  throw new Error(
    `TABLE_ORDER is missing: ${unknownTables.join(", ")}. Add them in dependency order.`,
  );
}

const orderedInserts = inserts
  .map((s, i) => ({ s, i, rank: TABLE_ORDER.indexOf(tableOf(s)) }))
  .sort((a, b) => a.rank - b.rank || a.i - b.i)   // stable within a table
  .map((x) => x.s);

// Constraints last, so the data is already consistent when they are enforced.
const clears = [...TABLE_ORDER]
  .reverse()
  .map((t) => `DELETE FROM "public"."${t}"`)
  // Sessions belong to whoever is signed in right now; clearing them would sign
  // every visitor out on a rebuild.
  .filter((s) => !s.includes('"sessions"'));

/**
 * The version marker's home.
 *
 * FIRST, before the DELETEs, because `ensure-schema.ts` writes the version into
 * it at the end of a rebuild and the table has to exist by then — and because a
 * rebuild that half-fails must still leave somewhere to record what happened.
 *
 * It is deliberately NOT in TABLE_ORDER, so `clears` never empties it: the row
 * it holds is the record of which seed the database was built from, and wiping
 * that on every rebuild would defeat the whole point.
 *
 * Plain SQL, no `DO $$ … $$`: the deployed database is CockroachDB and has no
 * PL/pgSQL.
 */
const APP_META_DDL =
  'CREATE TABLE IF NOT EXISTS "public"."app_meta" ("key" text PRIMARY KEY, "value" text NOT NULL)';

const ordered = [APP_META_DDL, ...ddlBefore, ...clears, ...orderedInserts, ...ddlAfter];

/**
 * A fingerprint of everything above.
 *
 * WHY THIS EXISTS. `ensure-schema.ts` used to rebuild only when the world
 * looked *unbuilt* — no circles table, no rows, duplicate ids. That check
 * cannot see a change to the SEED. When every circle and gathering gained a
 * `cover_key` and 123 gallery rows gained an `object_key`, production was
 * already populated, so the rebuild never fired and the live site kept serving
 * the old photo-less rows no matter how many times it was deployed.
 *
 * The app stores this string in `app_meta.seed_version` after a rebuild and
 * compares it on the next boot. Change a single byte of the seed or the schema
 * and the hash moves, so the next deploy rebuilds exactly once and then stops.
 */
export const BOOTSTRAP_VERSION = createHash("sha256")
  .update(ordered.join("\n"))
  .digest("hex")
  .slice(0, 12);

const kinds = {};
for (const s of ordered) {
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

/**
 * Fingerprint of the statements below — SHA-256 of the joined array, first 12
 * hex characters.
 *
 * \`ensure-schema.ts\` stores this in \`app_meta.seed_version\` after a rebuild and
 * refuses to call the world "already built" until the stored value matches. A
 * seed change therefore rebuilds a populated database exactly once, instead of
 * being invisible to it. See scripts/bootstrap-sql.mjs.
 */
export const BOOTSTRAP_VERSION = ${JSON.stringify(BOOTSTRAP_VERSION)};

/** ${ordered.length} statements: ${Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(", ")}. */
export const BOOTSTRAP_STATEMENTS: readonly string[] = ${JSON.stringify(ordered, null, 0)};
`;

writeFileSync("src/bootstrap-sql.ts", body);
console.log(
  `src/bootstrap-sql.ts: ${ordered.length} statements, ${(body.length / 1024).toFixed(0)} KB, version ${BOOTSTRAP_VERSION}`,
);
for (const [k, v] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}
