/**
 * The page shell: one full HTML document, header, content, footer.
 *
 * Server-rendered Hono JSX. The only script in the whole product is four lines
 * of progressive enhancement so Esc closes the mobile nav (§10.4) — the nav
 * itself is a `<details>` disclosure and works with scripting off.
 *
 * Two rules from §10.4 shape this file:
 *   - The nav has **separate mobile and desktop siblings**. Forcing a
 *     `<details>` open at desktop is unreliable across engines.
 *   - `<summary>` gets **no** `aria-expanded` and **no** `role="button"`. The
 *     UA maps both already, and adding them breaks state reporting in some
 *     assistive tech.
 */

import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { Avatar } from "./components";
import { css, escScript, fontsHref } from "./theme";

/** Emitted ahead of `<html>` so `c.html(<Layout …/>)` is a complete document. */
const DOCTYPE = raw("<!doctype html>");

/** The signed-in member, or `null`/absent when signed out. */
export type LayoutUser = { name: string } | null;

export type LayoutProps = {
  /** Extra class on <body>, e.g. "page-index" for a tighter vertical rhythm. */
  bodyClass?: string;
  /** " · 2CC" is appended. The `<title>` is the real announcement (§10.4). */
  title: string;
  description?: string;
  user?: LayoutUser;
  /** "circles" | "gatherings" | "calendar" | "host" | "account". */
  active?: string;
  /**
   * The mobile action bar. Rendered after `</main>` and it sets
   * `class="has-actionbar"` on `<body>`, which drives `main`'s bottom padding
   * without a `:has()` dependency. `/circles/:slug` and `/events/:slug` only.
   */
  actionBar?: Child;
  children?: Child;
};

type NavItem = { key: string; label: string; href: string };

const NAV: readonly NavItem[] = [
  { key: "circles", label: "Circles", href: "/circles" },
  { key: "gatherings", label: "Gatherings", href: "/events" },
  { key: "calendar", label: "Calendar", href: "/calendar" },
];

/** First name only — the header has room for one word, not a full name. */
function firstName(name: string): string {
  const trimmed = name.trim();
  return trimmed === "" ? "Member" : trimmed.split(/\s+/)[0];
}

export function Layout(props: LayoutProps) {
  const { bodyClass, title, description, user, active, actionBar, children } = props;
  const signedIn = user != null;
  const accountLabel = signedIn ? firstName(user.name) : "Join";

  const items: NavItem[] = [...NAV];
  if (signedIn) items.push({ key: "host", label: "Host", href: "/host" });

  return (
    <>
      {DOCTYPE}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          {/* Without viewport-fit=cover every env(safe-area-inset-*) silently
              returns 0, and the action bar sits under the home indicator. */}
          <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
          <meta name="color-scheme" content="dark" />
          <meta name="theme-color" content="#0A0A0B" />
          <title>{`${title} · 2CC`}</title>
          <meta
            name="description"
            content={description ?? "A private circle of gatherings, by invitation."}
          />
          {/* An inline monogram mark. Without an icon the browser requests
              /favicon.ico and logs a 404 on every page — one console error is
              one too many, and there is no image file to serve. */}
          <link
            rel="icon"
            href={
              "data:image/svg+xml," +
              encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
                  '<rect width="32" height="32" fill="#0A0A0B"/>' +
                  '<text x="16" y="22" text-anchor="middle" font-family="Georgia,serif" ' +
                  'font-size="15" fill="#AE9463">2C</text></svg>',
              )
            }
          />
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
          <link rel="stylesheet" href={fontsHref} />
          <style dangerouslySetInnerHTML={{ __html: css }} />
        </head>
        <body class={[actionBar !== undefined ? "has-actionbar" : "", bodyClass ?? ""].filter(Boolean).join(" ") || undefined}>
          <a class="skip-link" href="#main">
            Skip to content
          </a>

          <header class="site-header">
            <div class="shell header-inner">
              {/* A link, not a heading. */}
              <a class="wordmark" href="/">
                2CC
              </a>

              <nav class="nav-desktop" aria-label="Primary">
                {items.map((item) => (
                  <a
                    class="nav-link"
                    href={item.href}
                    aria-current={active === item.key ? "page" : undefined}
                  >
                    {item.label}
                  </a>
                ))}
                {signedIn ? (
                  <>
                    <a class="nav-link" href="/account" aria-current={active === "account" ? "page" : undefined}>
                      <Avatar name={user.name} />
                      <span style="margin-inline-start:8px">{accountLabel}</span>
                    </a>
                    {/* Signing out is a state change, so it posts. Without this
                        there is no way to leave or switch accounts by clicking. */}
                    <form method="post" action="/auth/logout" class="nav-signout">
                      <button type="submit" class="nav-link nav-link--plain">
                        Sign out
                      </button>
                    </form>
                  </>
                ) : (
                  <a class="btn btn--ghost" href="/join">
                    Join
                  </a>
                )}
              </nav>

              <details class="nav-mobile">
                <summary>Menu</summary>
                <nav class="nav-panel" aria-label="Primary">
                  {items.map((item) => (
                    <a href={item.href} aria-current={active === item.key ? "page" : undefined}>
                      {item.label}
                    </a>
                  ))}
                  {signedIn ? (
                    <>
                      <a href="/account" aria-current={active === "account" ? "page" : undefined}>
                        {accountLabel}
                      </a>
                      <form method="post" action="/auth/logout" class="nav-signout">
                        <button type="submit" class="nav-link--plain">Sign out</button>
                      </form>
                    </>
                  ) : (
                    <a href="/join">Join</a>
                  )}
                </nav>
              </details>
            </div>
          </header>

          <main class="site-main" id="main" tabindex={-1}>
            {children}
          </main>

          {/* After </main>, so tab order matches visual order (§10.1). */}
          {actionBar}

          <footer class="site-footer">
            <div class="shell footer-inner">
              <span class="wordmark wordmark--quiet footer-spacer">2CC</span>
              <span class="meta">By invitation</span>
              <a class="footer-link" href="/calendar">
                Calendar
              </a>
            </div>
          </footer>

          <script dangerouslySetInnerHTML={{ __html: escScript }} />
        </body>
      </html>
    </>
  );
}
