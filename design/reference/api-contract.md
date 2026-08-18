# 2CC — route contract

The end-to-end gate drives these exact URLs, form field names and JSON keys.
Implement them as written; a rename here is a gate failure, not a style choice.

Conventions:

- HTML pages are `GET`, server-rendered, and return `text/html`.
- Mutations are `POST` with `application/x-www-form-urlencoded` bodies (plain
  HTML forms, no client JS) and answer **302** with a `Location` header.
- JSON endpoints live under `/api` and return `application/json`.
- Auth is a server-side session row plus an httpOnly cookie named `2cc_session`
  (`SameSite=Lax`, `Path=/`, `Secure` only when the request is https).
- Signed out, a protected **page** 302s to `/join?next=<path>`; a protected
  **API** endpoint returns **401**. Acting on a circle you do not host is **403**.
  A missing circle/gathering/ticket is **404**. Bad or missing input is **400**.

## Pages

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | Landing: hero, how it works, featured circles, next gatherings |
| GET | `/circles` | Directory. `?category=sailing\|wellness\|dining\|sport\|art` filters |
| GET | `/circles/:slug` | Circle: story, host, upcoming gatherings, the three passes |
| GET | `/events` | All published gatherings, soonest first |
| GET | `/events/:slug` | Gathering detail, places left, book button |
| GET | `/join` | Sign-in / invitation form. Honours `?next=` |
| GET | `/account` | Auth. Passes with credits left, bookings, circles joined |
| GET | `/account/tickets/:code` | Auth. One ticket, code shown large |
| GET | `/host` | Auth. Circles you host, and the create form |
| GET | `/host/circles/:slug` | Auth + must host it. Gatherings, passes, members, attendees |

## Mutations

| Method | Path | Form fields | On success |
| --- | --- | --- | --- |
| POST | `/auth/login` | `email` (required), `name` (required for a new member), `next` (optional) | 302 → `next` or `/account` |
| POST | `/auth/logout` | — | 302 → `/` |
| POST | `/circles/:slug/join` | `next` (optional) | 302 → `next` or `/circles/:slug`. Public circle → `approved`; private → `pending` |
| POST | `/circles/:slug/passes/:packageId/buy` | `next` (optional) | 302 → `next` or `/account`. Creates an order **and** a pass **and**, on a public circle, an approved membership if absent — all in one `batch()` |
| POST | `/events/:slug/book` | — | 302 → `/account/tickets/:code`. Spends one credit |
| POST | `/account/tickets/:code/cancel` | — | 302 → `/account`. Returns the credit |
| POST | `/host/circles` | `name`, `tagline`, `description`, `city`, `country`, `category`, `isPrivate` (optional, `"on"`) | 302 → `/host/circles/:slug` |
| POST | `/host/circles/:slug/events` | `title`, `summary`, `description`, `venue`, `city`, `startsAt`, `endsAt` (both `datetime-local`, i.e. `YYYY-MM-DDTHH:MM`), `capacity`, `status` | 302 → `/host/circles/:slug` |
| POST | `/host/circles/:slug/packages` | `name`, `credits`, `priceCents` | 302 → `/host/circles/:slug` |
| POST | `/host/circles/:slug/members/:memberId/approve` | — | 302 → `/host/circles/:slug` |

### Booking rules (the part worth getting right)

- Booking requires an approved membership **and** a pass for that circle with
  `creditsUsed < creditsTotal`. Missing either → 302 back with an explanatory
  banner, not a 500.
- Booking is `insert booking` + `update pass set creditsUsed = creditsUsed + 1`
  in a single `batch()` from `src/db.ts` — never two separate awaits, and never
  `db.transaction()` (it throws on this platform).
- One confirmed booking per member per gathering, enforced by the unique index.
  A repeat booking must **not** spend a second credit.
- A gathering at capacity refuses the booking.
- Cancelling flips the booking to `cancelled` and decrements `creditsUsed`, again
  in one `batch()`.

## JSON

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/health` | `{"status":"ok"}` |
| GET | `/api/circles` | `{ circles: [{ id, slug, name, tagline, city, country, category, isPrivate, memberCount, eventCount }] }`. `?category=` filters |
| GET | `/api/circles/:slug` | `{ circle: {...}, host: { name, headline }, packages: [{ id, name, credits, priceCents, currency }], events: [...] }` |
| GET | `/api/events` | `{ events: [{ id, slug, title, summary, venue, city, startsAt, endsAt, capacity, placesLeft, circle: { slug, name } }] }`. `?circle=<slug>` filters. Published only |
| GET | `/api/events/:slug` | `{ event: {...}, circle: {...} }` |
| GET | `/api/me` | Auth. `{ user: { id, email, name }, memberships: [{ circleSlug, status }], passes: [{ id, circleSlug, creditsTotal, creditsUsed }], bookings: [{ code, eventSlug, status }], hosting: [{ slug, name }] }` |

`/api/me` is what the gate reads to check credits, so `passes[].creditsTotal`
and `passes[].creditsUsed` must be numbers, and `hosting` must list newly
created circles in creation order.

Every list endpoint takes a `LIMIT` (AGENTS.md §5). Default 50, max 100 via
`?limit=`, and reject a bad `limit` with 400.

## Amendments from the designer council (these override anything above)

**Buying a pass on a public circle also joins it.** An explicit "join" step on a
public circle is ceremony — it asks the member to agree to something nobody would
decline. `POST /circles/:slug/passes/:packageId/buy` therefore inserts the
approved `circleMembers` row in the same `batch()` when the circle is public and
the member has none. Private circles keep the explicit request, because there the
wall is real.

**`next` keeps the member where they were.** Both `join` and `buy` accept an
optional `next` form field and 302 there. Without it they behave exactly as the
table above says. This is what stops the buy step throwing someone off the
gathering they were trying to book.

**The gathering page loads the circle's packages.** So a member with no credits
can buy and book without leaving the page. Page query only — `/api/events/:slug`
is unchanged.

**Flash messages live on the session, not the query string.** Add a nullable
`flash` text column to `sessions`; write it before a 302, read-and-clear it on
render. A query string would survive a reload and re-announce a stale result.

**Form errors re-render with 400, not 302.** The POST returns the page again with
status 400, every submitted value echoed back into `value=` / textarea body /
`checked`, an alert at the top listing the problems, and `aria-invalid` +
`aria-describedby` on the offending fields. Nothing typed is ever lost.

### The gathering action area — all seven states

This is the most important component in the product. Order within it: circle
kicker (linked) → `1 credit · 4 of 12 places left` → button → one helper line.

| State | Button | Helper / fallback |
| --- | --- | --- |
| Signed out | **Sign in to reserve** → `/join?next=…` | "Email and name. No password." |
| Not a member, public circle | three pass buttons, headed "Reserve with a pass" | "Buying a pass joins the circle." |
| Not a member, private circle | **Request an invitation** | "This circle approves members by hand." |
| Pending approval | none | "Your request is with <host first name>." + links to `/events` and `/account` |
| Member, no credits | three pass buttons, headed "You're in. You need a credit." | — |
| Member, has credits | **Confirm your place** | "Uses 1 of your 3 credits." |
| Already booked | ticket stub **You're going · <code>** → the ticket | Cancelling lives on the ticket page only |
| Full | disabled **Full** | "Next from this circle: <title>, <date> →" |

The word "credit" never appears without a number beside it. The button never
just says "Book".

### Click budget (a ceiling, not a target)

New visitor, landing → booked: **5 clicks**. Returning member holding credits:
**2**. These are ceilings for *detours*, not licence to strip content — the
council was explicit that reading time is a luxury signal and that collapsing the
circle page into a modal to save a click would cheapen the product.

---

## Scope addition (owner, mid-run): the demo must be walkable end to end

> "Test the whole flow from exploring the community, scroll through photos, check
> out members and attendees and buying tickets and booking tickets and calendar
> page… You mock dependencies like payment or sth for now. This is for demo."

Five additions. All of them must be reachable by clicking, not just by URL.

### A. Photos — a gallery you can scroll

**There is no photography and none can be obtained.** The gallery is therefore a
strip of **generated plates**, each with its own guilloché parameters and a real
caption, presented as an archive rather than as fake photographs. It must look
deliberate. Captions do the work photographs would: `"The pump house, 06:30"`,
`"Ice baths, Södermalm"`.

- New table `photos`: `id`, `circleId` (nullable, FK cascade), `eventId`
  (nullable, FK cascade), `caption` (notNull), `seed` (notNull — drives the
  plate), `objectKey` (**nullable** — an R2 key), `sortOrder` (int notNull
  default 0), `createdAt`. Index on `circleId` and on `eventId`. Exactly one of
  `circleId`/`eventId` is set.
- **`objectKey` is the upgrade path.** When it is null the component renders a
  generated plate; when it is set the component renders
  `<img src="/assets/…">` from the bucket. Dropping real photographs into
  `design/assets/` later swaps them in with no code change. Say so in a comment.
- Component: a horizontal scroller — `scroll-snap-type:x mandatory`,
  `scroll-snap-align:start`, momentum scrolling, no JS carousel, no dots, no
  arrows on touch. 4–8 items per circle, 3–5 per gathering.
- Keyboard: the scroller is `tabindex="0"` with `role="group"` and an
  `aria-label`, so it can be scrolled with arrow keys.

### B. Members — who is in this circle

- On `/circles/:slug`: a members section showing approved members — initials
  plate, name, headline, city. Cap the visible list at 12 with a
  `+N more` affordance; the count must equal `memberCount` everywhere else.
- The host is shown first and labelled **Host**.
- Pending members are **never** shown publicly — only in the host console.

### C. Attendees — who is coming to this gathering

- On `/events/:slug`: an attendees section listing confirmed bookings — initials
  plate, name, headline. `9 of 12 going`, and the number must agree with
  `placesLeft` on every other page.
- Signed out, show the count and the first few names, then
  "Sign in to see who's going" — the selectivity is part of the product.
- Cancelled bookings never appear.

### D. Calendar — `GET /calendar`

A real month view, and a nav item beside Gatherings.

- Month grid at ≥900px; at ≤899px it collapses to the ledger list grouped by day.
- `?month=YYYY-MM` selects the month; absent = current month. An invalid value is
  **400**. Previous/next month links carry the same param.
- Each day cell lists its gatherings as `18:30 · Sunrise Padel`, each linking to
  the gathering. Days with nothing are empty, not blank-styled-out.
- A day with more than 3 gatherings shows the first 3 and `+N`.
- Today's cell is marked with a 1px brass rule, not a filled block.
- Published gatherings only.

### E. Mock checkout — the buying experience has to be visible

Buying instantly on one tap hides the very thing the demo needs to show. Insert
**one** confirm step, and no more.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/circles/:slug/passes/:packageId/checkout` | Auth. Order summary: circle, pass name, credits, price, price-per-gathering, and a **clearly mocked** payment block |
| POST | `/circles/:slug/passes/:packageId/buy` | Unchanged. Still takes `next` and the one-time `nonce` |

- The payment block is a **disabled** fieldset showing a card ending `•••• 4242`,
  with a visible `DEMO — no card is charged` note in `--slate`. **Never** collect
  a real card number, and never render an enabled card input.
- The confirm button reads `Confirm — €480` and carries the `nonce` and `next`.
- This makes the new-visitor path **6 clicks**, still inside the 7 ceiling.

### Updated `/api/me` and new JSON

- `/api/circles/:slug` gains `members: [{ name, headline, city, role }]` and
  `photos: [{ caption, seed, objectKey }]`.
- `/api/events/:slug` gains `attendees: [{ name, headline }]` and `photos`.
- New `GET /api/calendar?month=YYYY-MM` → `{ month, days: [{ date, events: [...] }] }`.

### What the gate must now walk

The E2E script grows to cover: open a circle → scroll its gallery → see its
members → open a gathering → see attendees → checkout → confirm → book → see the
attendee count rise by one → open the calendar and find the booked gathering on
its day.
