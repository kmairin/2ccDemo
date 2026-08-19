/**
 * Is there a Postgres to test against?
 *
 * Most of this suite is deliberately integration-level: it compares what a page
 * or an endpoint renders against what the database actually holds, in the same
 * test. That is what caught a correlated subquery silently returning 0 for every
 * community's member count — a bug that typechecked, looked plausible in the JSON,
 * and no mock would have exposed.
 *
 * The deploy pipeline runs `npm test` on a runner with **no database**, and
 * `.github/workflows/deploy.yml` is managed by Loop and must not be edited. So
 * the database-backed suites check for a reachable Postgres and skip themselves
 * loudly when there is not one, rather than failing the deploy on missing
 * infrastructure or — far worse — being quietly rewritten into mocks that assert
 * nothing.
 *
 * This means CI's `npm test` is a *weaker* gate than yours. Locally, with
 * Postgres running, everything executes. Treat `npm test` plus `npm run e2e` on
 * your own machine as the real gate before you push.
 */
import postgres from "postgres";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/loop_dev";

/** The env a handler sees locally: no data-service binding, so `src/db.ts` dials Postgres. */
export const env = { DATABASE_URL };

async function probe(): Promise<boolean> {
  const client = postgres(DATABASE_URL, { max: 1, connect_timeout: 3, idle_timeout: 1 });
  try {
    // Any table from the app's own migration proves both "reachable" and "migrated".
    await client`select 1 from circles limit 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

export const hasDatabase = await probe();

if (!hasDatabase) {
  // Loud on purpose. A silent skip is how a suite stops meaning anything.
  console.warn(
    "\n  ⚠ No migrated Postgres at DATABASE_URL — the integration suites are SKIPPED.\n" +
      "    They are the real gate. Run them locally:\n" +
      "      brew services start postgresql@16 && npm run db:migrate && npm run seed && npm test\n",
  );
}
