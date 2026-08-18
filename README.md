# Welcome to your Loop project, kmairin! 👋

This repo is your app — a [Hono](https://hono.dev) server running on **SV
Cloud**. It deploys automatically to:

### 🔗 https://2ccdemo.sv-academy.org

## Getting started

1. **Set up your machine first: [INSTALL.md](INSTALL.md).** It detects your
   operating system and installs the right toolchain. If you are using an AI
   assistant, ask it to follow that file — it is written for both of you.
2. **Add your design: [design/README.md](design/README.md).** Drop mockups
   or a spec in `design/reference/`, and any images/video/audio your app
   needs in `design/assets/`.
3. Run locally: `npm run dev` — your app is at http://localhost:8787
4. Edit `src/index.ts`, then **commit and push to `main`**. Loop builds and
   deploys it for you within a couple of minutes.

Once setup is done you can delete `INSTALL.md`.

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Local server with hot reload, on the real Workers runtime |
| `npm test` | Run the tests |
| `npm run test:watch` | Re-run tests as you edit |
| `npm run typecheck` | Catch type errors before CI does |
| `npm run build` | Bundle the Worker without deploying (what CI runs) |

## How deployment works

Every push to `main` triggers a GitHub Action that typechecks, runs your tests,
bundles your Worker, and ships it to Loop's hosting. **If a test fails, the
deploy stops** — that is deliberate, it keeps a broken version off your live URL.
You never run deploy commands and never need any cloud credentials. Watch the
**Actions** tab for progress, and your Loop dashboard for status.

## Your design

`design/reference/` and `design/assets/` were created for you at setup —
`design/README.md` explains the difference. Short version: put mockups and
specs in `reference/`, put the images/video/audio your app actually serves in
`assets/`, then `npm run assets` and push. Assets upload automatically and are
served from `/assets/...` via the generated `asset()` helper in `src/assets.ts`.

## Your database and file storage

Your project comes with two storage services, already connected — you don't sign
up for anything:

- **`src/db.ts`** — a **Postgres** database for records (users, posts, orders…)
- **`c.env.BUCKET`** — file storage for images, uploads and other big files
  (this is also where your `design/assets/` files end up, under `assets/`)

Both are yours alone: no other student's app can reach them. Your tables are
described in `src/schema.ts`; `npm run db:generate` turns a change there into a
migration and `npm run db:migrate` applies it.

`npm run dev` runs against **Postgres on your own machine** ([INSTALL.md](INSTALL.md)
sets it up), so you can experiment without touching live data. The same code runs
in both places — only the connection underneath changes.

[AGENTS.md](AGENTS.md) §5 has the code patterns — point your AI assistant there.

**Your project is yours.** This is a standard Worker and a standard Postgres
schema. If you ever want to host it somewhere else, export the repo, point
`DATABASE_URL` at your own database, and deploy it on any platform that runs
isolates — no rewrite, no migration process to ask us for.

## Adding secrets / API keys

Don't put API keys in the code. Add them from your **Loop dashboard** — they're
injected securely into your deployed app as environment variables, and you read
them from `c.env` in your handlers.

## Debugging the live app

Logs use levels (see `src/logger.ts`). The deployed app runs at `info`, so
`log.debug(...)` lines stay hidden. To investigate a live problem, set
`LOG_LEVEL` to `debug` in the Loop dashboard, reproduce it, then set it back.

## Rules

- Don't edit `.github/workflows/deploy.yml` (the deploy pipeline).
- Don't remove `hono` from `package.json`.
- Don't run `wrangler deploy` — Loop deploys for you.

## Working with AI assistants

[AGENTS.md](AGENTS.md) holds the house rules for Claude, Cursor, Copilot and
friends — how to check library versions, run things locally, write tests, and log
properly. If you change how the project is structured, update that file so your
assistant keeps up.

## Need help?

Reference this project to your instructor with its ID: `a01f68d9-bb00-4e40-95c6-c642b7871d4f`.
