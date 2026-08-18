/**
 * The light/dark switch — a display preference, kept in a cookie and applied
 * on the server.
 *
 * Light is the default and the design; dark is the alternative. The choice is
 * a cookie rather than `localStorage` because this app is plain forms and full
 * page loads: the server already knows the preference by the time it renders
 * `<html>`, so `data-theme` is stamped in the markup and there is no flash of
 * the wrong theme and no blocking inline script to prevent one.
 *
 * Three states, and the third is the important one:
 *   `light` / `dark` — an explicit choice, which wins over everything.
 *   no cookie        — no attribute is stamped, and `prefers-color-scheme`
 *                      decides in CSS (see `src/ui/theme.ts`).
 */

import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";

/** Not `HttpOnly`: this is a display preference, not a credential. */
export const THEME_COOKIE = "2cc_theme";

/** A year. Long enough that the choice feels permanent, short enough to expire. */
const THEME_MAX_AGE = 60 * 60 * 24 * 365;

export type Theme = "light" | "dark";

/** The two valid values, and nothing else — the cookie is user-controlled. */
function parseTheme(raw: string | undefined): Theme | null {
  return raw === "light" || raw === "dark" ? raw : null;
}

/**
 * The explicit choice on this request, or `null` when there is none.
 *
 * `null` is not "light": it means no attribute is stamped, which is what lets
 * `prefers-color-scheme` decide for a visitor who has never touched the switch.
 */
export function themeFromRequest(c: Context): Theme | null {
  return parseTheme(getCookie(c, THEME_COOKIE));
}

/**
 * A `next` we are willing to 302 to: a path on this site and nothing else.
 * `//evil.example` is a protocol-relative URL, so the second character matters
 * as much as the first. Same rule as `safeNext` in `src/routes/pages.tsx`.
 */
function safeNext(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith("/")) return undefined;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return undefined;
  return raw;
}

/**
 * Where to send the visitor back to.
 *
 * A posted `next` wins. Without one we fall back to the `Referer`, which the
 * browser sends on a same-origin form POST with the default referrer policy —
 * and which is checked against this request's own origin before any part of it
 * is used, so an off-site referrer can never become a redirect target. This is
 * what keeps the switch out of every page's markup: the footer form is
 * identical on all nineteen `Layout` call sites and needs no per-page value.
 */
function backTo(c: Context, posted: string | undefined): string {
  const explicit = safeNext(posted);
  if (explicit !== undefined) return explicit;

  const referer = c.req.header("referer");
  if (referer === undefined) return "/";
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return "/";
  }
  if (url.origin !== new URL(c.req.url).origin) return "/";
  return safeNext(url.pathname + url.search) ?? "/";
}

const theme = new Hono();

/**
 * Set the theme and go back where you came from.
 *
 * A POST because it changes state, and a 303 because the response to that
 * change is a page to GET, not the result of the POST. Works with scripting
 * off: it is a form with two submit buttons and no JavaScript anywhere near it.
 */
theme.post("/theme", async (c) => {
  const body = await c.req.parseBody();
  const chosen = parseTheme(typeof body.theme === "string" ? body.theme : undefined);
  const next = backTo(c, typeof body.next === "string" ? body.next : undefined);

  // An unrecognised value is a bad request, not a silent reset to light: the
  // only way to send one is by hand, and swallowing it hides the mistake.
  if (chosen === null) return c.text("Unknown theme.", 400);

  setCookie(c, THEME_COOKIE, chosen, {
    path: "/",
    sameSite: "Lax",
    maxAge: THEME_MAX_AGE,
    secure: new URL(c.req.url).protocol === "https:",
  });
  return c.redirect(next, 303);
});

export default theme;
