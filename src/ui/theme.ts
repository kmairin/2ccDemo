/**
 * The 2CC design system: tokens plus the whole stylesheet, as one string.
 *
 * Built to `design/reference/design-decisions.md`. That file is the spec and it
 * wins over everything; §10 carries measured corrections that override §2, and
 * the corrected values are the ones below.
 *
 * Inlined into every page by `src/ui/layout.tsx` — there is no build step and
 * no CSS file to keep in sync, so the document arrives styled in one round
 * trip. Dark only, by design: there is no light theme and no
 * `prefers-color-scheme` branch to add one.
 *
 * Mobile-first. Everything is written for 375px and widens from there; anything
 * that could be wider than its column wraps or scrolls inside its own box
 * rather than pushing the page sideways (§10.4).
 */

/** The palette, for anywhere CSS custom properties cannot reach. §10.2 values. */
export const tokens = {
  ink950: "#0A0A0B",
  ink900: "#101012",
  ink850: "#141416",
  ink800: "#17171A",
  ink700: "#1F1F23",
  line: "rgba(244,239,231,.08)",
  lineLit: "rgba(244,239,231,.16)",
  /** Mandatory on any boundary that is the only thing defining a control (§10.2). */
  lineStrong: "rgba(244,239,231,.40)",
  ivory: "#F4EFE7",
  ivory2: "#CFC8BC",
  ivoryDim: "#A9A399",
  ivoryFaint: "#8A857D",
  brass: "#AE9463",
  brassLit: "#D8C39A",
  brassHair: "rgba(174,148,99,.30)",
  slate: "#8A94A0",
  rust: "#B0745B",
  warn: "#D98A6A",
} as const;

/**
 * Fraunces with its axes exposed so §3 can lock them: default Fraunces is
 * artisanal-bakery, and at `SOFT 0 / WONK 0` it is a severe Didone. Inter for
 * UI, IBM Plex Mono for numerals only. Verified to return CSS from Google Fonts.
 */
export const fontsHref =
  "https://fonts.googleapis.com/css2" +
  "?family=Fraunces:opsz,wght,SOFT,WONK@9..144,300..700,0..100,0..1" +
  "&family=IBM+Plex+Mono:wght@400;500" +
  "&family=Inter:wght@400..700" +
  "&display=swap";

/**
 * The grain, baked once to a 160px tiling data-URI (§1).
 *
 * Global, on `body::after` — never per plate. One printed surface across the
 * whole viewport. Above `.05` opacity it reads as a broken JPEG.
 */
function grainUri(): string {
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'>" +
    "<filter id='g'>" +
    "<feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/>" +
    "<feColorMatrix type='saturate' values='0'/>" +
    "</filter>" +
    "<rect width='160' height='160' filter='url(#g)'/>" +
    "</svg>";
  const encoded = encodeURIComponent(svg).replace(
    /[()']/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `url("data:image/svg+xml,${encoded}")`;
}

/**
 * Esc closes the mobile nav. Four lines of progressive enhancement (§10.4) —
 * the disclosure itself is a `<details>` and works with scripting off.
 */
export const escScript =
  "addEventListener('keydown',function(e){if(e.key!=='Escape')return;" +
  "var d=document.querySelector('details.nav-mobile[open]');" +
  "if(!d)return;d.open=false;var s=d.querySelector('summary');if(s)s.focus();});";

export const css = `
:root {
  --ink-950:${tokens.ink950}; --ink-900:${tokens.ink900}; --ink-850:${tokens.ink850};
  --ink-800:${tokens.ink800}; --ink-700:${tokens.ink700};
  --line:${tokens.line}; --line-lit:${tokens.lineLit}; --line-strong:${tokens.lineStrong};
  --ivory:${tokens.ivory}; --ivory-2:${tokens.ivory2};
  --ivory-dim:${tokens.ivoryDim}; --ivory-faint:${tokens.ivoryFaint};
  --brass:${tokens.brass}; --brass-lit:${tokens.brassLit}; --brass-hair:${tokens.brassHair};
  --slate:${tokens.slate}; --rust:${tokens.rust}; --warn:${tokens.warn};

  --display:'Fraunces','Times New Roman',serif;
  --ui:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans Thai',sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;

  --t-micro:.6875rem;
  --t-meta:clamp(.75rem,.72rem + .15vw,.8125rem);
  --t-body:clamp(.9375rem,.9rem + .25vw,1.0625rem);
  --t-lede:clamp(1.0625rem,1rem + .5vw,1.375rem);
  --t-card:clamp(1.125rem,1.05rem + .4vw,1.375rem);
  --t-sec:clamp(1.5rem,1.25rem + 1.1vw,2.25rem);
  --t-h1:clamp(2rem,1.4rem + 2.6vw,3.75rem);
  --t-hero:clamp(2.75rem,1.6rem + 5.2vw,6.5rem);
  --t-code:clamp(1.75rem,1.2rem + 2.4vw,3.25rem);

  /* 4 8 12 16 24 32 48 64 96 144 200 */
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:32px;
  --s7:48px; --s8:64px; --s9:96px; --s10:144px; --s11:200px;

  --pad:clamp(20px,5vw,64px);
  --shell:1180px;
  --measure:62ch;
  --band:clamp(64px,12vw,144px);
  --band-hero:clamp(96px,18vw,220px);
  --header-h:60px;
  --grain:${grainUri()};
}

*,*::before,*::after { box-sizing:border-box; }

html { -webkit-text-size-adjust:100%; scroll-behavior:smooth; overflow-x:clip; }

body {
  margin:0;
  min-height:100vh;
  display:flex;
  flex-direction:column;
  background:var(--ink-950);
  color:var(--ivory);
  font-family:var(--ui);
  font-size:var(--t-body);
  font-weight:400;
  line-height:1.65;
  font-feature-settings:'tnum' 1,'ss01' 1;
  /* §10.4: the cheapest insurance against a 375px overflow. */
  overflow-wrap:anywhere;
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
  -webkit-tap-highlight-color:transparent;
}

/* One printed surface across the whole viewport (§1). Never per plate. */
body::after {
  content:"";
  position:fixed;
  inset:0;
  z-index:9999;
  background-image:var(--grain);
  background-size:160px 160px;
  opacity:.035;
  mix-blend-mode:overlay;
  pointer-events:none;
}

img,svg,table,pre,iframe { max-width:100%; }
img,svg,video { display:block; height:auto; }

h1,h2,h3,h4 {
  margin:0;
  font-family:var(--display);
  font-variation-settings:'SOFT' 0,'WONK' 0,'opsz' 144;
  font-weight:400;
  font-optical-sizing:none;
}

p,figure,fieldset { margin:0; }
fieldset { border:0; padding:0; min-width:0; }
legend { padding:0; }
ul,ol,dl,dd { margin:0; padding:0; }
li { list-style:none; }

a { color:inherit; text-decoration:none; }
hr { border:0; border-top:1px solid var(--line); margin:0; }

/* §10.4: anchors and the skip link otherwise land under the sticky header. */
[id] { scroll-margin-block-start:calc(var(--header-h) + 16px); }

/* Focus rings are never transitioned. The inner ink ring keeps the brass
   legible even on an ivory-filled button (§10.4). */
:focus-visible {
  outline:2px solid var(--brass);
  outline-offset:2px;
  box-shadow:0 0 0 2px var(--ink-950);
}

::selection { background:rgba(174,148,99,.28); color:var(--ivory); }

.vh {
  position:absolute; width:1px; height:1px; margin:-1px; padding:0;
  overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0;
}

.skip-link {
  position:absolute; left:-9999px; top:0; z-index:60;
  background:var(--ink-900); border:1px solid var(--line-strong);
  color:var(--ivory); padding:12px 16px; border-radius:2px;
}
.skip-link:focus { left:var(--pad); top:10px; }

/* ---------- measure and rhythm ---------- */

.shell { width:100%; max-width:var(--shell); margin-inline:auto; padding-inline:var(--pad); }
.prose { max-width:var(--measure); color:var(--ivory-2); }
.prose > * + * { margin-top:var(--s4); }
/* Heroes and section headers cap at 8 of 12 columns — the right third stays
   deliberately empty (§4). */
.eight { max-width:min(100%,calc(var(--shell) / 12 * 8)); }

.row { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s3) var(--s5); }
.row > * { min-width:0; }
.stack { display:grid; gap:var(--s3); }
.stack > * { min-width:0; }
.stack--wide { gap:var(--s5); }

/* Anything that genuinely cannot wrap scrolls inside its own box (§10.4). */
.scroll-x { overflow-x:auto; max-width:100%; -webkit-overflow-scrolling:touch; }
/* A scroller has to be focusable or a keyboard user cannot reach the content it
   hides — measured at 275px hidden on the host console. */
.scroll-x:focus-visible { outline:2px solid var(--brass); outline-offset:2px; }

/* Inline actions were measured at 15–25px tall. Grow the hit area without moving
   a pixel of the layout (§10.4). */
.cal-entry a, .ledger-row a, .ledger-cell a, .acct-row a, .table a, .stack-rows a {
  display:inline-flex; align-items:center; min-height:44px;
  margin-block:-10px; margin-inline:-8px; padding-inline:8px;
}
@media (pointer:coarse) {
  .cal-entry a, .ledger-row a, .acct-row a, .table a { min-height:48px; }
}

/* ---------- the two brand gestures (§3) ---------- */

/* 1. Rule-and-index: 24px brass hairline, mono numeral, micro-caps label. */
.index {
  display:flex; align-items:center; gap:var(--s3);
  margin:0 0 var(--s6);
  font-size:var(--t-micro); line-height:1;
}
.index-rule { flex:none; width:24px; height:1px; background:var(--brass); }
.index-num { font-family:var(--mono); font-weight:500; color:var(--brass); letter-spacing:.08em; }
.index-sep { color:var(--ivory-faint); }
.index-label { text-transform:uppercase; letter-spacing:.18em; color:var(--ivory-dim); font-weight:500; }

/* 2. Optical inset: the first glyph sits on the container edge, not near it. */
.h-hero,.h-page { text-indent:-.055em; }

/* ---------- type roles ---------- */

.micro {
  display:inline-block;
  font-size:var(--t-micro); line-height:1; font-weight:500;
  text-transform:uppercase; letter-spacing:.18em;
  color:var(--ivory-dim);
}
.micro--brass { color:var(--brass); }

.meta { font-size:var(--t-meta); line-height:1.4; letter-spacing:.02em; color:var(--ivory-dim); }
.meta--bright { color:var(--ivory-2); }
.num { font-family:var(--mono); font-weight:400; font-feature-settings:'tnum' 1; }
.dot { color:var(--ivory-faint); padding-inline:.4em; }

.h-hero { font-size:var(--t-hero); line-height:.94; letter-spacing:-.025em; font-weight:300; }
.h-page { font-size:var(--t-h1); line-height:1.02; letter-spacing:-.02em; font-weight:300; }
.h-sec  { font-size:var(--t-sec); line-height:1.15; letter-spacing:-.015em; }
.h-card { font-size:var(--t-card); line-height:1.25; letter-spacing:-.01em; }
.lede   { font-size:var(--t-lede); line-height:1.5; letter-spacing:-.005em; color:var(--ivory-2); }

/* ---------- header ---------- */

.site-header {
  position:sticky; top:0; z-index:50;
  background:var(--ink-950);
  border-block-end:1px solid var(--line);
  box-shadow:0 24px 48px -24px rgba(0,0,0,.8);
}
.header-inner { display:flex; align-items:center; gap:var(--s4); min-height:var(--header-h); }

.wordmark {
  font-family:var(--display);
  font-variation-settings:'SOFT' 0,'WONK' 0,'opsz' 144;
  font-size:1.0625rem; letter-spacing:.26em; color:var(--ivory);
  white-space:nowrap; margin-inline-end:auto;
  display:inline-flex; align-items:center; min-height:44px;
}
.wordmark--quiet { color:var(--ivory-faint); font-size:.9375rem; margin-inline-end:0; }

.nav-desktop { display:none; align-items:center; gap:var(--s5); margin-inline-start:auto; }
.nav-link {
  display:inline-flex; align-items:center;
  min-height:44px; margin-inline:-12px; padding-inline:12px;
  font-size:var(--t-meta); letter-spacing:.02em; color:var(--ivory-dim);
  border-block-end:1px solid transparent;
  transition:border-color 160ms ease-out,color 160ms ease-out,background-color 160ms ease-out,filter 120ms ease-out;
}
.nav-link:hover { color:var(--ivory); border-block-end-color:var(--brass); }
.nav-link[aria-current='page'] { color:var(--ivory); border-block-end-color:var(--brass); }

.nav-mobile { position:relative; margin-inline-start:auto; }
.nav-mobile > summary {
  list-style:none; cursor:pointer;
  display:inline-flex; align-items:center; justify-content:center;
  min-height:44px; min-width:44px; padding-inline:12px;
  font-size:var(--t-meta); color:var(--ivory-2);
  border:1px solid var(--line-strong); border-radius:2px;
  transition:border-color 160ms ease-out,color 160ms ease-out,background-color 160ms ease-out,filter 120ms ease-out;
}
.nav-mobile > summary::-webkit-details-marker { display:none; }
.nav-mobile[open] > summary { color:var(--ivory); border-color:var(--ivory-dim); }
.nav-panel {
  position:absolute; inset-inline:auto 0; top:calc(100% + 9px); z-index:50;
  min-width:12rem;
  background:var(--ink-900);
  border:1px solid var(--line-strong);
  border-radius:2px;
  padding:var(--s2) var(--s4);
  opacity:1;
  transition:opacity 140ms ease-out;
}
@starting-style { .nav-panel { opacity:0; } }
.nav-panel a {
  display:flex; align-items:center; min-height:44px;
  border-block-end:1px solid var(--line);
  font-size:var(--t-meta); color:var(--ivory-dim);
}
.nav-panel a:last-child { border-block-end:0; }
.nav-panel a[aria-current='page'] { color:var(--ivory); }

@media (min-width:900px) {
  :root { --header-h:68px; }
  .nav-desktop { display:flex; }
  .nav-mobile { display:none; }
}

/* ---------- main, footer ---------- */

.site-main { flex:1 1 auto; width:100%; }
.site-main:focus { outline:none; }

/* The action bar is fixed, and the footer is a SIBLING of <main> — so clearance
   has to sit on <body>, not on .site-main, or the footer renders underneath it
   and its links cannot be tapped. Measured: 65px bar, footer 32.8px beneath. */
body.has-actionbar { padding-block-end:calc(52px + 24px + env(safe-area-inset-bottom,0px)); }
body.has-actionbar .site-main { padding-block-end:0; }
@media (min-width:900px) { body.has-actionbar { padding-block-end:0; } }

.site-footer { border-block-start:1px solid var(--line); margin-block-start:var(--band); }
.footer-inner { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s3) var(--s5); padding-block:var(--s6); }
.footer-spacer { margin-inline-end:auto; }
.footer-link { font-size:var(--t-meta); color:var(--ivory-faint); display:inline-flex; align-items:center; min-height:44px; }
.footer-link:hover { color:var(--brass-lit); }

/* ---------- hero and section ---------- */

.hero { padding-block:var(--band-hero) var(--band); }
.hero .lede { margin-block-start:var(--s5); max-width:52ch; }
.hero-actions { margin-block-start:var(--s6); display:flex; flex-wrap:wrap; gap:var(--s3); }

.section { padding-block:var(--band); border-block-start:1px solid var(--line); }

/* An index page exists to show its index. With a full hero band plus a full
   section band, the first card sat at y=954 on /circles — zero content above
   the fold on a 1280x900 laptop. Index pages get a tighter rhythm; the landing
   page keeps the full one, because there the statement IS the content. */
.page-index .hero { padding-block:clamp(48px,9vw,110px) clamp(24px,4vw,48px); }
.page-index .section:first-of-type { padding-block-start:clamp(32px,5vw,56px); }
.section:first-child { border-block-start:0; }
.section-head { display:flex; flex-wrap:wrap; align-items:flex-end; gap:var(--s3) var(--s5); margin-block-end:var(--s6); }
.section-head .index { margin-block-end:var(--s5); }
.section-heading { min-width:0; max-width:min(100%,calc(var(--shell) / 12 * 8)); }
.section-action {
  margin-inline-start:auto; display:inline-flex; align-items:center;
  min-height:44px; font-size:var(--t-meta); color:var(--ivory-2);
  border-block-end:1px solid transparent; white-space:nowrap;
  transition:border-color 160ms ease-out,color 160ms ease-out,background-color 160ms ease-out,filter 120ms ease-out;
}
.section-action:hover { color:var(--ivory); border-block-end-color:var(--brass); }

.rule { border-block-start:1px solid var(--line); margin-block:var(--band); }

/* ---------- the plate (§1) ---------- */

.plate {
  position:relative;
  container-type:inline-size;
  overflow:hidden;
  isolation:isolate;
  background:radial-gradient(120% 90% at var(--ox,28%) 14%,#1B1A1D,#0E0E10 58%,#0A0A0B);
  box-shadow:inset 0 1px 0 rgba(244,239,231,.06), inset 0 -90px 70px -70px #0A0A0B;
}
/* Layer 2 — category wash. Flat colour, never a hashed hue.
   §10.5: soft-light at .09 measures 1 RGB level of separation over this ground
   — the tint is not subtle, it is absent. screen at .14 lifts 12 and spreads 6,
   which is perceptible as difference without being nameable. */
.plate::before {
  content:""; position:absolute; inset:0;
  background:var(--wash,transparent);
  opacity:.14; mix-blend-mode:screen;
  pointer-events:none;
}
/* Layer 4 — the engraving. */
.plate .plate-engraving { position:absolute; inset:0; width:100%; height:100%; }
/* Layer 3 — monogram deboss. The plate's subject. */
.plate-mono {
  position:absolute; inset:0;
  display:flex; align-items:center; justify-content:center;
  font-family:var(--display);
  font-variation-settings:'SOFT' 0,'WONK' 0,'opsz' 144;
  font-size:44cqw; line-height:1; letter-spacing:-.02em;
  color:var(--ink-800);
  -webkit-text-stroke:.5px rgba(174,148,99,.35);
  text-shadow:0 1px 0 rgba(244,239,231,.05), 0 -1px 0 rgba(0,0,0,.6);
  user-select:none;
}
/* Gatherings get a chart rule instead of a monogram — instrumentation, not
   decoration. Two repeating gradients: an 8px tick, and every fifth taller. */
.plate-rule {
  position:absolute; inset-inline:0; bottom:14%; height:16%;
  background-image:
    repeating-linear-gradient(90deg,var(--brass-hair) 0 1px,transparent 1px 40px),
    repeating-linear-gradient(90deg,var(--line-lit) 0 1px,transparent 1px 8px);
  background-size:100% 100%,100% 52%;
  background-position:0 100%,0 100%;
  background-repeat:no-repeat;
}
.plate--card { aspect-ratio:4/3; }
.plate--square { aspect-ratio:1/1; }
.plate--hero { aspect-ratio:4/3; }
@media (min-width:768px) {
  .plate--card { aspect-ratio:3/2; }
  .plate--hero { aspect-ratio:21/9; }
}
.plate-photo { width:100%; height:100%; object-fit:cover; }

/* ---------- grids (§4: shared hairlines, a printed index) ---------- */

.grid {
  display:grid;
  gap:1px;
  grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr));
}
.grid > * { min-width:0; }
.grid--wide { grid-template-columns:repeat(auto-fill,minmax(min(420px,100%),1fr)); }
.grid--thirds { grid-template-columns:repeat(auto-fill,minmax(min(220px,100%),1fr)); }
/* The hairline is a 1px spread on each cell rather than a background behind the
   whole grid: a ragged last row would otherwise leave lit rectangles where the
   missing cells are. Same drawing, no artefact, no elevation. */
.grid--hair > * { box-shadow:0 0 0 1px var(--line); }

/* 375: plates full-bleed past the gutters. Negative margin only — never 100vw,
   which overflows by the scrollbar width. */
@media (max-width:767px) {
  .grid--bleed { margin-inline:calc(var(--pad) * -1); }
}

/* ---------- cards ---------- */

.card {
  position:relative;
  display:flex; flex-direction:column; min-width:0;
  background:var(--ink-900);
  box-shadow:inset 0 1px 0 rgba(244,239,231,.05);
  transition:background-color 160ms ease-out;
}
.grid:not(.grid--hair) > .card { border:1px solid var(--line); border-radius:2px; }
.card:hover { background:var(--ink-850); }
.card-body { display:flex; flex-direction:column; gap:var(--s2); padding:20px; flex:1 1 auto; }
.card-title { margin-block-start:var(--s1); }
/* Whole-card link — never an <a> inside an <a> (§10.4). Any block that wants
   the same behaviour marks itself .linkbox and its heading .linkbox-title. */
.linkbox { position:relative; }
.card-title a::after,.linkbox-title a::after { content:""; position:absolute; inset:0; }
.card .secondary,.linkbox .secondary { position:relative; z-index:2; }
.card-text { color:var(--ivory-dim); font-size:var(--t-meta); line-height:1.55; }
.card-foot {
  margin-block-start:auto; padding-block-start:var(--s3);
  border-block-start:1px solid var(--line);
  display:flex; flex-wrap:wrap; align-items:center; gap:var(--s2) var(--s4);
}

/* ---------- buttons ---------- */

.btn {
  display:inline-flex; align-items:center; justify-content:center; gap:var(--s2);
  min-height:48px; padding:0 20px;
  font-family:var(--ui); font-size:var(--t-meta); font-weight:500; letter-spacing:.01em;
  line-height:1.2; text-align:center;
  border:1px solid transparent; border-radius:2px;
  cursor:pointer;
  transition:border-color 160ms ease-out,color 160ms ease-out,background-color 160ms ease-out,filter 120ms ease-out;
}
.btn--primary { background:var(--ivory); color:var(--ink-950); }
.btn--primary:hover { background:var(--ivory-2); color:var(--ink-950); }
.btn--ghost { background:transparent; color:var(--ivory); border-color:var(--line-strong); }
.btn--ghost:hover { color:var(--ivory); border-color:var(--ivory-dim); background:var(--ink-850); }
.hero .lede, .hero-lede { margin-block-start:12px; }

.btn--quiet {
  min-height:48px;
  min-height:44px; padding:0; border:0; background:none; color:var(--ivory-2);
  border-block-end:1px solid var(--brass-hair); border-radius:0;
}
.btn--quiet:hover { color:var(--brass-lit); border-block-end-color:var(--brass); }
.btn--block { width:100%; }
/* These two ship together or neither ships (§10.4). */
.btn:active { filter:brightness(.90); }
.btn[disabled],.btn[aria-disabled='true'] {
  color:var(--ivory-faint); background:transparent;
  border-color:var(--line-strong); cursor:not-allowed;
}
.btn[disabled]:active { filter:none; }

/* ---------- status text (never a coloured chip, §5/§7) ---------- */

.status {
  font-size:var(--t-micro); line-height:1; font-weight:500;
  text-transform:uppercase; letter-spacing:.18em;
  color:var(--ivory-dim); white-space:nowrap;
}
.status--brass { color:var(--brass); }
.status--warn { color:var(--warn); }
.status--rust { color:var(--rust); }
.status--slate { color:var(--slate); }

/* ---------- filters (§5: hairline row, brass underline, never pills) ---------- */

.filters { display:flex; flex-wrap:wrap; gap:0 var(--s5); border-block-end:1px solid var(--line); }
.filter {
  display:inline-flex; align-items:center; min-height:48px;
  font-size:var(--t-micro); font-weight:500; text-transform:uppercase; letter-spacing:.18em;
  color:var(--ivory-faint);
  border-block-end:1px solid transparent; margin-block-end:-1px;
  transition:border-color 160ms ease-out,color 160ms ease-out,background-color 160ms ease-out,filter 120ms ease-out;
}
.filter:hover { color:var(--ivory-2); }
.filter[aria-current='page'] { color:var(--ivory); border-block-end-color:var(--brass); }

/* ---------- fields (§5 Join: bare ink, a rule under each input) ---------- */

.field { display:block; }
.field + .field { margin-block-start:var(--s5); }
.field-label { display:block; margin-block-end:var(--s2); color:var(--ivory-dim); font-size:var(--t-meta); }
.field-req { color:var(--brass); }
input,select,textarea {
  /* Under 16px iOS zooms on focus and pans sideways, breaking the overflow
     gate in a way desktop never catches (§10.4). */
  font-size:max(16px,1rem);
  font-family:var(--ui);
  color:var(--ivory);
  background:transparent;
  border:0;
  border-block-end:1px solid var(--line-strong);
  border-radius:0;
  width:100%;
  min-height:48px;
  padding:0 0 var(--s2);
  transition:border-color 160ms ease-out,color 160ms ease-out,background-color 160ms ease-out,filter 120ms ease-out;
}
textarea { min-height:120px; padding-block-start:var(--s2); resize:vertical; line-height:1.6; }
input::placeholder,textarea::placeholder { color:var(--ivory-faint); }
input:hover,select:hover,textarea:hover { border-block-end-color:var(--ivory-dim); }
input[aria-invalid='true'],textarea[aria-invalid='true'],select[aria-invalid='true'] { border-block-end-color:var(--rust); }
.field-hint { display:block; margin-block-start:var(--s2); font-size:var(--t-meta); color:var(--ivory-faint); }
.field-error { display:block; margin-block-start:var(--s2); font-size:var(--t-meta); color:var(--rust); }
.field-code input { font-family:var(--mono); letter-spacing:.14em; text-transform:uppercase; }
.invitation {
  font-family:var(--display); font-variation-settings:'SOFT' 0,'WONK' 0,'opsz' 144;
  font-style:italic; font-size:var(--t-lede); color:var(--ivory-2); line-height:1.45;
}
.column-420 { width:100%; max-width:420px; }

fieldset[disabled] input { color:var(--ivory-dim); border-block-end-style:dashed; }

/* ---------- alert (§10.4 confirmation banner) ---------- */

.alert {
  border-inline-start:1px solid var(--line-strong);
  padding:var(--s3) var(--s4);
  font-size:var(--t-meta); color:var(--ivory-2);
  background:var(--ink-900);
}
.alert--brass { border-inline-start-color:var(--brass); color:var(--ivory); }
.alert--warn { border-inline-start-color:var(--warn); color:var(--ivory); }
.alert--rust { border-inline-start-color:var(--rust); color:var(--ivory); }
.alert--confirm { animation:banner 240ms cubic-bezier(.2,0,0,1) 1; }
@keyframes banner { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }

/* ---------- empty state (fact + next action, no illustration) ---------- */

.empty { border-block:1px solid var(--line); padding-block:var(--s7); max-width:var(--measure); }
.empty-note { margin-block-start:var(--s3); color:var(--ivory-dim); font-size:var(--t-meta); }
.empty-action { margin-block-start:var(--s5); }

/* ---------- stat, avatar ---------- */

.stat { display:flex; flex-direction:column; gap:var(--s2); min-width:0; }
.stat-value { font-family:var(--mono); font-size:var(--t-sec); line-height:1; letter-spacing:-.01em; color:var(--ivory); }
.stat--brass .stat-value { color:var(--brass); }

/* No coloured avatars, and no radius over 4px — so: a hairline square. */
.avatar {
  flex:none;
  display:inline-flex; align-items:center; justify-content:center;
  width:36px; height:36px;
  border:1px solid var(--line-strong); border-radius:2px;
  background:var(--ink-900);
  font-family:var(--display); font-variation-settings:'SOFT' 0,'WONK' 0,'opsz' 144;
  font-size:.75rem; letter-spacing:.02em; line-height:1; color:var(--ivory-2);
}

/* ---------- gallery (contract §A) ---------- */

.gallery {
  display:flex; gap:1px;
  overflow-x:auto;
  scroll-snap-type:x mandatory;
  -webkit-overflow-scrolling:touch;
  overscroll-behavior-x:contain;
  padding-block-end:var(--s2);
}
.gallery-item { flex:0 0 auto; width:min(78vw,320px); scroll-snap-align:start; }
.gallery-item .plate { aspect-ratio:4/3; }
.gallery-caption { display:block; margin-block-start:var(--s3); padding-inline:var(--s3) 0; font-size:var(--t-meta); color:var(--ivory-dim); }
@media (min-width:900px) { .gallery-item { width:340px; } }

/* ---------- member and attendee lists (contract §B, §C) ---------- */

.people { display:grid; gap:1px; grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr)); }
.people > * { min-width:0; box-shadow:0 0 0 1px var(--line); }
.person { display:flex; align-items:flex-start; gap:var(--s3); padding:var(--s4); background:var(--ink-900); height:100%; }
.person .plate { flex:none; width:44px; height:44px; }
.person-body { min-width:0; }
.person-name { font-size:var(--t-body); color:var(--ivory); }
.person-line { font-size:var(--t-meta); color:var(--ivory-dim); }
.people-foot { margin-block-start:var(--s4); display:flex; flex-wrap:wrap; align-items:center; gap:var(--s3) var(--s5); }

/* ---------- ledger (§5: not a card grid) ---------- */

.ledger { border-block-start:1px solid var(--line); }
.ledger-month {
  display:flex; align-items:center; gap:var(--s3);
  padding-block:var(--s5) var(--s3);
  border-block-end:1px solid var(--line);
}
.ledger-row {
  position:relative;
  display:grid;
  grid-template-columns:88px 64px minmax(0,1fr);
  align-items:start;
  gap:var(--s2) var(--s4);
  padding-block:var(--s4);
  border-block-end:1px solid var(--line);
  transition:background-color 160ms ease-out;
}
.ledger-row:hover { background:var(--ink-900); }
.ledger-date { font-family:var(--mono); font-size:var(--t-meta); line-height:1.45; color:var(--ivory-faint); }
.ledger-date b,.ledger-date span { display:block; }
.ledger-date b { font-weight:500; color:var(--ivory); }
.ledger-date span:last-child { color:var(--ivory-dim); }
.ledger-thumb { width:64px; height:64px; }
.ledger-title { font-family:var(--display); font-variation-settings:'SOFT' 0,'WONK' 0,'opsz' 144; font-size:var(--t-body); font-weight:400; color:var(--ivory); }
.ledger-main { min-width:0; display:flex; flex-direction:column; gap:var(--s1); grid-column:1 / -1; }
.ledger-foot { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s1) var(--s3); margin-block-start:var(--s1); }
@media (min-width:560px) {
  .ledger-main { grid-column:auto; }
}
@media (min-width:900px) {
  .ledger-row { grid-template-columns:88px 64px minmax(0,1fr) auto; align-items:center; }
  .ledger-foot { margin-block-start:0; justify-content:flex-end; }
}

/* ---------- calendar (contract §D) ---------- */

.cal-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:var(--s4); margin-block-end:var(--s5); }
.cal-nav { margin-inline-start:auto; display:flex; gap:var(--s5); }
.cal-grid,.cal-dow { display:none; }
.cal-list { display:block; }
.cal-day-row { display:grid; grid-template-columns:64px minmax(0,1fr); gap:var(--s4); padding-block:var(--s4); border-block-start:1px solid var(--line); }
.cal-day-row.is-today .cal-day-label { color:var(--brass); }
.cal-day-label { font-family:var(--mono); font-size:var(--t-meta); color:var(--ivory-faint); }
.cal-day-label span { display:block; }
.cal-day-label .num { font-size:var(--t-lede); line-height:1.1; color:var(--ivory); }
.cal-day-row.is-today .cal-day-label .num { color:var(--brass); }
.cal-entry { display:grid; grid-template-columns:auto minmax(0,1fr); column-gap:8px;
  align-items:baseline; min-height:32px; }
/* The body-level overflow-wrap:anywhere backstop (§10.4) is right for long
   venue names and emails, but it also breaks a time across lines as
   "06:" / "40". A clock time, a price and a ticket code are atomic. */
.cal-entry .num, .num, .mono, .ledger-date, .price { overflow-wrap:normal; word-break:normal; }
.cal-entry .num { white-space:nowrap; }
.cal-entry .num { color:var(--brass); font-size:var(--t-meta); }
.cal-entry-title { font-size:var(--t-meta); color:var(--ivory-2); }
.cal-entry a:hover { color:var(--ivory); }
.cal-empty { font-size:var(--t-meta); color:var(--ivory-faint); }
.cal-more { font-size:var(--t-micro); text-transform:uppercase; letter-spacing:.18em; color:var(--ivory-faint); }

@media (min-width:900px) {
  .cal-list { display:none; }
  .cal-dow { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:1px; margin-block-end:1px; }
  .cal-dow > * { padding:var(--s2) var(--s3); min-width:0; }
  .cal-grid { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:1px; }
  .cal-grid > * { min-width:0; box-shadow:0 0 0 1px var(--line); }
  .cal-cell { min-height:118px; padding:var(--s3); background:var(--ink-900); display:flex; flex-direction:column; gap:var(--s1); }
  .cal-cell.is-outside { background:var(--ink-950); }
  .cal-cell.is-outside .cal-num { color:var(--ivory-faint); }
  /* Today is a 1px brass rule, never a filled block. */
  .cal-cell.is-today { box-shadow:0 0 0 1px var(--line), inset 0 1px 0 var(--brass); }
  .cal-num { font-family:var(--mono); font-size:var(--t-meta); color:var(--ivory-dim); }
  .cal-cell.is-today .cal-num { color:var(--brass); }
  .cal-cell .cal-entry { min-height:0; display:block; }
  .cal-cell .cal-entry .num { margin-inline-end:var(--s1); }
}

/* ---------- pass table (§5: one bordered table, not three cards) ---------- */

.pass-table { width:100%; min-width:19rem; border-collapse:collapse; text-align:left; }
.pass-table th,.pass-table td { padding:var(--s4) var(--s3); border-block-end:1px solid var(--line); vertical-align:top; }
.pass-table thead th {
  padding-block:var(--s3); font-size:var(--t-micro); font-weight:500;
  text-transform:uppercase; letter-spacing:.18em; color:var(--ivory-faint);
}
.pass-table tbody tr:last-child th,.pass-table tbody tr:last-child td { border-block-end:0; }
.pass-table th:first-child,.pass-table td:first-child { padding-inline-start:var(--s4); }
.pass-table th:last-child,.pass-table td:last-child { padding-inline-end:var(--s4); text-align:right; }
.pass-name {
  font-family:var(--display); font-variation-settings:'SOFT' 0,'WONK' 0,'opsz' 144;
  font-size:var(--t-card); font-weight:400; color:var(--ivory);
}
.pass-price { font-family:var(--mono); font-weight:500; color:var(--brass); white-space:nowrap; }
.pass-derivation { display:block; margin-block-start:var(--s1); font-size:var(--t-meta); color:var(--ivory-faint); }
.bordered { border:1px solid var(--line); border-radius:2px; background:var(--ink-900); }

/* ---------- pass cards (account, where a table would be overkill) ---------- */

.pass-grid { display:grid; gap:1px; grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr)); }
.pass-grid > * { min-width:0; box-shadow:0 0 0 1px var(--line); }
.pass-card { background:var(--ink-900); padding:var(--s5); display:flex; flex-direction:column; gap:var(--s2); height:100%; }
.pass-card-price { font-family:var(--mono); font-weight:500; font-size:var(--t-card); color:var(--brass); }

/* ---------- credits: N hairline squares, filled = spent (§5) ---------- */

.credits { display:flex; flex-wrap:wrap; gap:6px; }
.credit-sq { width:16px; height:16px; border:1px solid var(--line-strong); border-radius:1px; }
.credit-sq.is-spent { background:var(--ivory-dim); border-color:var(--ivory-dim); }

/* ---------- action area (the contract's seven states) ---------- */

.action { display:flex; flex-direction:column; gap:var(--s3); }
.action-kicker { font-size:var(--t-meta); color:var(--ivory-dim); }
.action-kicker a { color:var(--ivory-2); border-block-end:1px solid var(--brass-hair); }
.action-kicker a:hover { color:var(--brass-lit); }
.action-line { font-family:var(--mono); font-size:var(--t-meta); color:var(--ivory-2); }
.action-help { font-size:var(--t-meta); color:var(--ivory-dim); }
.action-help a { border-block-end:1px solid var(--brass-hair); }
.action-help a:hover { color:var(--brass-lit); }
.action-passes { display:grid; gap:var(--s2); }
.action-heading { font-size:var(--t-meta); color:var(--ivory); }
.action-stub {
  display:flex; align-items:center; justify-content:space-between; gap:var(--s3);
  min-height:48px; padding:0 var(--s4);
  border:1px solid var(--brass-hair); border-radius:2px;
  color:var(--ivory);
  transition:border-color 160ms ease-out,color 160ms ease-out,background-color 160ms ease-out,filter 120ms ease-out;
}
.action-stub:hover { border-color:var(--brass); background:var(--ink-900); }
.action-stub .num { color:var(--brass); letter-spacing:.1em; }
.action-sidebar { position:sticky; top:calc(var(--header-h) + 24px); }
/* The one large brass number in the product (§5). */
.places-left { font-family:var(--mono); font-weight:500; font-size:var(--t-sec); line-height:1; color:var(--brass); }

/* ---------- action bar (§10.1: opaque, never glass) ---------- */

.actionbar {
  position:fixed; inset-inline:0; bottom:0; z-index:45;
  display:flex; align-items:center; gap:var(--s3);
  min-height:52px;
  background:var(--ink-900);
  border-block-start:1px solid var(--line-strong);
  box-shadow:0 -12px 32px rgba(0,0,0,.45);
  padding-block:var(--s2);
  padding-block-end:calc(var(--s2) + env(safe-area-inset-bottom,0px));
  padding-inline-start:calc(var(--pad) + env(safe-area-inset-left,0px));
  padding-inline-end:calc(var(--pad) + env(safe-area-inset-right,0px));
}
.actionbar-text { min-width:0; flex:1 1 auto; }
.actionbar-title { font-size:var(--t-meta); color:var(--ivory); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.actionbar-note { font-family:var(--mono); font-size:var(--t-micro); color:var(--ivory-dim); }
.actionbar .btn { flex:none; }
@media (min-width:900px) { .actionbar { display:none; } }

/* ---------- ticket (§5) ---------- */

.ticket {
  position:relative;
  border:1px solid var(--brass-hair);
  border-radius:2px;
  background:radial-gradient(120% 90% at var(--ox,28%) 14%,#1B1A1D,#0E0E10 58%,#0A0A0B);
  box-shadow:inset 0 1px 0 rgba(244,239,231,.06);
  padding:var(--s6) var(--s5) var(--s6) var(--s7);
  overflow:hidden;
}
/* Double rule: the border above, plus a 1px inset at 4px. */
.ticket::before {
  content:""; position:absolute; inset:4px;
  border:1px solid var(--brass-hair); border-radius:1px; pointer-events:none;
}
/* Perforation down one edge. */
.ticket::after {
  content:""; position:absolute; inset-block:0; inset-inline-start:20px; width:1px;
  background-image:repeating-linear-gradient(180deg,var(--brass-hair) 0 4px,transparent 4px 10px);
  pointer-events:none;
}
.ticket-code {
  font-family:var(--mono); font-weight:500; font-size:var(--t-code);
  line-height:1; letter-spacing:.12em; color:var(--ivory); overflow-wrap:anywhere;
}
.ticket-grid { display:grid; gap:var(--s4) var(--s6); grid-template-columns:repeat(auto-fill,minmax(min(190px,100%),1fr)); margin-block-start:var(--s6); }
.ticket-grid > * { min-width:0; }
.ticket-dd { color:var(--ivory-2); font-size:var(--t-meta); margin-block-start:var(--s1); }
.ticket-seal { position:absolute; top:var(--s5); right:var(--s5); width:72px; height:72px; color:var(--brass); opacity:.55; }
@media (max-width:559px) { .ticket-seal { display:none; } }

/* ---------- checkout (contract §E) ---------- */

.checkout { display:grid; gap:var(--s5); max-width:520px; }
.checkout-lines { border-block:1px solid var(--line); }
.checkout-line { display:flex; align-items:baseline; gap:var(--s4); padding-block:var(--s3); border-block-end:1px solid var(--line); }
.checkout-line:last-child { border-block-end:0; }
.checkout-line dt { color:var(--ivory-dim); font-size:var(--t-meta); }
.checkout-line dd { margin-inline-start:auto; text-align:right; color:var(--ivory-2); }
.checkout-card { border:1px solid var(--line); border-radius:2px; padding:var(--s4); background:var(--ink-900); }
.checkout-demo { color:var(--slate); font-size:var(--t-meta); }
.card-digits { font-family:var(--mono); letter-spacing:.14em; color:var(--ivory-2); }

/* ---------- definition list (when/where, §5) ---------- */

.deflist { display:grid; gap:var(--s5); grid-template-columns:repeat(auto-fill,minmax(min(190px,100%),1fr)); }
.deflist > div { min-width:0; }
.deflist dd { margin-block-start:var(--s2); color:var(--ivory-2); }

/* ---------- motion (§10.3: the three permitted transitions, and nothing else) ---------- */

@media (prefers-reduced-motion:reduce) {
  html { scroll-behavior:auto !important; }
  *,*::before,*::after {
    animation-duration:.001ms !important;
    animation-iteration-count:1 !important;
    transition-duration:.001ms !important;
    scroll-behavior:auto !important;
  }
}
/* §10.1: the desktop sticky sidebar and the fixed mobile action bar are
   alternatives, never both. Below 900px the bar owns the action, so a phone
   never shows two competing calls to action on one screen. */
.nav-signout { display:inline-flex; margin:0; }
.nav-link--plain { background:none; border:0; padding:0; margin:0; cursor:pointer;
  font:inherit; color:var(--ivory-dim); min-height:44px; display:inline-flex; align-items:center; }
.nav-link--plain:hover { color:var(--brass-lit); }
.nav-panel .nav-link--plain { min-height:48px; width:100%; }

.action-sidebar { display:none; }
@media (min-width:900px) { .action-sidebar { display:block; } }
`;
