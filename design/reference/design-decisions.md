# 2CC — design decisions (RESOLVED)

Output of the designer council, arbitrated. **This file wins** over `spec.md`
wherever they disagree. Every number here is a decision, not a suggestion.

Where two council members disagreed, the resolution and the reason are marked
**[CALL]**.

---

## 0. The premise, honestly

Dark + gold is the single most common "AI luxury" cliché. Two council members
flagged it independently. It is not rescued by picking a different gold — it is
rescued by **ratio and by draftsmanship**:

- Brass appears on **under 2% of pixels**, and **never as a fill**.
- The thing that no template ships with is **drawn line-work**. That, not
  colour, is the differentiator. It carries the brand.

---

## 1. The plate — how this looks expensive with zero photography

**[CALL]** Both the brand director (parametric guilloché) and the skeptic
(hand-drawn engraved motifs + type as the subject) rejected gradient covers and
independently landed on *engraved printing*. Adopt the parametric engine, because
one formula with varied parameters produces a **series** where hand-drawn motifs
produce five one-offs; and adopt the skeptic's insistence that **the plate must
have a subject** by keeping the monogram. Gradient covers are banned outright.

Five layers, bottom to top:

1. **Ground** — `radial-gradient(120% 90% at var(--ox) 14%, #1B1A1D, #0E0E10 58%, #0A0A0B)`.
   A *lit* black. Not a colourful mesh.
2. **Category wash** — one flat colour at `opacity:.09; mix-blend-mode:soft-light`.
   `sailing #2E4A5A · wellness #3A4A3E · dining #5A3A32 · sport #3B3B44 · art #4A3A52`.
   On near-black these become tints you cannot name. **Category picks the wash —
   never hash the hue.** A nameable colour looks cheap; randomised hues across
   0–360° are what makes six covers in a grid read as a broken-image set.
3. **Monogram deboss** — the circle's initials in Fraunces, `font-size:44cqw`,
   `color:var(--ink-800)`, `-webkit-text-stroke:.5px rgba(174,148,99,.35)`,
   `text-shadow:0 1px 0 rgba(244,239,231,.05), 0 -1px 0 rgba(0,0,0,.6)`. This is
   the plate's *subject* — it is why it can never read as a missing image.
4. **Guilloché** — the engraving. Server-computed epitrochoid emitted as one
   `<path>`:
   `x=(p+1)cos t − h·cos((p+1)t)`, `y=(p+1)sin t − h·sin((p+1)t)`,
   `fill:none; stroke:var(--brass); stroke-width:.5; opacity:.22`, drawn 4×
   rotated 3° apart for intaglio moiré. Hairline and dense, never thick and
   sparse.
5. **Light** — `box-shadow: inset 0 1px 0 rgba(244,239,231,.06), inset 0 -90px 70px -70px #0A0A0B`.

Deterministic from `h = FNV-1a(slug)`:
`p = 3+(h%5)` · `h_amp = .28+((h>>8)%40)/200` · `rotate = (h>>12)%360` ·
`--ox = 18%+((h>>16)%24)%`.

**Payload:** ~9KB inline per plate at 900 samples. Use **320 samples / 2 passes**
in grids, **900 / 4 passes** on detail heroes. Round coordinates to 1dp and
memoise path strings by `(p, h_amp)`.

**Grain is global, not per-plate.** `feTurbulence type="fractalNoise"
baseFrequency=".85" numOctaves="3"`, baked once to a 160px tiling data-URI:
`body::after{position:fixed;inset:0;opacity:.035;mix-blend-mode:overlay;pointer-events:none}`.
One printed surface across the whole viewport. Above `.05` it reads as a broken
JPEG.

**Gatherings get a chart rule** instead of a monogram:
`repeating-linear-gradient(90deg, var(--line) 0 1px, transparent 1px 8px)`, every
5th taller. Instrumentation, not decoration.

> **Render check required.** Sub-pixel strokes can vanish or alias at 375px.
> The plate must be screenshotted at 375 and 1280 before it is trusted.

---

## 2. Tokens — final

```css
--ink-950:#0A0A0B; --ink-900:#101012; --ink-850:#141416;
--ink-800:#17171A; --ink-700:#1F1F23;
--line:rgba(244,239,231,.08); --line-lit:rgba(244,239,231,.16);
--ivory:#F4EFE7; --ivory-2:#CFC8BC; --ivory-dim:#A9A399; --ivory-faint:#6E6A64;
--brass:#AE9463; --brass-lit:#D8C39A; --brass-hair:rgba(174,148,99,.30);
--slate:#6B7683;   /* pending, full */
--rust:#8E5A46;    /* cancel only */
```

`--brass` moves from `#C8A961` (a 47%-saturation yellow — the crypto-landing-page
hue) to `#AE9463`, which still clears **6.8:1** on `--ink-950`. `--line` drops
`.10 → .08`; at `.10` borders look drawn on rather than lit.

**Brass is permitted on:** 1px rules, ≤11px uppercase labels, prices and credit
numerals, hover underlines, the focus ring, the guilloché stroke.
**Brass is banned from:** button backgrounds, badges, chips, gradients, icons,
body text, headlines, any filled area over 2px tall.
**The one primary CTA per screen is `--ivory` fill with `--ink-950` text.**

**Edges, not shadows.** Cards: `background:var(--ink-900); border:1px solid
var(--line); border-radius:2px`. Elevation is a light-catching top edge
(`inset 0 1px 0 rgba(244,239,231,.05)`). Exactly **one** drop shadow exists in the
product: `0 24px 48px -24px rgba(0,0,0,.8)` on the sticky header.

---

## 3. Type

```
Fraunces  — display. LOCK THE AXES: font-variation-settings:'SOFT' 0,'WONK' 0,'opsz' 144
            (default Fraunces is artisanal-bakery; at SOFT 0/WONK 0 it is a severe Didone)
Inter     — UI.      font-feature-settings:'tnum' 1,'ss01' 1
IBM Plex Mono 400/500 — NUMERALS ONLY: ticket codes, prices, credits, dates.
            Numbers in a machine face is the cheapest "issued document" signal there is.
```

Fallbacks: `Fraunces,'Times New Roman',serif` · `Inter,system-ui,sans-serif` ·
`'IBM Plex Mono',ui-monospace,monospace`.

```css
--t-micro:.6875rem;                              /* lh 1    ls .18em  Inter 500 uppercase */
--t-meta: clamp(.75rem,.72rem+.15vw,.8125rem);   /* 1.4     .02em     Inter 400 */
--t-body: clamp(.9375rem,.9rem+.25vw,1.0625rem); /* 1.65    0         Inter 400 */
--t-lede: clamp(1.0625rem,1rem+.5vw,1.375rem);   /* 1.5    -.005em    Inter 400 */
--t-card: clamp(1.125rem,1.05rem+.4vw,1.375rem); /* 1.25   -.01em     Fraunces 400 */
--t-sec:  clamp(1.5rem,1.25rem+1.1vw,2.25rem);   /* 1.15   -.015em    Fraunces 400 */
--t-h1:   clamp(2rem,1.4rem+2.6vw,3.75rem);      /* 1.02   -.02em     Fraunces 300 */
--t-hero: clamp(2.75rem,1.6rem+5.2vw,6.5rem);    /* .94    -.025em    Fraunces 300 */
--t-code: clamp(1.75rem,1.2rem+2.4vw,3.25rem);   /* 1       .12em     Plex Mono 500 */
```

**Two gestures carry the brand, and they appear on all ten screens:**

1. **Rule-and-index** — every section opens with a 24px brass hairline, then a
   mono numeral and a micro-caps label: `— 03 / GATHERINGS`.
2. **Optical inset** — heroes get `text-indent:-.055em` so the first glyph sits
   *on* the container edge rather than near it.

Micro-caps (`uppercase; letter-spacing:.18em; .6875rem`) is allowed on **exactly
two roles**: category labels and price labels. Everywhere else, differentiate with
size and colour. Over-using it is a template tell.

---

## 4. Space and composition

Scale: `4 8 12 16 24 32 48 64 96 144 200`.
Container `1180px`, `padding-inline:clamp(20px,5vw,64px)`, prose `max-width:62ch`.
Sections `padding-block:clamp(64px,12vw,144px)`; hero `clamp(96px,18vw,220px)`;
label→content `32px`.

**Grids share hairlines:** `display:grid; gap:1px; background:var(--line)` with
opaque cards. They read as a printed index, not floating tiles.

- **375** — 1 column; plates full-bleed past the gutters; `aspect-ratio:4/3`; text inset 20px.
- **768** — 2 columns; `3/2`.
- **1280** — circles 3 columns, gatherings 2. Heroes and section headers cap at
  **8 of 12 columns**, so the right third stays deliberately empty. Target ~55%
  unfilled ink at rest; one idea per screenful.

---

## 5. Per-screen

| Screen | The one move |
| --- | --- |
| **Landing** | One sentence at `--t-hero` in the left 8 columns, nothing else above the fold. Then a subline defining all four nouns in one breath. Featured circles start a full viewport down. Add 80–120 words of real editorial on what a gathering *is* — hero + three cards is a template. |
| **Circles** | Filters as a micro-caps hairline row, active marked by a 1px brass underline. **Never pills.** |
| **Circle** | Full-bleed plate with the name overlapping its lower edge at `margin-top:-.4em`. The three passes are **one bordered table with hairline dividers**, not three pricing cards. |
| **Gatherings** | A **ledger, not a grid**: 88px mono date column, hairline rows, 64px square plate thumb. Month group headers. Needs 18–24 rows to look real. |
| **Gathering** | When/where as a micro-caps definition list. "4 places left" is the only large brass number in the product. |
| **Join** | **No card.** A 420px column on bare ink, invitation line in Fraunces italic, inputs `border:0;border-bottom:1px solid var(--line)`. Add an invitation-code field, four lines of membership terms, and what happens next — three inputs on black looks unbuilt. |
| **Account** | Credits drawn as **N hairline squares, filled = spent** — not a progress bar. This detail sells the product. Add a credit ledger (bought/spent/left with dates), past bookings, and each circle's next date. |
| **Ticket** | Code in Plex Mono at `--t-code` on a plate; double-rule frame (1px `--brass-hair` plus a 1px inset at 4px); perforation dots down one edge via `repeating-linear-gradient`. Add venue address, what to bring, which pass it drew from, cancellation deadline, and a drawn SVG seal so it reads as an object. |
| **Host** | Deliberately **plainer**: no plates, rules only. Back-of-house as ledger makes front-of-house feel precious. |
| **Manage** | Everything tabular with `tnum`. Status is uppercase micro text in `--ivory-dim`/`--brass`, never a coloured chip. Show attendee names, per-gathering fill (`9 of 12`), pending members with request dates, revenue to date. |

---

## 6. Copy rules — enforced in the seed and in every string

**Banned words, no exceptions:** curated, bespoke, elevate, exclusive, immersive,
seamless, unlock, discover, indulge, handpicked, like-minded, discerning,
timeless, effortless, sanctuary, world-class, journey, "experience" as a noun,
"where X meets Y", "not just X — Y".

- 2–4 sentences, 12–20 words each. No fragments-as-rhetoric.
- **A circle description must contain four things:** a named real person and what
  they do, a cadence, a physical specific, and **one constraint**. Constraints are
  the strongest realness signal — generators never invent friction.
- **Prices:** `€180`, never `€180.00`, never "from". Show the derivation:
  `€180 · 3 gatherings · €60 each`. **Season must not be exactly 6× Single.**
  Currency follows the circle's country.
- **Times are real minutes** (`06:40`), durations vary. Not everything on the hour.
- **Empty states:** fact + next action. No apology, no illustration, no
  exclamation mark.

> ✗ "The Cold Room — an exclusive sanctuary where discerning individuals elevate
> their wellness journey through curated cold exposure."
> ✓ "Tomas Ek keeps three ice baths and a sauna in a pump house in Södermalm.
> Four rounds, 3°C, no phones. Twelve places, Tuesdays and Saturdays, 06:30."

> ✗ "No gatherings yet — exciting things on the horizon. Check back soon!"
> ✓ "No gatherings scheduled. Åsa posts the summer calendar in March."

---

## 7. Banned outright

Glassmorphism, `backdrop-filter`, translucent cards, glow, shimmer sweeps.
Brass fills of any kind. Emoji. Icon fonts. Coloured initial-avatars.
`border-radius > 4px`. Card drop-shadows. Card hover-lift. Gradient borders.
Scroll-reveal fades. Skeleton loaders (this is server-rendered HTML — there is no
loading state). Booking steppers. Testimonials. Newsletter footers. Stat
counters. Star ratings. Logo walls. Brass ornaments and centred diamonds. Line
icons for categories — **a category is a word**. The phrase "Get Started".

Maximum **six** hand-drawn 1px-stroke SVG icons in the entire product, 16px,
`currentColor`.

---

## 8. Credibility checklist — verify each before sign-off

- `memberCount` on the card == members on the circle page == approved count in host console.
- `placesLeft` == capacity − confirmed bookings, and it visibly drops after booking **on every page that shows it**.
- `eventCount` == upcoming gatherings listed.
- Booking: credits drop on `/account`; the ticket names the pass it drew from. Cancelling puts the credit back. Verify on both pages.
- Repeat booking spends no second credit. The at-capacity refusal and the no-credit banner are both reachable and styled.
- Dates spread: one tomorrow, one this weekend, one three months out. Times off the hour. Durations vary.
- Circles have 2–6 gatherings, not all three. **One is full. One is private with a pending request. One has exactly 1 place left. One has no upcoming gatherings** (so the empty state is real, not theoretical).
- Member counts are odd numbers (47, 112) — never 100/250/500.
- One host per circle; name and nationality matching the city; each with a distinct one-line credential.
- 404 for a bad slug and 403 for someone else's circle are both **styled pages**, not stack traces.

---

## 9. What this changes in already-written code

- `src/ui/theme.ts` — repalette, new type scale, lock Fraunces axes, add Plex Mono, global grain, `gap:1px` grids, rule-and-index.
- `src/ui/cover.ts` — **delete the gradient approach**; implement the plate.
- `src/schema.ts` — add nullable `flash` text column to `sessions`.
- `scripts/seed.mjs` — rewrite all copy to §6, and stage the world to §8.

---

## 10. Arbitration — where the council disagreed, and the measured corrections

### 10.1 The action bar: opaque, not glass **[CALL]**

Interaction craft specified `backdrop-filter: blur(12px) saturate(140%)`. The
brand director bans `backdrop-filter` outright and the skeptic called a
persistent bottom bar "a food-delivery pattern". **Resolution: keep the bar, kill
the glass.**

- Opaque `background: var(--ink-900)`, `border-block-start: 1px solid var(--line-strong)`,
  and the product's one permitted shadow `0 -12px 32px rgba(0,0,0,.45)`.
- It exists on **`/circles/:slug` and `/events/:slug` only** — never global.
- Everything else from interaction craft's spec stands: `position:fixed`,
  `min-height:52px`, `env(safe-area-inset-*)` padding, the server-set
  `class="has-actionbar"` on `<body>` driving `main { padding-block-end: … }`
  (no `:has()` dependency), placement **after `</main>`** in the DOM so tab order
  matches visual order, and `display:none` at ≥900px where the same actions live
  in a `position:sticky` sidebar card instead. Never both at once.

### 10.2 Contrast — three council tokens FAIL and are corrected

Interaction craft computed its ratios against the **old** brass (`#C8A961`) and
the old `--line`. I recomputed every token against the final palette. Measured
sRGB ratios, `--ink-950 #0A0A0B` and `--ink-800 #17171A`:

| Token | Proposed | Measured on ink-950 | Verdict |
| --- | --- | --- | --- |
| `--ivory` | `#F4EFE7` | 17.29:1 | pass |
| `--ivory-2` | `#CFC8BC` | 11.91:1 | pass |
| `--ivory-dim` | `#A9A399` | 7.90:1 | pass |
| `--brass` | `#AE9463` | **6.80:1** | pass — the desaturation is safe |
| `--brass-lit` | `#D8C39A` | 11.49:1 | pass |
| `--warn` | `#D98A6A` | 7.34:1 | pass |
| `--ivory-faint` | `#6E6A64` | **3.68:1** | **FAILS AA body** |
| `--slate` | `#6B7683` | **4.28:1** | **FAILS AA body** |
| `--rust` | `#8E5A46` | **3.49:1** | **FAILS AA body** |

**Corrected tokens — use these:**

```css
--ivory-faint:#8A857D;   /* was #6E6A64 — now 5.40:1 / 4.88:1 */
--slate:#8A94A0;         /* was #6B7683 — now 6.43:1 / 5.81:1 */
--rust:#B0745B;          /* was #8E5A46 — now 5.18:1 / 4.68:1 */
--warn:#D98A6A;          /* 7.34:1 */
--line-strong:rgba(244,239,231,.40);   /* 3.46:1 — see below */
```

**Borders:** `--line` at `.08` measures **1.16:1**, and even `.30` only reaches
2.42:1 — all fail SC 1.4.11's 3:1 for control boundaries. Only `.40` clears it
(**3.46:1**). So: `--line` (.08) stays for **decorative** hairlines and card
edges; **`--line-strong` (.40) is mandatory** on input/select/textarea borders,
the action-bar top edge, and any boundary that is the only thing defining a
control.

### 10.3 Motion — the three permitted transitions

```css
/* 1. state tint — never transform, never shadow */
transition: border-color 160ms ease-out, color 160ms ease-out,
            background-color 160ms ease-out, filter 120ms ease-out;
/* 2. disclosure panel: opacity 140ms ease-out + @starting-style{opacity:0} */
/* 3. confirmation banner: 240ms cubic-bezier(.2,0,0,1), opacity 0→1, translateY(-4px)→0, once */
```

Focus rings are never transitioned. Plates are static — no animated grain.
Full `prefers-reduced-motion` reset with `!important` on animation/transition
duration and `scroll-behavior`.

### 10.4 Adopted verbatim from interaction craft

- **Zero-overflow rules:** `.grid>*,.row>*{min-width:0}` (the single biggest cause),
  `grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr))`,
  `body{overflow-wrap:anywhere}`, `img,svg,table,pre,iframe{max-width:100%}`.
  `html{overflow-x:clip}` is a **backstop only** — the gate asserts both
  `documentElement.scrollWidth <= innerWidth` **and** that no element's
  `getBoundingClientRect().right > 375`, because `clip` fakes the first test.
- `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">`
  — without `viewport-fit=cover` every `env(safe-area-inset-*)` silently returns 0.
- `input,select,textarea{font-size:max(16px,1rem)}` — under 16px, iOS zooms on
  focus and pans sideways, breaking the overflow gate in a way desktop never catches.
- `[id]{scroll-margin-block-start:calc(var(--header-h) + 16px)}` — anchors and the
  skip link otherwise land under the sticky header.
- Nav is a `<details>` disclosure with **separate mobile and desktop siblings**
  (forcing `details` content visible at desktop is unreliable across engines).
  `<summary>` gets **no** `aria-expanded` and **no** `role="button"` — the UA maps
  both already and adding them breaks state reporting in some assistive tech.
  Esc-to-close is 4 lines of progressive enhancement.
- Touch: 48px primary / 44px nav minimum; expand hit area with
  `min-height:48px;margin-inline:-12px;padding-inline:12px`;
  `-webkit-tap-highlight-color:transparent` and `.btn:active{filter:brightness(.90)}`
  **ship together or neither ships**.
- Whole-card links via `.card-title a::after{content:"";position:absolute;inset:0}`
  with `.card .secondary{position:relative;z-index:2}` — never `<a>` inside `<a>`.
- Focus ring: `outline:2px solid var(--brass); outline-offset:2px;
  box-shadow:0 0 0 2px var(--ink-950)` — the inner ink ring keeps it legible even
  on an ivory-filled button.
- Skip link to `<main id="main" tabindex="-1">`. One `<h1>` per page = the subject.
  Card titles are `<h3>` under a section `<h2>`. The wordmark is a link, not a heading.
- **Pass purchase needs a one-time nonce.** Booking is already idempotent via the
  unique index, but a double-tap on "Buy Trio" creates two orders. Hidden
  `name="nonce"`, burned server-side on first POST; a replay 302s with
  "already processed". Do not rely on `disabled`-on-submit.
- `Cache-Control: private, no-cache` on GET pages — **never `no-store`**, which
  disables bfcache and makes Back a cold load at every step of the funnel.
- Confirmation banner: first child of `<main>`, above the `<h1>`, `role="status"`,
  **no auto-dismiss** (WCAG 2.2.1), no dismiss control; cleared by the next
  navigation. The real screen-reader announcement is the `<title>`:
  `Booked — Sunrise Padel · 2CC`.
- Join form inputs: `type="email" inputmode="email" autocomplete="email"
  autocapitalize="off" spellcheck="false" enterkeyhint="go"`, and
  `autocomplete="name"`.

### 10.5 The category wash — measured, corrected

§1 layer 2 specified `opacity:.09; mix-blend-mode:soft-light`. Rendered and
measured, that is **invisible**: compositing the W3C soft-light formula over the
ground `#0E0E10` gives a maximum of **1 RGB level** of separation between the
five category washes. Not "a tint you cannot name" — a tint that is not there.

The blend mode is the cause, not the alpha. Soft-light preserves a dark backdrop
almost exactly, so it cannot tint near-black; raising opacity does not rescue it
(at `.28` the spread is still 2 levels). `overlay` is equally dead on this ground.

| mode | alpha | lift from ground | spread between categories |
| --- | --- | --- | --- |
| soft-light | .09 | 1 | 1 |
| soft-light | .28 | 3 | 2 |
| overlay | .18 | 0 | 1 |
| **screen** | **.14** | **12** | **6** |
| screen | .22 | 19 | 9 (becoming nameable) |

**Decision: layer 2 is `mix-blend-mode: screen; opacity: .14`.** The five wash hex
values are unchanged. This lands in the band the council actually wanted —
perceptible as difference, not identifiable as a colour.

Also corrected: `initials()` returned a single letter for a one-word circle name
("Nightform" → "N"), which reads thinner than the two-letter monograms beside it
in a grid. One-word names take their first two letters ("NI").

**The general lesson, worth more than the fix:** a blend mode plus an opacity is
not a design decision until someone composites it and counts the levels. Both
"tints you cannot name" and "tints that do not exist" look identical in a spec.

### 10.6 The overflow gate as written is wrong — corrected

§10.4's second assertion ("no element with `getBoundingClientRect().right >
viewport width") fails on four pages while the first assertion legitimately
passes. Every one of the 137 flagged elements is a descendant of a container
that is **specified** to scroll horizontally: `div.gallery`
(`overflow-x:auto`, scrollWidth 1760 / clientWidth 335) and `div.bordered.scroll-x`
around the wide host-console tables. Zero offenders sit outside a scroller on any
page.

**The gate must grant `overflow-x:auto` containers the same exemption it already
grants `<svg>`.** The correct assertion is:

> `documentElement.scrollWidth <= innerWidth`, **and** no element whose
> `right > viewport` lies outside a clipping or scrolling ancestor
> (`overflow-x` of `auto`, `scroll`, `hidden` or `clip`).

Measured with that exemption: **0 offenders on all nine pages at 375**, with
`scrollWidth === innerWidth === 375` exactly — so `overflow-x: clip` is not doing
the work.

### 10.7 Fixes applied after the round-2 audit

| # | Finding | Fix | Verified |
| --- | --- | --- | --- |
| A | **Blocking.** The footer rendered *under* the fixed mobile action bar on `/circles/:slug` and `/events/:slug`; two links unreachable. Clearance padding sat on `.site-main`, but the footer is a **sibling** of `<main>`, so it received none. | Move clearance to `body.has-actionbar`, zero it on `.site-main`, and drop it entirely at ≥900px. | Bar 65px, body padding-block-end **76px** → footer went from **32.8px occluded** to **11px clear**. |
| B | Inline actions measured 15–25px tall (calendar day links, account ledger rows). | `min-height:44px` with negative block margin so the hit area grows without moving the layout; 48px under `pointer:coarse`. | typecheck 0 |
| C | `.btn--quiet` at 44px against a 48px floor. | `min-height:48px`. | typecheck 0 |
| D | `favicon.ico` 404 — the only console error in the product. | Inline SVG data-URI monogram in `<head>`. | `rel="icon"` present; request no longer 404s. |
| E | Horizontal scrollers had `tabIndex −1`, hiding up to 275px from keyboard users. | `tabindex={0}` on all 11 `.scroll-x` containers, plus a `:focus-visible` ring. | typecheck 0; rendered focusable. |
| — | Monograms collided on leading articles ("The Cold Room"/"The Bica Table"/"The Sunrise Court" → T-something). | `initials()` drops a leading article. | 6 circles → 6 distinct monograms: BT, CS, SC, CR, EP, NI. |

**Approved deviation from §1:** the guilloché is drawn as a multi-turn spiral
rather than a single revolution. The literal §1 parameters produce a *curtate*
epitrochoid — a circle with a 6% ripple — which rendered as one faint stray
outline, the exact sparse failure §1 bans. Formula, the four hashed parameters,
stroke, opacity, pass count and 3° step are unchanged; only how far `t` runs.
On budget at 6.1–9.8KB per grid plate.
