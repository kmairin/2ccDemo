/**
 * Identifiers people see, and identifiers they do not.
 *
 * Pure functions on purpose — no Hono, no `env`, no database. Everything here
 * is callable from a test without standing anything up.
 *
 * Randomness always comes from the Web Crypto API (`crypto.getRandomValues`),
 * which exists both in the Workers runtime and in Node. `Math.random` is never
 * used: it is seeded per isolate and predictable, and these codes end up in
 * URLs (`/account/tickets/:code`) where guessing one is reading someone else's
 * ticket.
 */

/**
 * 32 characters, chosen so a code can be read down a phone line or off a
 * screen: no `I`/`1`, no `O`/`0`. 32 divides 256 exactly, which is what lets
 * `byte % 32` below be uniform — with an alphabet of any other length that
 * modulo would quietly favour its first few characters.
 */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** `length` characters of unbiased randomness from the unambiguous alphabet. */
function randomChars(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/** A primary key. Every `id` column in `src/schema.ts` is filled from here. */
export function newId(): string {
  return crypto.randomUUID();
}

/**
 * The reference on a mock checkout — `2CC-8F3K2M`. Short enough to quote,
 * long enough that 32^6 (about a billion) makes a collision on the unique
 * index a non-event rather than a routine retry.
 */
export function orderReference(): string {
  return `2CC-${randomChars(6)}`;
}

/**
 * A ticket code — `2CC-TKT-4QX9`. Shorter than an order reference because it
 * is shown large on the ticket screen, and it is scoped by the booking it
 * belongs to rather than being a global secret.
 */
export function ticketCode(): string {
  return `2CC-TKT-${randomChars(4)}`;
}

/**
 * A name to a URL segment: "Cap Ferrat Sailing Society" -> "cap-ferrat-sailing-society".
 *
 * Accents are folded first ("Salt & Ember, Lisboa" keeps its letters, "Sebastián"
 * becomes "sebastian") so a host typing their own language does not end up with
 * an empty slug.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    // Strip the combining marks that NFKD just split off.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The first free slug in the `base`, `base-2`, `base-3`… series.
 *
 * `taken` is whatever asks the database — keeping it a callback is what makes
 * this testable without one:
 *
 *   const slug = await uniqueSlug(slugify(name), async (s) => {
 *     const [row] = await db.select({ id: circles.id }).from(circles)
 *       .where(eq(circles.slug, s)).limit(1);
 *     return row !== undefined;
 *   });
 *
 * After 50 numbered attempts it stops counting and reaches for randomness —
 * a name that collided 50 times is a name where `-51` tells the member nothing
 * anyway. Throws only if even that keeps colliding, which means `taken` is
 * broken rather than that the slugs are exhausted.
 */
export async function uniqueSlug(
  base: string,
  taken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  if (!(await taken(base))) return base;

  for (let suffix = 2; suffix <= 50; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!(await taken(candidate))) return candidate;
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = `${base}-${randomChars(4).toLowerCase()}`;
    if (!(await taken(candidate))) return candidate;
  }

  throw new Error(`uniqueSlug: no free slug for "${base}" after 60 attempts`);
}
