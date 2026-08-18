/**
 * Sign-in, sessions, and the two small pieces of state that hang off a session:
 * a flash message and a one-time purchase nonce.
 *
 * Auth here is deliberately thin (spec, non-goals: no password, no magic link).
 * The session row id IS the cookie value, so validating a request is one
 * primary-key lookup, and revoking is one delete.
 *
 * Nothing in this file renders anything. Pages and JSON routes decide what a
 * missing user means — `requireUser` 302s, `requireApiUser` 401s — and both
 * hand back a `Response` for the handler to return rather than throwing.
 */
import { and, eq, gt, isNotNull } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getDb, type DatabaseEnv } from "./db";
import { newId } from "./lib/ids";
import type { LoggerEnv } from "./logger";
import { createLogger } from "./logger";
import { sessions, users, type Session, type User } from "./schema";

/** Everything in this file needs the database and the log level, nothing else. */
export type AuthEnv = DatabaseEnv & LoggerEnv;

/** Any Hono context whose bindings cover `AuthEnv` — pages and JSON alike. */
export type AuthContext = Context<{ Bindings: AuthEnv }>;

/** The cookie name the contract fixes. Do not rename it. */
export const SESSION_COOKIE = "2cc_session";

/** 30 days, expressed once and used for both the row and the cookie. */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** A signed-in request: the person, and the session row they arrived on. */
export interface SessionUser {
  session: Session;
  user: User;
}

/**
 * The email column is a plain `text` with a unique index and no case folding,
 * so `A@x.com` and `a@x.com` would be two different members. Normalise on the
 * way in — every lookup and every insert goes through this.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** True when this request arrived over TLS. Local http dev must not get `Secure`. */
function isSecureRequest(c: AuthContext): boolean {
  return new URL(c.req.url).protocol === "https:";
}

/** Look a member up by email, case-insensitively. Exported so the join form can
 * tell a returning member (name optional) from a new one (name required). */
export async function findUserByEmail(env: AuthEnv, email: string): Promise<User | null> {
  const db = getDb(env);
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, normaliseEmail(email)))
    .limit(1);
  return row ?? null;
}

/**
 * Find-or-create the member, then open a session for them.
 *
 * `name` is only read when the member is new; a returning member keeps the name
 * they already have. Creating a member with a blank name throws rather than
 * writing an empty string — validate at the route boundary and never reach here
 * with one.
 */
export async function signIn(env: AuthEnv, email: string, name: string): Promise<Session> {
  const db = getDb(env);
  const log = createLogger(env);
  const normalised = normaliseEmail(email);

  let user = await findUserByEmail(env, normalised);
  if (!user) {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("signIn: a new member needs a name");
    }
    const [created] = await db
      .insert(users)
      .values({ id: newId(), email: normalised, name: trimmed })
      // Two sign-ins racing on the same new email: the loser takes the winner's
      // row instead of failing the request on the unique index.
      .onConflictDoNothing({ target: users.email })
      .returning();
    user = created ?? (await findUserByEmail(env, normalised));
    if (!user) throw new Error("signIn: could not create or find the member");
    log.info("member created", { userId: user.id });
  }

  const [session] = await db
    .insert(sessions)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    })
    .returning();
  if (!session) throw new Error("signIn: session insert returned nothing");

  log.debug("session opened", { userId: user.id });
  return session;
}

/**
 * Write the session cookie. `Secure` is set only on https so the same code
 * works against `http://localhost:8787`, where a Secure cookie is dropped.
 */
export function setSessionCookie(c: AuthContext, session: Session): void {
  setCookie(c, SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    secure: isSecureRequest(c),
  });
}

/** Drop the cookie. Same attributes as `setSessionCookie` so the browser matches it. */
export function clearSessionCookie(c: AuthContext): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: isSecureRequest(c) });
}

/**
 * One lookup per request, memoised on the Request object.
 *
 * A page reads the current member several times — the header, the action area,
 * the flash — and this runs on every one of them, so the second call must not
 * be a second round trip. The key is the Request itself, so nothing survives
 * into the next request.
 */
const perRequest = new WeakMap<Request, Promise<SessionUser | null>>();

/**
 * The member this request belongs to, or `null` when there is no cookie, the
 * session is gone, or it has expired. Expiry is checked in SQL, not in JS, so a
 * stale row can never come back as a live one.
 */
export function currentUser(c: AuthContext): Promise<SessionUser | null> {
  const cached = perRequest.get(c.req.raw);
  if (cached) return cached;
  const pending = loadSessionUser(c);
  perRequest.set(c.req.raw, pending);
  return pending;
}

async function loadSessionUser(c: AuthContext): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;

  const db = getDb(c.env);
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, token), gt(sessions.expiresAt, new Date())))
    .limit(1);

  return row ?? null;
}

/**
 * A page that needs a member. Returns the member, or the 302 to send them to
 * the join form — handlers do:
 *
 *   const me = await requireUser(c);
 *   if (me instanceof Response) return me;
 */
export async function requireUser(c: AuthContext): Promise<SessionUser | Response> {
  const me = await currentUser(c);
  if (me) return me;
  const url = new URL(c.req.url);
  const next = `${url.pathname}${url.search}`;
  return c.redirect(`/join?next=${encodeURIComponent(next)}`, 302);
}

/** The JSON equivalent: 401 with a body, never a redirect. */
export async function requireApiUser(c: AuthContext): Promise<SessionUser | Response> {
  const me = await currentUser(c);
  if (me) return me;
  return c.json({ error: "Sign in required" }, 401);
}

/** Delete the session row and clear the cookie. Safe to call when signed out. */
export async function signOut(c: AuthContext): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const db = getDb(c.env);
    await db.delete(sessions).where(eq(sessions.id, token));
  }
  clearSessionCookie(c);
}

/* ------------------------------------------------------------------ flash */

/**
 * Park a one-line result on the session, to be shown after the 302.
 *
 * On the session row rather than in the query string on purpose: a query string
 * survives a reload and re-announces a result that already happened.
 */
export async function setFlash(env: AuthEnv, sessionId: string, message: string): Promise<void> {
  const db = getDb(env);
  await db.update(sessions).set({ flash: message }).where(eq(sessions.id, sessionId));
}

/**
 * Read the flash and clear it in the same call, so a render can never show it
 * twice. The UPDATE only runs when there is something to clear — this is on the
 * render path of every page.
 */
export async function takeFlash(
  env: AuthEnv,
  session: Pick<Session, "id" | "flash">,
): Promise<Flash | null> {
  if (!session.flash) return null;
  const db = getDb(env);
  await db
    .update(sessions)
    .set({ flash: null })
    .where(and(eq(sessions.id, session.id), isNotNull(sessions.flash)));
  return parseFlash(session.flash);
}

/**
 * A flash carries a tone as well as a message.
 *
 * Without one, a refusal ("you need a credit for this circle") renders in the
 * same neutral band as a confirmation ("your place is booked") — an error that
 * does not look like an error. The tone is encoded as a `warn:` / `confirm:`
 * prefix on the stored string rather than a second column, so no migration is
 * needed and an un-prefixed message still works.
 */
export type FlashTone = "confirm" | "warn";
export interface Flash {
  tone: FlashTone;
  message: string;
}

/** Build the stored form. Use this rather than writing the prefix by hand. */
export function flashMessage(tone: FlashTone, message: string): string {
  return `${tone}:${message}`;
}

/** Read the stored form back. An un-prefixed legacy string reads as `confirm`. */
export function parseFlash(stored: string): Flash {
  const at = stored.indexOf(":");
  const head = at === -1 ? "" : stored.slice(0, at);
  if (head === "warn" || head === "confirm") {
    return { tone: head, message: stored.slice(at + 1) };
  }
  return { tone: "confirm", message: stored };
}

/* ------------------------------------------------- one-time purchase nonce */

/**
 * The unambiguous alphabet order references are drawn from. Same set as
 * `src/lib/ids.ts` — no `I`/`1`, no `O`/`0` — repeated here because the nonce
 * derivation below needs to map bytes into it and that file exports only
 * finished ids.
 */
const REFERENCE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * A fresh nonce for one "Buy" button. Put it in a hidden field on the checkout
 * form; `purchase()` burns it.
 */
export function issuePurchaseNonce(): string {
  return crypto.randomUUID();
}

/**
 * The order reference a given nonce will produce — the whole one-shot mechanism.
 *
 * There is nowhere to store a nonce: `orders` has no column for one and this
 * worker does not own `src/schema.ts`. So instead of storing it, the nonce is
 * *spent into* `orders.reference`, which already carries a unique index
 * (`orders_reference_idx`). Deriving the reference from the nonce makes the
 * first POST write the burn record and the second POST collide with it — the
 * database enforces once-only, not a check in the handler that two fast taps
 * can race past. A replay is then recognisable by looking the reference up.
 *
 * 6 characters over a 32-symbol alphabet is the same space `orderReference()`
 * uses, so this changes nothing about how a reference looks or reads.
 */
export async function purchaseReference(nonce: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`2cc:purchase:${nonce}`)),
  );
  let out = "";
  for (let i = 0; i < 6; i++) {
    // 32 divides 256 exactly, so the modulo is uniform.
    out += REFERENCE_ALPHABET[digest[i]! % REFERENCE_ALPHABET.length];
  }
  return `2CC-${out}`;
}
