import { Hono } from "hono";
import { createLogger, type LoggerEnv } from "./logger";

type Bindings = LoggerEnv & {
  /** File storage. Design assets from `design/assets/` live under the `assets/` prefix. */
  BUCKET?: R2Bucket;
};

const app = new Hono<{ Bindings: Bindings }>();

const SUBDOMAIN = "2ccdemo";
const STUDENT = "kmairin";

/**
 * The landing page, in the SV Academy design language: green-tinted ink ramp,
 * one green accent, Outfit for prose and JetBrains Mono for the terminal voice.
 * Self-contained on purpose — no build step, no CSS file to keep in sync.
 */
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${SUBDOMAIN} · SV Academy</title>
<meta name="description" content="A Loop student project by ${STUDENT}." />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet" />
<style>
  :root {
    --ink-950: #070C09;
    --ink-900: #0C1410;
    --ink-700: #18241E;
    --ink-500: #324439;
    --text-hi: #F1F6F2;
    --text-mid: #A9BAAE;
    --text-low: #859789;
    --green-600: #16A34A;
    --green-500: #22C55E;
    --green-400: #4ADE80;
    --line: rgba(173, 199, 183, 0.13);
    --green-soft: rgba(34, 197, 94, 0.12);
    --green-glow: rgba(34, 197, 94, 0.16);
    --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--ink-950);
    /* A whisper of green light behind the card, same trick as the main site. */
    background-image:
      radial-gradient(900px 500px at 50% -10%, var(--green-glow), transparent 70%),
      linear-gradient(var(--ink-950), var(--ink-900));
    color: var(--text-hi);
    font-family: 'Outfit', 'Noto Sans Thai', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.7;
    letter-spacing: -0.005em;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: min(680px, 100%);
    background: var(--ink-700);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: clamp(28px, 5vw, 48px);
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--mono);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--green-400);
    background: var(--green-soft);
    border: 1px solid rgba(34, 197, 94, 0.34);
    border-radius: 999px;
    padding: 5px 12px;
  }
  .dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--green-400);
    box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.7);
    animation: pulse 2.4s ease-out infinite;
  }
  @keyframes pulse {
    70%  { box-shadow: 0 0 0 9px rgba(74, 222, 128, 0); }
    100% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0); }
  }
  h1 {
    margin: 22px 0 0;
    font-size: clamp(1.6rem, 4.4vw, 2.3rem);
    font-weight: 700;
    line-height: 1.25;
    letter-spacing: -0.02em;
  }
  h1 .prompt { color: var(--green-500); font-family: var(--mono); margin-right: 10px; }
  p.lead { margin: 14px 0 0; color: var(--text-mid); font-size: 1.05rem; }
  .url {
    margin-top: 28px; padding-top: 22px;
    border-top: 1px solid var(--line);
    font-family: var(--mono);
    font-size: 0.9rem;
    color: var(--green-400);
    word-break: break-all;
  }
  .next { margin-top: 22px; }
  .next-label {
    font-family: var(--mono); font-size: 0.7rem; font-weight: 600;
    letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-low);
  }
  ol { margin: 10px 0 0; padding-left: 20px; color: var(--text-mid); }
  li { margin: 5px 0; }
  code {
    font-family: var(--mono); font-size: 0.86em;
    background: rgba(7, 12, 9, 0.6);
    border: 1px solid var(--line);
    border-radius: 5px; padding: 2px 6px;
    color: var(--text-hi);
  }
  footer {
    margin-top: 30px; padding-top: 18px;
    border-top: 1px solid var(--line);
    display: flex; flex-wrap: wrap; gap: 8px;
    justify-content: space-between;
    font-size: 0.82rem; color: var(--text-low);
  }
  footer a { color: var(--green-500); text-decoration: none; }
  footer a:hover { color: var(--green-400); text-decoration: underline; }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
</style>
</head>
<body>
  <main class="card">
    <span class="status"><span class="dot"></span> Deployed</span>
    <h1><span class="prompt">&gt;_</span>Welcome to SV Academy, you are on your way to your first project</h1>
    <p class="lead">This page is live on SV Cloud, served by your own worker. Everything you see is yours to change.</p>

    <div class="url">https://${SUBDOMAIN}.sv-academy.org</div>

    <div class="next">
      <div class="next-label">Next</div>
      <ol>
        <li>Open <code>design/README.md</code> and drop your design in.</li>
        <li>Edit <code>src/index.ts</code> to build the real thing.</li>
        <li>Run <code>npm run dev</code> and watch it change locally.</li>
        <li>Run <code>npm test</code>, then commit and push to <code>main</code>.</li>
      </ol>
    </div>

    <footer>
      <span>Built by ${STUDENT}</span>
      <span><a href="/api/health">/api/health</a> · SV Academy</span>
    </footer>
  </main>
</body>
</html>`;

app.get("/", (c) => {
  // Per-request, so debug: at info this would be one line per visitor.
  createLogger(c.env).debug("served landing page");
  return c.html(page);
});

/** Liveness probe. Kept trivial and dependency-free so it always answers. */
app.get("/api/health", (c) => c.json({ status: "ok" }));

app.get("/api/hello", (c) => {
  const name = c.req.query("name")?.trim();
  if (name && name.length > 64) {
    return c.json({ error: "name must be 64 characters or fewer" }, 400);
  }
  return c.json({ message: `Hello, ${name || "world"}!` });
});

/**
 * Serves files from `design/assets/` (see `src/assets.ts`, generated by
 * `npm run assets`). Use `asset("name")` to build the URL rather than typing
 * "/assets/..." by hand.
 */
app.get("/assets/*", async (c) => {
  const path = c.req.path.slice("/assets/".length);
  const object = await c.env.BUCKET?.get(`assets/${path}`);
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=3600",
      etag: object.httpEtag,
    },
  });
});

app.notFound((c) => {
  createLogger(c.env).debug("route not found", { path: c.req.path });
  return c.json({ error: "Not found" }, 404);
});

app.onError((err, c) => {
  // Logged once, here, where it is handled — not at every level on the way up.
  createLogger(c.env).error("unhandled error", { path: c.req.path, err });
  return c.json({ error: "Internal server error" }, 500);
});

// The default export IS the Worker. Keep it.
export default app;
