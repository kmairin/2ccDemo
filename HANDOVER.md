# 2CC — what was built, and how to run it

An invitation-only events platform. Communities ("circles") run gatherings;
members buy passes of 1, 3 or 6 credits and spend one credit per place. Front end
and back end, on this repo's own stack — Hono + Drizzle/Postgres on SV Cloud.
It runs locally; nothing has been pushed or deployed.

## Run it

```bash
brew services start postgresql@16     # if it is not already running
npm install
npm run db:migrate
npm run seed
npm run dev                            # http://localhost:8787
```

Sign in with **`member@2cc.club`** (Alexandra Voss — holds passes, bookings and a
pending request) or **`host@2cc.club`** (Rafael Ortiz — hosts two circles). No
password: the sign-in is email + name by design.

```bash
npm test        # 112 tests
npm run e2e     # 59 checks against the running server
```

## One thing INSTALL.md does not tell you

Homebrew's Postgres has no `postgres` role — it uses your macOS username — so the
`DATABASE_URL` shipped in `wrangler.toml` cannot authenticate on a fresh Mac. Run
this once rather than editing the committed config:

```sql
CREATE ROLE postgres LOGIN SUPERUSER PASSWORD 'postgres';
ALTER DATABASE loop_dev OWNER TO postgres;
```

## The walk-through

Landing → a gathering → sign in → buy a pass → confirm → booked, in **6 clicks**
(measured, ceiling was 7). A returning member holding a credit: **2 clicks**.

- `/` · `/circles` · `/circles/:slug` · `/events` · `/calendar` · `/join`
- `/account` — credits as hairline squares, a credit ledger, tickets
- `/account/tickets/:code` — the ticket, as an issued object
- `/host` and `/host/circles/:slug` — publish gatherings, price passes, approve members

Payment is mocked: the checkout shows a disabled card block ending `4242` and a
visible `DEMO — no card is charged` note. An order is recorded; no processor.

## Where the design came from

There is no photography for this product and none could be obtained. A four-person
design council was convened; two members independently rejected generated
gradients and landed on the same answer — **engraved printing**. Every cover is
"a plate": a lit-black ground, a per-category wash, the circle's initials
debossed, and a parametric guilloché engraving derived from the slug. Six side by
side read as a deliberate series rather than six broken images.

The full arbitrated spec, including every measured correction, is in
[design/reference/design-decisions.md](design/reference/design-decisions.md).
`api-contract.md` is the route contract the tests and the gate drive literally.

## What is verified

| Gate | Result |
| --- | --- |
| `npm run typecheck` | 0 errors |
| `npm test` | 112 passed, 5 files |
| `npm run build` | 0, 650 KiB / 138 KiB gzip |
| Fresh database | `dropdb` → migrate → seed reproduces the whole world |
| `npm run e2e` | 59 passed, 0 failed, over real HTTP with cookies |
| Data consistency | 28 checks: member counts, places-left and attendees agree across card, page, API and database |
| Horizontal overflow | 0 at 375 and 1280 on every page |
| Console errors | 0 |

## Known limitations, stated plainly

- **The design bar is not fully met.** The council scored the built product
  7/8/8/7 on luxury feel, typography, consistency and mobile craft. The target was
  ≥9 on each. Every item they marked blocking has been fixed and verified, but the
  scores have **not been re-measured** since — treat 7/8/8/7 as the last honest
  reading, not the current state.
- The category wash separates cleanly for sailing and dining; wellness, sport and
  art sit 2–3 RGB levels apart and are hard to tell apart.
- The hero plate reads as topographic contours rather than banknote guilloché.
  True intaglio density needs about 3× the payload budget.
- Dates carry no year, so a roster line reading "Since Fri 6 Dec" is ambiguous.
- The mobile action bar shortens its button and drops the helper line.
- `npm run e2e` and the test suites write to the local database and clean up after
  themselves; a council audit does not, so run `npm run seed` after one.

## Deploying

Nothing here has been pushed. Pushing to `main` triggers the Loop pipeline and
deploys to `https://2ccdemo.sv-academy.org`, so that is your call, not mine. 42
files are staged and uncommitted.
