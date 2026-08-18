/**
 * Config for `npm run db:generate` and `npm run db:migrate`.
 *
 * Both commands run on YOUR machine against YOUR local Postgres — they never
 * touch the deployed database. `db:generate` writes SQL into `drizzle/` by
 * comparing `src/schema.ts` against the last migration; `db:migrate` applies
 * anything not yet applied locally.
 *
 * Commit everything in `drizzle/`. Those files are how your tables get created
 * anywhere other than the machine you first ran them on.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/loop_dev",
  },
});
