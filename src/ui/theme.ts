/**
 * The 2CC design system: tokens plus the whole stylesheet, as one string.
 *
 * Built to `design/reference/design-decisions.md`. That file is the spec and it
 * wins over everything; §10 carries measured corrections that override §2, and
 * §11 records the light-first turn this file now implements.
 *
 * Inlined into every page by `src/ui/layout.tsx` — there is no build step and
 * no CSS file to keep in sync, so the document arrives styled in one round
 * trip.
 *
 * **Two themes, light by default.** The premise in §0–§2 was "look expensive
 * with zero photography", and near-black plus brass was the answer to that
 * question. There are photographs now, so paper leads: photographs read better
 * on white, the plate is demoted to a fallback, and the dark palette survives
 * as the alternative rather than as the design.
 *
 * The cascade is three layers and the order matters (§11):
 *   1. `:root`                                        — the full LIGHT palette.
 *   2. `@media (prefers-color-scheme:dark) :root:not([data-theme="light"])`
 *   3. `:root[data-theme="dark"]`                     — so the toggle wins.
 * Every colour is defined at layer 1. Nothing has its only definition inside a
 * media query, so a token can never come out unset.
 *
 * `data-theme` is stamped server-side from the `2cc_theme` cookie
 * (`src/routes/theme.ts`), which is why there is no flash of the wrong theme
 * and no blocking inline script.
 *
 * Mobile-first. Everything is written for 375px and widens from there; anything
 * that could be wider than its column wraps or scrolls inside its own box
 * rather than pushing the page sideways (§10.4).
 */

/**
 * The page background of each theme, for the places CSS custom properties
 * cannot reach — `<meta name="theme-color">` in the document head.
 */
export const pageColor = { light: "#FBFAF8", dark: "#0A0A0B" } as const;

/**
 * The light palette — the default.
 *
 * Every text value is measured against all three backgrounds it can sit on
 * (`--paper`, `--paper-2`, `--card`); the worst case is the number in the
 * comment. AA is 4.5:1 for body, 3:1 for large text and control boundaries.
 *
 * `--line-strong` is the one that had to move: at the proposed `.32` it
 * composites to 2.08:1 on paper, which fails SC 1.4.11 for anything that is
 * the only boundary of a control. `.46` measures 3.02:1 worst case.
 */
const light = {
  /**
   * Which way the browser paints the things CSS does not own — native
   * radios, checkboxes, scrollbars. It has to be a per-theme value, not the
   * `light dark` in the meta tag: that only declares support, and the UA then
   * follows the SYSTEM preference. Measured on /host with an explicit light
   * cookie and a dark system preference, every unchecked radio came back with
   * `color: rgb(255,255,255)` and rendered as a filled dark disc on paper.
   */
  colorScheme: "light",
  paper: "#FBFAF8",
  paper2: "#F4F1EC",
  card: "#FFFFFF",
  line: "rgba(20,19,15,.12)",
  lineMid: "rgba(20,19,15,.20)",
  /** Mandatory on any boundary that is the only thing defining a control. 3.02:1. */
  lineStrong: "rgba(20,19,15,.46)",
  ink: "#14130F", //     16.50:1
  ink2: "#4A4741", //     8.22:1
  ink3: "#5E5A54", //     6.08:1
  inkFaint: "#6E6A64", // 4.77:1
  accent: "#7A5C2E", //   5.49:1
  accent2: "#5C4522", //  8.00:1
  accentHair: "rgba(122,92,46,.34)",
  slate: "#55606D", //    5.68:1
  rust: "#8E4A32", //     5.87:1
  warn: "#8A4B18", //     6.01:1
  selection: "rgba(122,92,46,.20)",
  /** The plate fallback, as toned paper stock rather than as lit black. */
  plate1: "#FFFFFF",
  plate2: "#F2EEE7",
  plate3: "#E7E1D7",
  plateMono: "#EAE4D9",
  plateMonoStroke: "rgba(122,92,46,.34)",
  plateEmboss: "0 1px 0 rgba(255,255,255,.9), 0 -1px 0 rgba(20,19,15,.10)",
  plateInset: "inset 0 0 0 1px rgba(20,19,15,.10)",
  /** `screen` cannot tint paper; `multiply` at .14 lifts 28 levels, spread 6. */
  washBlend: "multiply",
  washAlpha: ".14",
  engraveOpacity: ".30",
  /** Hairline plus a whisper of vignette so a pale photograph keeps its edge. */
  photoEdge: "rgba(20,19,15,.16)",
  photoVignette: "inset 0 0 44px -22px rgba(20,19,15,.34)",
  /** The foot a hero photograph fades to, so the overlapping h1 stays legible. */
  photoFoot: "rgba(251,250,248,.97)",
  /** The product's one drop shadow, on the sticky header. */
  shadowHeader: "0 18px 32px -30px rgba(20,19,15,.45)",
  shadowBar: "0 -12px 32px -18px rgba(20,19,15,.30)",
};

/**
 * The property list every palette has to fill. The light object above defines
 * it, so a token added there without a dark counterpart is a typecheck error
 * rather than a colour that silently comes out unset in one theme.
 */
type Palette = typeof light;

/**
 * The dark palette — the alternative, not the default.
 *
 * These are §10.2's measured values, unchanged: they were computed against
 * `#0A0A0B` and they pass. The only dark things deleted are the ones that only
 * ever made sense in the dark — the global film grain and the lit inset
 * highlights on cards.
 */
const dark: Palette = {
  colorScheme: "dark",
  paper: "#0A0A0B",
  paper2: "#141416",
  card: "#101012",
  line: "rgba(244,239,231,.08)",
  lineMid: "rgba(244,239,231,.16)",
  /** 3.46:1 — the only alpha that clears SC 1.4.11 on this ground (§10.2). */
  lineStrong: "rgba(244,239,231,.40)",
  ink: "#F4EFE7", //     16.07:1
  ink2: "#CFC8BC", //    11.08:1
  ink3: "#A9A399", //     7.35:1
  inkFaint: "#8A857D", // 5.02:1
  accent: "#AE9463", //   6.32:1
  accent2: "#D8C39A", // 10.68:1
  accentHair: "rgba(174,148,99,.30)",
  slate: "#8A94A0", //    5.98:1
  rust: "#B0745B", //     4.81:1
  warn: "#D98A6A", //     6.83:1
  selection: "rgba(174,148,99,.28)",
  plate1: "#1B1A1D",
  plate2: "#0E0E10",
  plate3: "#0A0A0B",
  plateMono: "#17171A",
  plateMonoStroke: "rgba(174,148,99,.35)",
  plateEmboss: "0 1px 0 rgba(244,239,231,.05), 0 -1px 0 rgba(0,0,0,.6)",
  plateInset: "inset 0 -90px 70px -70px #0A0A0B",
  /** §10.5: soft-light is invisible on near-black; screen at .14 lifts 12, spread 6. */
  washBlend: "screen",
  washAlpha: ".14",
  engraveOpacity: ".22",
  photoEdge: "rgba(244,239,231,.14)",
  photoVignette: "inset 0 0 44px -22px rgba(0,0,0,.55)",
  photoFoot: "rgba(10,10,11,.97)",
  shadowHeader: "0 24px 48px -24px rgba(0,0,0,.8)",
  shadowBar: "0 -12px 32px rgba(0,0,0,.45)",
};

/** The colour half of `:root` — the same property list for either palette. */
function palette(p: Palette): string {
  return `
  color-scheme:${p.colorScheme};
  --paper:${p.paper}; --paper-2:${p.paper2}; --card:${p.card};
  --line:${p.line}; --line-mid:${p.lineMid}; --line-strong:${p.lineStrong};
  --ink:${p.ink}; --ink-2:${p.ink2}; --ink-3:${p.ink3}; --ink-faint:${p.inkFaint};
  --accent:${p.accent}; --accent-2:${p.accent2}; --accent-hair:${p.accentHair};
  --slate:${p.slate}; --rust:${p.rust}; --warn:${p.warn};
  --selection:${p.selection};
  --plate-1:${p.plate1}; --plate-2:${p.plate2}; --plate-3:${p.plate3};
  --plate-mono-fill:${p.plateMono}; --plate-mono-stroke:${p.plateMonoStroke};
  --plate-emboss:${p.plateEmboss}; --plate-inset:${p.plateInset};
  --wash-blend:${p.washBlend}; --wash-alpha:${p.washAlpha};
  --engrave-opacity:${p.engraveOpacity};
  --photo-edge:${p.photoEdge}; --photo-vignette:${p.photoVignette}; --photo-foot:${p.photoFoot};
  --shadow-header:${p.shadowHeader}; --shadow-bar:${p.shadowBar};`;
}

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
 * Esc closes the mobile nav. Four lines of progressive enhancement (§10.4) —
 * the disclosure itself is a `<details>` and works with scripting off.
 */
export const escScript =
  "addEventListener('keydown',function(e){if(e.key!=='Escape')return;" +
  "var d=document.querySelector('details.nav-mobile[open]');" +
  "if(!d)return;d.open=false;var s=d.querySelector('summary');if(s)s.focus();});";

export const css = `
:root {${palette(light)}

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
}

/* Layer 2 — the system preference, but only while no explicit choice is in
   force. Layer 3 — the explicit choice, which has to win in both directions,
   so the same overrides are repeated rather than folded into one selector
   list: a browser that does not understand one selector must not drop both. */
@media (prefers-color-scheme:dark) {
  :root:not([data-theme='light']) {${palette(dark)}
  }
}
:root[data-theme='dark'] {${palette(dark)}
}

*,*::before,*::after { box-sizing:border-box; }

html { -webkit-text-size-adjust:100%; scroll-behavior:smooth; overflow-x:clip; }

body {
  margin:0;
  min-height:100vh;
  display:flex;
  flex-direction:column;
  background:var(--paper);
  color:var(--ink);
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

/* §1's global film grain is gone. It existed to give a photograph-free product
   a printed surface; over 36 real photographs an overlay blend is just a dirty
   screen, and it was the one thing in the product painted above everything at
   z-index 9999. Deleted rather than inverted (§11). */

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

/* Focus rings are never transitioned. The inner page-coloured ring keeps the
   accent legible even on an ink-filled button (§10.4). */
:focus-visible {
  outline:2px solid var(--accent);
  outline-offset:2px;
  box-shadow:0 0 0 2px var(--paper);
}

::selection { background:var(--selection); color:var(--ink); }

.vh {
  position:absolute; width:1px; height:1px; margin:-1px; padding:0;
  overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0;
}

.skip-link {
  position:absolute; left:-9999px; top:0; z-index:60;
  background:var(--card); border:1px solid var(--line-strong);
  color:var(--ink); padding:12px 16px; border-radius:2px;
}
.skip-link:focus { left:var(--pad); top:10px; }

/* ---------- measure and rhythm ---------- */

.shell { width:100%; max-width:var(--shell); margin-inline:auto; padding-inline:var(--pad); }
.prose { max-width:var(--measure); color:var(--ink-2); }
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
.scroll-x:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }

/* Inline actions were measured at 15–25px tall. Grow the hit area without moving
   a pixel of the layout (§10.4). */
.cal-entry a, .ledger-row a, .ledger-cell a, .acct-row a, .table a, .stack-rows a, .person a {
  display:inline-flex; align-items:center; min-height:44px;
  margin-block:-10px; margin-inline:-8px; padding-inline:8px;
}
@media (pointer:coarse) {
  .cal-entry a, .ledger-row a, .acct-row a, .table a { min-height:48px; }
}

/* ---------- the two brand gestures (§3) ---------- */

/* 1. Rule-and-index: a 24px accent hairline, a mono numeral, a micro-caps label. */
.index {
  display:flex; align-items:center; gap:var(--s3);
  margin:0 0 var(--s6);
  font-size:var(--t-micro); line-height:1;
}
.index-rule { flex:none; width:24px; height:1px; background:var(--accent); }
.index-num { font-family:var(--mono); font-weight:500; color:var(--accent); letter-spacing:.08em; }
.index-sep { color:var(--ink-faint); }
.index-label { text-transform:uppercase; letter-spacing:.18em; color:var(--ink-3); font-weight:500; }

/* 2. Optical inset: the first glyph sits on the container edge, not near it. */
.h-hero,.h-page { text-indent:-.055em; }

/* ---------- type roles ---------- */

.micro {
  display:inline-block;
  font-size:var(--t-micro); line-height:1; font-weight:500;
  text-transform:uppercase; letter-spacing:.18em;
  color:var(--ink-3);
}
.micro--brass { color:var(--accent); }

.meta { font-size:var(--t-meta); line-height:1.4; letter-spacing:.02em; color:var(--ink-3); }
.meta--bright { color:var(--ink-2); }
.num { font-family:var(--mono); font-weight:400; font-feature-settings:'tnum' 1; }
.dot { color:var(--ink-faint); padding-inline:.4em; }

.h-hero { font-size:var(--t-hero); line-height:.94; letter-spacing:-.025em; font-weight:300; }
.h-page { font-size:var(--t-h1); line-height:1.02; letter-spacing:-.02em; font-weight:300; }
.h-sec  { font-size:var(--t-sec); line-height:1.15; letter-spacing:-.015em; }
.h-card { font-size:var(--t-card); line-height:1.25; letter-spacing:-.01em; }
.lede   { font-size:var(--t-lede); line-height:1.5; letter-spacing:-.005em; color:var(--ink-2); }

/* ---------- header ---------- */

.site-header {
  position:sticky; top:0; z-index:50;
  background:var(--paper);
  border-block-end:1px solid var(--line);
  box-shadow:var(--shadow-header);
}
.header-inner { display:flex; align-items:center; gap:var(--s4); min-height:var(--header-h); }

.wordmark {
  font-family:var(--display);
  font-variation-settings:'SOFT' 0,'WONK' 0,'opsz' 144;
  font-size:1.0625rem; letter-spacing:.26em; color:var(--ink);
  white-space:nowrap; margin-inline-end:auto;
  display:inline-flex; align-items:center; min-height:44px;
}
.wordmark--quiet { color:var(--ink-faint); font-size:.9375rem; margin-inline-end:0; }

.nav-desktop { display:none; align-items:center; gap:var(--s5); margin-inline-start:auto; }
.nav-link {
  display:inline-flex; align-items:center;
  min-height:44px; margin-inline:-12px; padding-inline:12px;
  font-size:var(--t-meta); letter-spacing:.02em; color:var(--ink-3);
  border-block-end:1px solid transparent;
  transition:border-color 160ms ease-out,color 160ms ease-out,background-color 160ms ease-out,filter 120ms ease-out;
}
.nav-link:hover { color:var(--ink); border-block-end-color:var(--accent); }
.nav-link[aria-current='page'] { color:var(--ink); border-block-end-color:var(--accent); }

.nav-mobile { position:relative; margin-inline-start:auto; }
.nav-mobile > summary {
  list-style:none; cursor:pointer;
  display:inline-flex; align-items:center; justify-content:center;
  min-height:44px; min-width:44px; padding-inline:12px;
  font-size:var(--t-meta); color:var(--ink-2);
  border:1px solid var(--line-strong); border-radius:2px;
  transition:border-color 160ms ease-out,color 160ms ease-out,background-color 160ms ease-out,filter 120ms ease-out;
}
.nav-mobile > summary::-webkit-details-marker { display:none; }
.nav-mobile[open] > summary { color:var(--ink); border-color:var(--ink-3); }
.nav-panel {
  position:absolute; inset-inline:auto 0; top:calc(100% + 9px); z-index:50;
  min-width:12rem;
  background:var(--card);
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
  font-size:var(--t-meta); color:var(--ink-3);
}
.nav-panel a:last-child { border-block-end:0; }
.nav-panel a[aria-current='page'] { color:var(--ink); }

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
.footer-link { font-size:var(--t-meta); color:var(--ink-faint); display:inline-flex; align-items:center; min-height:44px; }
.footer-link:hover { color:var(--accent-2); }

/* ---------- the theme switch (§11) ---------- */

/* Two plain submit buttons in one form, drawn as the filter row is: a
   micro-caps pair on a hairline, the live one marked by a 1px accent
   underline. No pills, no icon, no emoji, no script — it posts and the page
   comes back rendered in the other theme.

   Which one is live is decided in CSS, by the same three-layer cascade the
   palette uses, so Layout never has to know the current theme. Marking it
   server-side would mean threading the theme through all nineteen Layout call
   sites; this costs six rules and stays correct when the cookie is absent and
   the system preference is doing the deciding. */
.theme-switch { display:inline-flex; align-items:center; gap:var(--s3); margin:0; }
.theme-switch-label { font-size:var(--t-micro); text-transform:uppercase; letter-spacing:.18em; color:var(--ink-faint); }
.theme-btn {
  font:inherit; font-size:var(--t-micro); font-weight:500;
  text-transform:uppercase; letter-spacing:.18em;
  display:inline-flex; align-items:center;
  min-height:44px; padding:0; margin:0;
  background:none; border:0; border-block-end:1px solid transparent;
  color:var(--ink-faint); cursor:pointer;
  transition:border-color 160ms ease-out,color 160ms ease-out,background-color 160ms ease-out,filter 120ms ease-out;
}
.theme-btn:active { filter:brightness(.90); }
/* Layer 1: no cookie, no dark system preference — light is live. */
.theme-btn[value='light'] { color:var(--ink); border-block-end-color:var(--accent); }
/* Layer 2: the system preference, while no explicit choice overrides it. */
@media (prefers-color-scheme:dark) {
  :root:not([data-theme='light']) .theme-btn[value='light'] { color:var(--ink-faint); border-block-end-color:transparent; }
  :root:not([data-theme='light']) .theme-btn[value='dark'] { color:var(--ink); border-block-end-color:var(--accent); }
}
/* Layer 3: the explicit choice, which wins in both directions. */
:root[data-theme='dark'] .theme-btn[value='light'] { color:var(--ink-faint); border-block-end-color:transparent; }
:root[data-theme='dark'] .theme-btn[value='dark'] { color:var(--ink); border-block-end-color:var(--accent); }
:root[data-theme='light'] .theme-btn[value='light'] { color:var(--ink); border-block-end-color:var(--accent); }
:root[data-theme='light'] .theme-btn[value='dark'] { color:var(--ink-faint); border-block-end-color:transparent; }
/* Last, and specific enough to beat every state rule above, or hovering the
   inactive label would do nothing in three of the four combinations. */
:root .theme-btn[value]:hover { color:var(--ink); }

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
  min-height:44px; font-size:var(--t-meta); color:var(--ink-2);
  border-block-end:1px solid transparent; white-space:nowrap;
  transition:border-color 160ms ease-out,color 160ms ease-out,background-color 160ms ease-out,filter 120ms ease-out;
}
.section-action:hover { color:var(--ink); border-block-end-color:var(--accent); }

.rule { border-block-start:1px solid var(--line); margin-block:var(--band); }

/* ---------- the plate — now the FALLBACK, not the hero (§11) ---------- */

/* §1 built the plate to answer "how do we look expensive with zero
   photography". There are photographs now, so the plate is what a record
   without one falls back to. Every layer is driven from a token, so the same
   five layers render as brass-on-lit-black in the dark theme and as
   ink-on-toned-paper in the light one. */
.plate {
  position:relative;
  container-type:inline-size;
  overflow:hidden;
  isolation:isolate;
  background:radial-gradient(120% 90% at var(--ox,28%) 14%,var(--plate-1),var(--plate-2) 58%,var(--plate-3));
  box-shadow:var(--plate-inset);
}
/* Layer 2 — category wash. Flat colour, never a hashed hue.
   §10.5 measured this on near-black: soft-light at .09 gives 1 RGB level of
   separation — the tint is not subtle, it is absent — and screen at .14 lifts
   12 and spreads 6. Screen cannot darken paper, so the light theme flips the
   blend to multiply, measured the same way: 28 levels down, spread 6. Same
   band, opposite direction. */
.plate::before {
  content:""; position:absolute; inset:0;
  background:var(--wash,transparent);
  opacity:var(--wash-alpha); mix-blend-mode:var(--wash-blend);
  pointer-events:none;
}
/* Layer 4 — the engraving. The stroke colour rides --accent from the SVG; the
   opacity lives here because paper needs a firmer line than lit black does. */
.plate .plate-engraving { position:absolute; inset:0; width:100%; height:100%; }
.plate .plate-engraving path { opacity:var(--engrave-opacity); }
/* Layer 3 — monogram deboss. The plate's subject. Debossed either way: on ink
   the highlight is above and the shadow below, on paper it is the reverse. */
.plate-mono {
  position:absolute; inset:0;
  display:flex; align-items:center; justify-content:center;
  font-family:var(--display);
  font-variation-settings:'SOFT' 0,'WONK' 0,'opsz' 144;
  font-size:44cqw; line-height:1; letter-spacing:-.02em;
  color:var(--plate-mono-fill);
  -webkit-text-stroke:.5px var(--plate-mono-stroke);
  text-shadow:var(--plate-emboss);
  user-select:none;
}
/* Gatherings get a chart rule instead of a monogram — instrumentation, not
   decoration. Two repeating gradients: an 8px tick, and every fifth taller. */
.plate-rule {
  position:absolute; inset-inline:0; bottom:14%; height:16%;
  background-image:
    repeating-linear-gradient(90deg,var(--accent-hair) 0 1px,transparent 1px 40px),
    repeating-linear-gradient(90deg,var(--line-mid) 0 1px,transparent 1px 8px);
  background-size:100% 100%,100% 52%;
  background-position:0 100%,0 100%;
  background-repeat:no-repeat;
}
/* 4/3 of a full-bleed phone card is most of the screen. A cover is a glance,
   not a page. */
.plate--card { aspect-ratio:16/10; }
.plate--square { aspect-ratio:1/1; }
.plate--hero { aspect-ratio:4/3; }
@media (min-width:768px) {
  .plate--card { aspect-ratio:3/2; }
  .plate--hero { aspect-ratio:21/9; }
}
/* ---------- the photograph — the primary visual (§11) ---------- */

.plate-photo { width:100%; height:100%; object-fit:cover; }
/* A photograph gets no generated ground, so .plate--photo replaces the
   plate's radial with the raised surface: a pale sky or a white tablecloth
   otherwise bleeds straight into the paper and the card loses its top edge.
   The treatment is a hairline plus a whisper of vignette, drawn in an overlay
   because an inset shadow on the wrapper paints *under* the image. Not
   glassmorphism: no blur, no translucency over content, no elevation. */
.plate--photo { background:var(--paper-2); }
.plate--photo::after {
  content:""; position:absolute; inset:0; z-index:1;
  box-shadow:inset 0 0 0 1px var(--photo-edge), var(--photo-vignette);
  pointer-events:none;
}
/* The circle and gathering heroes pull their h1 up over the cover's lower edge
   (§5, margin-top:-.4em). Against a generated plate that was safe, because the
   ground was ours. Against a photograph it is not, and it fails in BOTH
   themes: measured on /events/first-light-plunge at 1280, the 22px the title
   overlaps contains pixels from luminance 0.00 to 0.91, so ink-on-photo comes
   out at 1.13:1 and ivory-on-photo at 1.05:1 where large text needs 3:1.

   So the foot of a hero photograph fades to the page colour, opaque across the
   whole overlap and tapering above it. That removes the failure by
   construction instead of hoping no photograph is dark at the bottom. Only the
   hero: a card's title sits below its cover and never crosses it. */
.plate--hero.plate--photo::after {
  background:linear-gradient(to top,var(--photo-foot) 0,var(--photo-foot) 26px,transparent min(20%,104px));
}

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
  background:var(--card);
  transition:background-color 160ms ease-out;
}
.grid:not(.grid--hair) > .card { border:1px solid var(--line); border-radius:2px; }
.card:hover { background:var(--paper-2); }
.card-body { display:flex; flex-direction:column; gap:var(--s2); padding:20px; flex:1 1 auto; }
.card-title { margin-block-start:var(--s1); }
/* Whole-card link — never an <a> inside an <a> (§10.4). Any block that wants
   the same behaviour marks itself .linkbox and its heading .linkbox-title. */
.linkbox { position:relative; }
.card-title a::after,.linkbox-title a::after { content:""; position:absolute; inset:0; }
.card .secondary,.linkbox .secondary { position:relative; z-index:2; }
.card-text { color:var(--ink-3); font-size:var(--t-meta); line-height:1.55; }
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
.btn--primary { background:var(--ink); color:var(--paper); }
.btn--primary:hover { background:var(--ink-2); color:var(--paper); }
.btn--ghost { background:transparent; color:var(--ink); border-color:var(--line-strong); }
.btn--ghost:hover { color:var(--ink); border-color:var(--ink-3); background:var(--paper-2); }
.hero .lede, .hero-lede { margin-block-start:12px; }

.btn--quiet {
  min-height:48px;
  min-height:44px; padding:0; border:0; background:none; color:var(--ink-2);
  border-block-end:1px solid var(--accent-hair); border-radius:0;
}
.btn--quiet:hover { color:var(--accent-2); border-block-end-color:var(--accent); }
.btn--block { width:100%; }
/* These two ship together or neither ships (§10.4). */
.btn:active { filter:brightness(.90); }
.btn[disabled],.btn[aria-disabled='true'] {
  color:var(--ink-faint); background:transparent;
  border-color:var(--line-strong); cursor:not-allowed;
}
.btn[disabled]:active { filter:none; }

/* ---------- status text (never a coloured chip, §5/§7) ---------- */

.status {
  font-size:var(--t-micro); line-height:1; font-weight:500;
  text-transform:uppercase; letter-spacing:.18em;
  color:var(--ink-3); white-space:nowrap;
}
.status--brass { color:var(--accent); }
.status--warn { color:var(--warn); }
.status--rust { color:var(--rust); }
.status--slate { color:var(--slate); }

/* ---------- filters (§5: hairline row, accent underline, never pills) ---------- */

.filters { display:flex; flex-wrap:wrap; gap:0 var(--s5); border-block-end:1px solid var(--line); }
.filter {
  display:inline-flex; align-items:center; min-height:48px;
  font-size:var(--t-micro); font-weight:500; text-transform:uppercase; letter-spacing:.18em;
  color:var(--ink-faint);
  border-block-end:1px solid transparent; margin-block-end:-1px;
  transition:border-color 160ms ease-out,color 160ms ease-out,background-color 160ms ease-out,filter 120ms ease-out;
}
.filter:hover { color:var(--ink-2); }
.filter[aria-current='page'] { color:var(--ink); border-block-end-color:var(--accent); }

/* The tally beside a country or a city. A numeral in the machine face is
   permitted accent (§2); the row it sits in is still hairline and still not a
   pill. .18em is the label's tracking and it makes two digits read as two
   words, so the numeral takes the index numeral's .08em instead. */
.filter-count {
  margin-inline-start:6px;
  font-family:var(--mono); font-weight:500; font-size:var(--t-micro);
  letter-spacing:.08em; color:var(--ink-faint);
}
.filter:hover .filter-count { color:var(--ink-3); }
.filter[aria-current='page'] .filter-count { color:var(--accent); }

/* Three rows (country, city, category) stack, each named, so the reader can
   tell which axis they are on without reading the values. */
.filter-stack { display:grid; gap:var(--s5); margin-block-end:var(--s6); }
.filter-group { display:grid; gap:var(--s2); }
.filter-legend { color:var(--ink-faint); }

/* ---------- search (one field, in the page body) ---------- */

.searchbar { display:flex; flex-wrap:wrap; align-items:flex-end; gap:var(--s4); max-width:var(--measure); }
/* The rounded inset WebKit gives a search field ignores min-height, so the
   48px touch target needs the native appearance off. The clear button goes
   with it, which suits a product whose one rule is edges, not chrome (§2). */
.searchbar-input { -webkit-appearance:none; appearance:none; flex:1 1 240px; min-width:0; }
.searchbar-input::-webkit-search-decoration { -webkit-appearance:none; }
.searchbar .btn { flex:none; }
.searchbar-hint { flex:1 0 100%; color:var(--ink-faint); }

/* ---------- geography (the country index and the place pages) ---------- */

/* A printed index, not tiles: shared hairlines, opaque rows, square corners. */
.geo-index { display:grid; gap:1px; }
.geo-index > * { min-width:0; box-shadow:0 0 0 1px var(--line); }
.geo-row {
  display:grid; gap:var(--s4); align-items:start;
  padding:var(--s5); background:var(--card);
  transition:background-color 160ms ease-out;
}
.geo-row:hover { background:var(--paper-2); }
.geo-main { min-width:0; display:grid; gap:var(--s2); }
.geo-cities {
  display:flex; flex-wrap:wrap; align-items:center;
  font-size:var(--t-meta); line-height:1.4; color:var(--ink-3);
}
.geo-cities a { border-block-end:1px solid transparent; }
.geo-cities a:hover { color:var(--ink); border-block-end-color:var(--accent); }
.geo-counts { display:flex; flex-wrap:wrap; gap:var(--s3) var(--s6); }
.geo-counts > div { min-width:0; }
.geo-counts dd { margin-block-start:var(--s1); font-size:var(--t-lede); line-height:1; color:var(--ink); }
.geo-up {
  display:inline-flex; align-items:center; min-height:44px;
  color:var(--ink-3); border-block-end:1px solid var(--accent-hair);
}
/* A group on the search page that matched nothing, beside groups that did.
   One rule and one quiet line — a full empty state outweighed the results. */
.group-empty { color:var(--ink-faint); border-block-start:1px solid var(--line); padding-block-start:var(--s4); }
.geo-up:hover { color:var(--ink); border-block-end-color:var(--accent); }
@media (min-width:720px) {
  .geo-row { grid-template-columns:minmax(0,1fr) auto; align-items:center; }
  .geo-counts { justify-content:flex-end; }
}

/* ---------- fields (§5 Join: bare ink, a rule under each input) ---------- */

.field { display:block; }
.field + .field { margin-block-start:var(--s5); }
.field-label { display:block; margin-block-end:var(--s2); color:var(--ink-3); font-size:var(--t-meta); }
.field-req { color:var(--accent); }
/* Radios and checkboxes are excluded on purpose. They used to be swept up by
   this rule, and background:transparent plus border:0 on a native radio makes
   Chrome paint an UNCHECKED control as a solid disc. On near-black that read
   as a dark ring and passed unnoticed; on paper all five category radios read
   as selected at once. Measured on /host: every input reported checked=false
   while every one of them rendered filled. They are left native below. */
input:not([type='radio']):not([type='checkbox']),select,textarea {
  /* Under 16px iOS zooms on focus and pans sideways, breaking the overflow
     gate in a way desktop never catches (§10.4). */
  font-size:max(16px,1rem);
  font-family:var(--ui);
  color:var(--ink);
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
input::placeholder,textarea::placeholder { color:var(--ink-faint); }
input:not([type='radio']):not([type='checkbox']):hover,select:hover,textarea:hover { border-block-end-color:var(--ink-3); }
/* Left native, so checked and unchecked are told apart by the platform. The
   fill is the accent, which is where a small filled mark is permitted. */
input[type='radio'],input[type='checkbox'] {
  accent-color:var(--accent);
  inline-size:18px; block-size:18px;
  margin:0; flex:none;
}
input[aria-invalid='true'],textarea[aria-invalid='true'],select[aria-invalid='true'] { border-block-end-color:var(--rust); }
.field-hint { display:block; margin-block-start:var(--s2); font-size:var(--t-meta); color:var(--ink-faint); }
.field-error { display:block; margin-block-start:var(--s2); font-size:var(--t-meta); color:var(--rust); }
.field-code input { font-family:var(--mono); letter-spacing:.14em; text-transform:uppercase; }
.invitation {
  font-family:var(--display); font-variation-settings:'SOFT' 0,'WONK' 0,'opsz' 144;
  font-style:italic; font-size:var(--t-lede); color:var(--ink-2); line-height:1.45;
}
.column-420 { width:100%; max-width:420px; }

fieldset[disabled] input { color:var(--ink-3); border-block-end-style:dashed; }

/* ---------- alert (§10.4 confirmation banner) ---------- */

.alert {
  border-inline-start:1px solid var(--line-strong);
  padding:var(--s3) var(--s4);
  font-size:var(--t-meta); color:var(--ink-2);
  background:var(--card);
}
.alert--brass { border-inline-start-color:var(--accent); color:var(--ink); }
.alert--warn { border-inline-start-color:var(--warn); color:var(--ink); }
.alert--rust { border-inline-start-color:var(--rust); color:var(--ink); }
.alert--confirm { animation:banner 240ms cubic-bezier(.2,0,0,1) 1; }
@keyframes banner { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }

/* ---------- empty state (fact + next action, no illustration) ---------- */

.empty { border-block:1px solid var(--line); padding-block:var(--s7); max-width:var(--measure); }
.empty-note { margin-block-start:var(--s3); color:var(--ink-3); font-size:var(--t-meta); }
.empty-action { margin-block-start:var(--s5); }

/* ---------- stat, avatar ---------- */

.stat { display:flex; flex-direction:column; gap:var(--s2); min-width:0; }
.stat-value { font-family:var(--mono); font-size:var(--t-sec); line-height:1; letter-spacing:-.01em; color:var(--ink); }
.stat--brass .stat-value { color:var(--accent); }

/* No coloured avatars, and no radius over 4px — so: a hairline square. */
.avatar {
  flex:none;
  display:inline-flex; align-items:center; justify-content:center;
  width:36px; height:36px;
  border:1px solid var(--line-strong); border-radius:2px;
  background:var(--card);
  font-family:var(--display); font-variation-settings:'SOFT' 0,'WONK' 0,'opsz' 144;
  font-size:.75rem; letter-spacing:.02em; line-height:1; color:var(--ink-2);
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
.gallery-caption { display:block; margin-block-start:var(--s3); padding-inline:var(--s3) 0; font-size:var(--t-meta); color:var(--ink-3); }
@media (min-width:900px) { .gallery-item { width:340px; } }

/* ---------- member and attendee lists (contract §B, §C) ---------- */

.people { display:grid; gap:1px; grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr)); }
.people > * { min-width:0; box-shadow:0 0 0 1px var(--line); }
.person { display:flex; align-items:flex-start; gap:var(--s3); padding:var(--s4); background:var(--card); height:100%; }
.person .plate { flex:none; width:44px; height:44px; }
.person-body { min-width:0; }
.person-name { font-size:var(--t-body); color:var(--ink); }
.person-line { font-size:var(--t-meta); color:var(--ink-3); }
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
.ledger-row:hover { background:var(--card); }
.ledger-date { font-family:var(--mono); font-size:var(--t-meta); line-height:1.45; color:var(--ink-faint); }
.ledger-date b,.ledger-date span { display:block; }
.ledger-date b { font-weight:500; color:var(--ink); }
.ledger-date span:last-child { color:var(--ink-3); }
.ledger-thumb { width:64px; height:64px; }
.ledger-title { font-family:var(--display); font-variation-settings:'SOFT' 0,'WONK' 0,'opsz' 144; font-size:var(--t-body); font-weight:400; color:var(--ink); }
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
.cal-day-row.is-today .cal-day-label { color:var(--accent); }
.cal-day-label { font-family:var(--mono); font-size:var(--t-meta); color:var(--ink-faint); }
.cal-day-label span { display:block; }
.cal-day-label .num { font-size:var(--t-lede); line-height:1.1; color:var(--ink); }
.cal-day-row.is-today .cal-day-label .num { color:var(--accent); }
.cal-entry { display:grid; grid-template-columns:auto minmax(0,1fr); column-gap:8px;
  align-items:baseline; min-height:32px; }
/* The body-level overflow-wrap:anywhere backstop (§10.4) is right for long
   venue names and emails, but it also breaks a time across lines as
   "06:" / "40". A clock time, a price and a ticket code are atomic. */
.cal-entry .num, .num, .mono, .ledger-date, .price { overflow-wrap:normal; word-break:normal; }
.cal-entry .num { white-space:nowrap; }
.cal-entry .num { color:var(--accent); font-size:var(--t-meta); }
.cal-entry-title { font-size:var(--t-meta); color:var(--ink-2); }
.cal-entry a:hover { color:var(--ink); }
.cal-empty { font-size:var(--t-meta); color:var(--ink-faint); }
.cal-more { font-size:var(--t-micro); text-transform:uppercase; letter-spacing:.18em; color:var(--ink-faint); }

@media (min-width:900px) {
  .cal-list { display:none; }
  .cal-dow { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:1px; margin-block-end:1px; }
  .cal-dow > * { padding:var(--s2) var(--s3); min-width:0; }
  .cal-grid { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:1px; }
  .cal-grid > * { min-width:0; box-shadow:0 0 0 1px var(--line); }
  .cal-cell { min-height:118px; padding:var(--s3); background:var(--card); display:flex; flex-direction:column; gap:var(--s1); }
  .cal-cell.is-outside { background:var(--paper); }
  .cal-cell.is-outside .cal-num { color:var(--ink-faint); }
  /* Today is a 1px accent rule, never a filled block. */
  .cal-cell.is-today { box-shadow:0 0 0 1px var(--line), inset 0 1px 0 var(--accent); }
  .cal-num { font-family:var(--mono); font-size:var(--t-meta); color:var(--ink-3); }
  .cal-cell.is-today .cal-num { color:var(--accent); }
  .cal-cell .cal-entry { min-height:0; display:block; }
  .cal-cell .cal-entry .num { margin-inline-end:var(--s1); }
}

/* ---------- pass table (§5: one bordered table, not three cards) ---------- */

.pass-table { width:100%; min-width:19rem; border-collapse:collapse; text-align:left; }
.pass-table th,.pass-table td { padding:var(--s4) var(--s3); border-block-end:1px solid var(--line); vertical-align:top; }
.pass-table thead th {
  padding-block:var(--s3); font-size:var(--t-micro); font-weight:500;
  text-transform:uppercase; letter-spacing:.18em; color:var(--ink-faint);
}
.pass-table tbody tr:last-child th,.pass-table tbody tr:last-child td { border-block-end:0; }
.pass-table th:first-child,.pass-table td:first-child { padding-inline-start:var(--s4); }
.pass-table th:last-child,.pass-table td:last-child { padding-inline-end:var(--s4); text-align:right; }
.pass-name {
  font-family:var(--display); font-variation-settings:'SOFT' 0,'WONK' 0,'opsz' 144;
  font-size:var(--t-card); font-weight:400; color:var(--ink);
}
.pass-price { font-family:var(--mono); font-weight:500; color:var(--accent); white-space:nowrap; }
.pass-derivation { display:block; margin-block-start:var(--s1); font-size:var(--t-meta); color:var(--ink-faint); }
.bordered { border:1px solid var(--line); border-radius:2px; background:var(--card); }

/* ---------- pass cards (account, where a table would be overkill) ---------- */

.pass-grid { display:grid; gap:1px; grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr)); }
.pass-grid > * { min-width:0; box-shadow:0 0 0 1px var(--line); }
.pass-card { background:var(--card); padding:var(--s5); display:flex; flex-direction:column; gap:var(--s2); height:100%; }
.pass-card-price { font-family:var(--mono); font-weight:500; font-size:var(--t-card); color:var(--accent); }

/* ---------- credits: N hairline squares, filled = spent (§5) ---------- */

.credits { display:flex; flex-wrap:wrap; gap:6px; }
.credit-sq { width:16px; height:16px; border:1px solid var(--line-strong); border-radius:1px; }
.credit-sq.is-spent { background:var(--ink-3); border-color:var(--ink-3); }

/* ---------- action area (the contract's seven states) ---------- */

.action { display:flex; flex-direction:column; gap:var(--s3); }
.action-kicker { font-size:var(--t-meta); color:var(--ink-3); }
.action-kicker a { color:var(--ink-2); border-block-end:1px solid var(--accent-hair); }
.action-kicker a:hover { color:var(--accent-2); }
.action-line { font-family:var(--mono); font-size:var(--t-meta); color:var(--ink-2); }
.action-help { font-size:var(--t-meta); color:var(--ink-3); }
.action-help a { border-block-end:1px solid var(--accent-hair); }
.action-help a:hover { color:var(--accent-2); }
.action-passes { display:grid; gap:var(--s2); }
.action-heading { font-size:var(--t-meta); color:var(--ink); }
.action-stub {
  display:flex; align-items:center; justify-content:space-between; gap:var(--s3);
  min-height:48px; padding:0 var(--s4);
  border:1px solid var(--accent-hair); border-radius:2px;
  color:var(--ink);
  transition:border-color 160ms ease-out,color 160ms ease-out,background-color 160ms ease-out,filter 120ms ease-out;
}
.action-stub:hover { border-color:var(--accent); background:var(--card); }
.action-stub .num { color:var(--accent); letter-spacing:.1em; }
.action-sidebar { position:sticky; top:calc(var(--header-h) + 24px); }
/* The one large accent number in the product (§5). */
.places-left { font-family:var(--mono); font-weight:500; font-size:var(--t-sec); line-height:1; color:var(--accent); }

/* ---------- action bar (§10.1: opaque, never glass) ---------- */

.actionbar {
  position:fixed; inset-inline:0; bottom:0; z-index:45;
  display:flex; align-items:center; gap:var(--s3);
  min-height:52px;
  background:var(--card);
  border-block-start:1px solid var(--line-strong);
  box-shadow:var(--shadow-bar);
  padding-block:var(--s2);
  padding-block-end:calc(var(--s2) + env(safe-area-inset-bottom,0px));
  padding-inline-start:calc(var(--pad) + env(safe-area-inset-left,0px));
  padding-inline-end:calc(var(--pad) + env(safe-area-inset-right,0px));
}
.actionbar-text { min-width:0; flex:1 1 auto; }
.actionbar-title { font-size:var(--t-meta); color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.actionbar-note { font-family:var(--mono); font-size:var(--t-micro); color:var(--ink-3); }
.actionbar .btn { flex:none; }
@media (min-width:900px) { .actionbar { display:none; } }

/* ---------- ticket (§5) ---------- */

.ticket {
  position:relative;
  border:1px solid var(--accent-hair);
  border-radius:2px;
  background:radial-gradient(120% 90% at var(--ox,28%) 14%,var(--plate-1),var(--plate-2) 58%,var(--plate-3));
  box-shadow:var(--plate-inset);
  padding:var(--s6) var(--s5) var(--s6) var(--s7);
  overflow:hidden;
}
/* Double rule: the border above, plus a 1px inset at 4px. */
.ticket::before {
  content:""; position:absolute; inset:4px;
  border:1px solid var(--accent-hair); border-radius:1px; pointer-events:none;
}
/* Perforation down one edge. */
.ticket::after {
  content:""; position:absolute; inset-block:0; inset-inline-start:20px; width:1px;
  background-image:repeating-linear-gradient(180deg,var(--accent-hair) 0 4px,transparent 4px 10px);
  pointer-events:none;
}
.ticket-code {
  font-family:var(--mono); font-weight:500; font-size:var(--t-code);
  line-height:1; letter-spacing:.12em; color:var(--ink); overflow-wrap:anywhere;
}
.ticket-grid { display:grid; gap:var(--s4) var(--s6); grid-template-columns:repeat(auto-fill,minmax(min(190px,100%),1fr)); margin-block-start:var(--s6); }
.ticket-grid > * { min-width:0; }
.ticket-dd { color:var(--ink-2); font-size:var(--t-meta); margin-block-start:var(--s1); }
.ticket-seal { position:absolute; top:var(--s5); right:var(--s5); width:72px; height:72px; color:var(--accent); opacity:.55; }
@media (max-width:559px) { .ticket-seal { display:none; } }

/* ---------- checkout (contract §E) ---------- */

.checkout { display:grid; gap:var(--s5); max-width:520px; }
.checkout-lines { border-block:1px solid var(--line); }
.checkout-line { display:flex; align-items:baseline; gap:var(--s4); padding-block:var(--s3); border-block-end:1px solid var(--line); }
.checkout-line:last-child { border-block-end:0; }
.checkout-line dt { color:var(--ink-3); font-size:var(--t-meta); }
.checkout-line dd { margin-inline-start:auto; text-align:right; color:var(--ink-2); }
.checkout-card { border:1px solid var(--line); border-radius:2px; padding:var(--s4); background:var(--card); }
.checkout-demo { color:var(--slate); font-size:var(--t-meta); }
.card-digits { font-family:var(--mono); letter-spacing:.14em; color:var(--ink-2); }

/* ---------- definition list (when/where, §5) ---------- */

.deflist { display:grid; gap:var(--s5); grid-template-columns:repeat(auto-fill,minmax(min(190px,100%),1fr)); }
.deflist > div { min-width:0; }
.deflist dd { margin-block-start:var(--s2); color:var(--ink-2); }

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
.nav-mobile-actions { display:flex; align-items:center; gap:8px; margin-inline-start:auto; }
.btn--compact { min-height:40px; padding-inline:14px; font-size:var(--t-meta); }
@media (min-width:900px) { .nav-mobile-actions { display:none; } }

.nav-signout { display:inline-flex; margin:0; }
.nav-link--plain { background:none; border:0; padding:0; margin:0; cursor:pointer;
  /* font:inherit also resets font-size, so Sign out rendered at body size
     next to nav links at --t-meta. Inherit the family, keep the nav size. */
  font-family:inherit; font-size:var(--t-meta); line-height:inherit; color:var(--ink-3); min-height:44px; display:inline-flex; align-items:center; }
.nav-link--plain:hover { color:var(--accent-2); }
.nav-panel .nav-link--plain { min-height:48px; width:100%; }

/* The action area must exist at every width. Hiding it below 900px left the
   sticky bar pointing at #reserve — an element that was not rendered — so the
   whole purchase flow was unreachable on a phone. On mobile it sits in the page
   flow; the fixed bar is a shortcut to it, not a replacement for it. */
.action-sidebar { display:block; margin-block-start:var(--s6); }
@media (min-width:900px) { .action-sidebar { margin-block-start:0; } }
`;
