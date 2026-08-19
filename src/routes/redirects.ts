/**
 * The old vocabulary's URLs, kept alive.
 *
 * `/circles` became `/communities` and `/passes/` became `/packages/` when the
 * product took the owner's words. Links already sent, bookmarks and open tabs
 * still point at the old paths, so every one of them is answered with a
 * redirect rather than a 404:
 *
 *   /circles                                  -> /communities
 *   /circles/:slug                            -> /communities/:slug
 *   /circles/:slug/join                       -> /communities/:slug/join
 *   /circles/:slug/passes/:id/checkout        -> /communities/:slug/packages/:id/checkout
 *   /circles/:slug/passes/:id/buy             -> /communities/:slug/packages/:id/buy
 *   /host/circles(/...)                       -> /host/communities(/...)
 *   /api/circles(/...)                        -> /api/communities(/...)
 *
 * Written as a prefix rewrite rather than one rule per route, so the host
 * console's sub-paths (`/host/circles/:slug/packages`, `.../events`) are
 * covered too and nothing has to be added here when a new child route appears.
 *
 * The query string is carried over: `/circles?category=sailing` and a checkout
 * link's `?next=` both survive the move.
 *
 * GET gets a 301 — it is permanent and it is what a bookmark should learn.
 * Anything else gets a 308, which is the same promise but keeps the method and
 * the body; a 301 or 302 would turn an old page's `POST .../join` into a GET
 * and quietly lose it.
 */
import { Hono } from "hono";

/** The new path for an old one, or null when the path was never renamed. */
export function renamedPath(path: string): string | null {
  for (const [from, to] of [
    ["/host/circles", "/host/communities"],
    ["/api/circles", "/api/communities"],
    ["/circles", "/communities"],
  ] as const) {
    if (path !== from && !path.startsWith(`${from}/`)) continue;
    // `/passes/` only ever appears under a community, so the swap is safe here.
    return to + path.slice(from.length).replace("/passes/", "/packages/");
  }
  return null;
}

const redirects = new Hono();

redirects.use("*", async (c, next) => {
  const to = renamedPath(c.req.path);
  if (to === null) return next();
  const { search } = new URL(c.req.url);
  return c.redirect(to + search, c.req.method === "GET" ? 301 : 308);
});

export default redirects;
