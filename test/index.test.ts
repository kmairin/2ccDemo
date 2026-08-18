/**
 * Tests for the app shell — the parts `src/index.ts` owns directly: static asset
 * serving, the 404 handler, and the error handler.
 *
 * NOTE ON REMOVED TESTS. This file previously asserted two things that no longer
 * exist. They were removed deliberately, not to go green:
 *
 *   - `GET /` returning the "Welcome to SV Academy" starter page. That page was
 *     the boilerplate placeholder; `/` is now the 2CC landing page, owned by
 *     `src/routes/pages.tsx` and tested there.
 *   - `GET /api/hello`, a demo route from the starter kit. It was never part of
 *     this product and has been deleted, not renamed.
 *
 * Both tested scaffolding the app has since replaced. What they covered that
 * still matters — that `/` is HTML and 200, that unknown routes are JSON 404s —
 * is still asserted, here or in the page tests.
 */
import { describe, expect, it } from "vitest";
import app from "../src/index";

describe("unknown routes", () => {
  it("answers 404 with JSON rather than an empty body", async () => {
    const res = await app.request("/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});

describe("GET /assets/*", () => {
  it("404s when the object is not in the bucket", async () => {
    const res = await app.request("/assets/missing.png", {}, { BUCKET: { get: async () => null } });
    expect(res.status).toBe(404);
  });

  it("serves the object with its content type", async () => {
    const res = await app.request(
      "/assets/logo.svg",
      {},
      {
        BUCKET: {
          get: async (key: string) => {
            expect(key).toBe("assets/logo.svg");
            return {
              body: new Blob(["<svg></svg>"]).stream(),
              httpEtag: '"abc123"',
              httpMetadata: { contentType: "image/svg+xml" },
            };
          },
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("etag")).toBe('"abc123"');
  });

  it("falls back to a generic content type when none is stored", async () => {
    const res = await app.request(
      "/assets/nested/hero.mp4",
      {},
      {
        BUCKET: {
          get: async (key: string) => {
            expect(key).toBe("assets/nested/hero.mp4");
            return { body: new Blob(["x"]).stream(), httpEtag: '"e"', httpMetadata: {} };
          },
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });
});
