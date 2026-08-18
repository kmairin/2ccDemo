/**
 * Starter regression tests. These run in CI before every deploy, so a failure
 * here blocks the deploy instead of shipping a broken site.
 *
 * `app.request()` calls a route directly — no server, no network, milliseconds.
 * Copy this shape for every route you add, and add the unhappy path too.
 */
import { describe, expect, it } from "vitest";
import app from "../src/index";

describe("GET /", () => {
  it("serves the landing page as HTML", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("welcomes the student by name", async () => {
    const body = await (await app.request("/")).text();
    expect(body).toContain("Welcome to SV Academy");
  });
});

describe("GET /api/health", () => {
  it("reports ok", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /api/hello", () => {
  it("greets the world by default", async () => {
    const res = await app.request("/api/hello");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "Hello, world!" });
  });

  it("greets a supplied name", async () => {
    const res = await app.request("/api/hello?name=Somchai");
    expect(await res.json()).toEqual({ message: "Hello, Somchai!" });
  });

  // The unhappy path matters as much as the happy one — this is where bugs live.
  it("rejects an over-long name with 400, not a crash", async () => {
    const res = await app.request(`/api/hello?name=${"a".repeat(65)}`);
    expect(res.status).toBe(400);
  });
});

describe("unknown routes", () => {
  it("answers 404 with JSON rather than an empty body", async () => {
    const res = await app.request("/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});

describe("GET /assets/*", () => {
  it("404s when the object is not in the bucket", async () => {
    const res = await app.request("/assets/missing.png", {}, {
      BUCKET: { get: async () => null },
    });
    expect(res.status).toBe(404);
  });

  it("serves the object with its content type", async () => {
    const res = await app.request("/assets/logo.svg", {}, {
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
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("etag")).toBe('"abc123"');
  });

  it("falls back to a generic content type when none is stored", async () => {
    const res = await app.request("/assets/nested/hero.mp4", {}, {
      BUCKET: {
        get: async (key: string) => {
          expect(key).toBe("assets/nested/hero.mp4");
          return { body: new Blob(["x"]).stream(), httpEtag: '"e"', httpMetadata: {} };
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });
});
