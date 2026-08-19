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
import { css, escScript, fontsHref, pageColor } from "./theme";

/** Emitted ahead of `<html>` so `c.html(<Layout …/>)` is a complete document. */
const DOCTYPE = raw("<!doctype html>");

/** The signed-in member, or `null`/absent when signed out. */
export type LayoutUser = { name: string } | null;

/* ------------------------------------------------- the two injected slots */

/**
 * Two things in the header depend on the signed-in member and on nothing the
 * page knows: the demo balance, and the copy of the account that the owner
 * asked to be mirrored into `localStorage`.
 *
 * Threading either through `Layout` would mean a database read at all
 * twenty-eight call sites. Instead `Layout` renders an empty, uniquely marked
 * slot, and one middleware — `walletHeader` in `src/routes/wallet.tsx` — fills
 * it in on the way out, the same way `src/index.ts` already stamps the theme
 * onto `<html>`.
 *
 * The markers are **exported constants rendered through `raw()`**, so the string
 * the middleware searches for is character-for-character the string that was
 * written. A missed match leaves an empty span, which is invisible — the page
 * still renders, just without the chip.
 */
export const HEADER_SLOT = {
  desktop: '<span class="hdr-balance" data-balance-slot="desktop"></span>',
  mobile: '<span class="hdr-balance" data-balance-slot="mobile"></span>',
  panel: '<span data-balance-slot="panel"></span>',
  /** Sits just before the closing `</body>` script. Replaced by the mirror. */
  account: '<span data-account-slot=""></span>',
} as const;

/** The balance chip the middleware writes into the header slots. */
export function headerBalanceHtml(amount: string, where: "desktop" | "mobile" | "panel"): string {
  if (where === "panel") {
    return `<a href="/account/wallet"><span>Balance</span> <span class="num">${amount}</span></a>`;
  }
  const cls = where === "mobile" ? "hdr-balance hdr-balance--compact" : "hdr-balance";
  return (
    `<a class="${cls}" href="/account/wallet" aria-label="Balance ${amount}">` +
    `<span class="hdr-balance-label" aria-hidden="true">Balance</span>` +
    `<span class="num hdr-balance-amount">${amount}</span></a>`
  );
}

export type LayoutProps = {
  /** Extra class on <body>, e.g. "page-index" for a tighter vertical rhythm. */
  bodyClass?: string;
  /** " · 2CC" is appended. The `<title>` is the real announcement (§10.4). */
  title: string;
  description?: string;
  user?: LayoutUser;
  /** "communities" | "events" | "calendar" | "host" | "account". */
  active?: string;
  /**
   * The mobile action bar. Rendered after `</main>` and it sets
   * `class="has-actionbar"` on `<body>`, which drives `main`'s bottom padding
   * without a `:has()` dependency. `/communities/:slug` and `/events/:slug` only.
   */
  actionBar?: Child;
  children?: Child;
};

type NavItem = { key: string; label: string; href: string };

const NAV: readonly NavItem[] = [
  // The owner's words, not invented ones, and every surface reachable by
  // clicking. Countries, cities, search and profiles all existed and none of
  // them were in the header, so none of them could be found.
  { key: "countries", label: "Countries", href: "/countries" },
  { key: "communities", label: "Communities", href: "/communities" },
  { key: "events", label: "Events", href: "/events" },
  { key: "calendar", label: "Calendar", href: "/calendar" },
  { key: "search", label: "Search", href: "/search" },
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
          {/* Both themes ship, so form controls and scrollbars are told so.
              The two theme-colors cover the no-cookie case; when a visitor has
              chosen explicitly, the middleware in src/index.ts collapses them
              to the one that is actually rendering. */}
          <meta name="color-scheme" content="light dark" />
          <meta name="theme-color" content={pageColor.light} media="(prefers-color-scheme: light)" />
          <meta name="theme-color" content={pageColor.dark} media="(prefers-color-scheme: dark)" />
          <title>{`${title} · 2CC`}</title>
          <meta
            name="description"
            content={description ?? "Communities, activities and experiences around the world. One World. Endless Connections."}
          />
          {/* An inline monogram mark. Without an icon the browser requests
              /favicon.ico and logs a 404 on every page — one console error is
              one too many, and there is no image file to serve.

              It stays an ink tile in both themes: a favicon cannot follow the
              page, and a mark that changed colour under the visitor would read
              as a different site rather than as a preference. */}
          <link
            rel="icon"
            href={
              "data:image/svg+xml," +
              encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
                  '<rect width="32" height="32" fill="#14130F"/>' +
                  '<text x="16" y="22" text-anchor="middle" font-family="Georgia,serif" ' +
                  'font-size="15" fill="#C6A87A">2C</text></svg>',
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
                    {raw(HEADER_SLOT.desktop)}
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

              {/* Sign-in must be visible without opening anything. Buried in the
                  disclosure, the only control on a phone was "Menu", and the way
                  in to the whole product was invisible. */}
              <div class="nav-mobile-actions">
                {signedIn ? (
                  <>
                    {raw(HEADER_SLOT.mobile)}
                    <a class="nav-link" href="/account" aria-label={`Account, ${accountLabel}`}>
                      <Avatar name={user.name} />
                    </a>
                  </>
                ) : (
                  <a class="btn btn--primary btn--compact" href="/join">
                    Sign in
                  </a>
                )}
              </div>
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
                      {raw(HEADER_SLOT.panel)}
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
              <span class="meta">One World. Endless Connections.</span>
              <a class="footer-link" href="/calendar">
                Calendar
              </a>
              {/* Two words and a rule, not a switch widget. It posts, so it
                  works with scripting off; which of the two is live is decided
                  in CSS from `data-theme` and `prefers-color-scheme`, so this
                  markup is the same on every page. `POST /theme` sends the
                  visitor back to the page they were on. */}
              <form class="theme-switch" method="post" action="/theme">
                <span class="theme-switch-label" id="theme-switch-label">
                  Theme
                </span>
                <button
                  class="theme-btn"
                  type="submit"
                  name="theme"
                  value="light"
                  aria-describedby="theme-switch-label"
                >
                  Light
                </button>
                <button
                  class="theme-btn"
                  type="submit"
                  name="theme"
                  value="dark"
                  aria-describedby="theme-switch-label"
                >
                  Dark
                </button>
              </form>
            </div>
          </footer>

          {signedIn ? raw(HEADER_SLOT.account) : null}
          <script dangerouslySetInnerHTML={{ __html: escScript }} />
        </body>
      </html>
    </>
  );
}
