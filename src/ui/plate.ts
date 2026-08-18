/**
 * The plate — 2CC's generated cover art.
 *
 * Replaces the old gradient cover, which `design/reference/design-decisions.md`
 * §1 bans outright. A plate is five layers, bottom to top:
 *
 *   1. Ground — a *lit* black radial, offset by `--ox`.
 *   2. Category wash — one flat colour at `opacity:.09; mix-blend-mode:soft-light`.
 *      **Category picks the wash. The hue is never hashed** — randomised hues are
 *      what make six covers in a grid read as a broken-image set.
 *   3. Monogram deboss — the plate's subject, so it can never read as a missing image.
 *   4. Guilloché — a server-computed epitrochoid, one `<path>`, hairline and dense.
 *   5. Light — an inset top edge and a bottom vignette.
 *
 * Layers 1, 2, 3 and 5 are CSS (see `theme.ts`); this file computes the two
 * things CSS cannot: the deterministic parameters and layer 4's path data.
 *
 * Everything here is pure. No DOM, no clock, no `Math.random` — the same slug
 * produces the same plate on this machine and on the deployed Worker.
 */

/** The five categories that own a wash. Anything else renders washless. */
export type PlateCategory = "sailing" | "wellness" | "dining" | "sport" | "art";

/**
 * The category wash (§1, layer 2). On near-black at 9% soft-light these become
 * tints you cannot name, which is the point: a nameable colour looks cheap.
 */
export function washFor(category: string): string | null {
  switch (category.trim().toLowerCase()) {
    case "sailing":
      return "#2E4A5A";
    case "wellness":
      return "#3A4A3E";
    case "dining":
      return "#5A3A32";
    case "sport":
      return "#3B3B44";
    case "art":
      return "#4A3A52";
    default:
      return null;
  }
}

/** FNV-1a, 32-bit, unsigned. Small, fast and stable across runtimes. */
export function fnv1a(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type PlateParams = {
  /** The raw FNV-1a hash, exposed so callers can derive their own extras. */
  hash: number;
  /** Lobe driver. The curve has `p + 1` lobes. 3–7. */
  p: number;
  /** Ripple depth, in the curve's own units. .28–.475. */
  hAmp: number;
  /** Whole-plate rotation, degrees. 0–359. */
  rotate: number;
  /** Ground-gradient origin, percent. 18–41. */
  ox: number;
};

/**
 * The four parameters, derived from `FNV-1a(slug)` exactly as §1 states.
 *
 * Shifts use `>>>` rather than `>>`: the hash is unsigned 32-bit, and an
 * arithmetic shift would sign-extend every seed whose top bit is set.
 */
export function plateParams(seed: string): PlateParams {
  const h = fnv1a(seed);
  return {
    hash: h,
    p: 3 + (h % 5),
    // Rounded to 3dp so the memo key below is a stable string, not a float tail.
    hAmp: Math.round((0.28 + ((h >>> 8) % 40) / 200) * 1000) / 1000,
    rotate: (h >>> 12) % 360,
    ox: 18 + ((h >>> 16) % 24),
  };
}

/**
 * The ground and wash, as custom properties for the `style` attribute.
 * `theme.ts` turns them into the actual gradient and blended overlay.
 */
export function plateStyle(seed: string, category = ""): string {
  const wash = washFor(category);
  const ox = `--ox:${plateParams(seed).ox}%`;
  return wash === null ? ox : `${ox};--wash:${wash}`;
}

/**
 * §1's payload budget: grids get 320 samples / 2 passes, a detail hero gets
 * 900 / 4. `thumb` is the same engine at 96/1, for the 64px ledger squares §1
 * never had to cost — at that size 320 samples resolve to well under a device
 * pixel each, so the extra 5KB per row buys nothing you can see.
 */
export type PlateDensity = "thumb" | "grid" | "hero";

export type PlateSvgOptions = {
  density?: PlateDensity;
  /** Sample points per turn. Defaults to `SAMPLES_PER_LOBE × (p+1)`. */
  samples?: number;
  /** Rotated copies, 3° apart, for intaglio moiré. Overrides the preset. */
  passes?: number;
  /** Turns in the spiral. Overrides the preset. */
  turns?: number;
};

const TAU = Math.PI * 2;

/** Degrees between successive passes (§1: "drawn 4× rotated 3° apart"). */
const PASS_STEP_DEG = 3;

/**
 * Turns per pass, and the innermost radius as a fraction of the outermost.
 *
 * §1's formula with §1's `h` is a *curtate* epitrochoid: with `h` between .28
 * and .475 against a radius of 4–8, the ripple is 6% of the radius, so one
 * revolution draws a gently rippled circle. Rendered and looked at, two of
 * those 3° apart read as a single stray outline — hairline, but sparse, which
 * is the exact failure §1 bans ("hairline and dense, never thick and sparse").
 *
 * The fix keeps §1's formula, §1's four hashed parameters and §1's payload
 * untouched, and changes only the thing §1 left open: how far `t` runs. Each
 * pass now winds `turns` times while the radius steps down to `INNER`, which
 * is what a rose engine physically does — the work rotates while the cutter
 * advances. The lobes stay phase-locked turn to turn, so the nested rings line
 * up into radial spokes, and that is the engraving.
 */
const TURNS: Record<PlateDensity, number> = { thumb: 4, grid: 8, hero: 14 };
const INNER = 0.3;

/**
 * Samples per lobe cycle, per density. Sampling has to scale with the lobe
 * count or a p=7 plate facets where a p=3 plate does not. Eight per cycle
 * leaves a polygonal error of 7.6% of the ripple amplitude — about 0.2 viewBox
 * units, well under a device pixel at every size a plate is drawn at — which
 * is what pays for the extra turns without moving the payload.
 */
const SAMPLES_PER_LOBE: Record<PlateDensity, number> = { thumb: 6, grid: 8, hero: 11 };

/**
 * The curve is drawn into a 0–100 viewBox with this outer radius, so every
 * plate in a grid carries a rosette of the same diameter. Only the lobe count,
 * ripple depth and rotation vary — which is what makes six plates read as a
 * series rather than as six unrelated drawings.
 */
const VIEW_RADIUS = 44;

/**
 * Path strings memoised by `(p, hAmp, …)` (§1). The key space is bounded —
 * 5 lobe values × 40 amplitudes × 3 density presets — so this can never grow
 * past a few hundred entries and needs no eviction.
 */
const PATHS = new Map<string, string>();

/** One decimal place, no trailing `.0`, no `-0`. §1's payload rule. */
function r1(v: number): string {
  const n = Math.round(v * 10) / 10;
  return n === 0 ? "0" : String(n);
}

/**
 * `x = (p+1)·cos t − h·cos((p+1)t)`, `y = (p+1)·sin t − h·sin((p+1)t)`.
 *
 * Emitted as a single `d` string holding every pass as a subpath, so the whole
 * engraving is one `<path>` element. Pass rotation is baked into the
 * coordinates (it is the same 0/3/6/9° for every plate, so the string stays
 * memoisable); the per-plate rotation is a `transform` on the element.
 *
 * Points after the leading `M` are implicit line-tos — the shortest legal
 * encoding, and worth about 25% of the payload at these sample counts.
 */
function guillochePath(
  p: number,
  hAmp: number,
  perTurn: number,
  turns: number,
  passes: number,
): string {
  const key = `${p}:${hAmp}:${perTurn}:${turns}:${passes}`;
  const memo = PATHS.get(key);
  if (memo !== undefined) return memo;

  const lobes = p + 1;
  const outer = VIEW_RADIUS / (lobes + hAmp);
  const total = perTurn * turns;
  let d = "";

  for (let pass = 0; pass < passes; pass++) {
    const a = (pass * PASS_STEP_DEG * Math.PI) / 180;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (let i = 0; i <= total; i++) {
      const t = (i / perTurn) * TAU;
      const scale = outer * (1 - (i / total) * (1 - INNER));
      const x = lobes * Math.cos(t) - hAmp * Math.cos(lobes * t);
      const y = lobes * Math.sin(t) - hAmp * Math.sin(lobes * t);
      d += `${i === 0 ? "M" : " "}${r1((x * ca - y * sa) * scale + 50)},${r1((x * sa + y * ca) * scale + 50)}`;
    }
  }

  PATHS.set(key, d);
  return d;
}

function clampInt(v: number, min: number, max: number): number {
  const n = Math.trunc(v);
  if (!Number.isFinite(n)) return min;
  return n < min ? min : n > max ? max : n;
}

/**
 * Layer 4, as an SVG string ready for `raw()`.
 *
 * Contains no caller-supplied text: the only interpolations are numbers and a
 * category that has already been matched against the five known keys.
 *
 * `vector-effect="non-scaling-stroke"` is what keeps `stroke-width:.5` a
 * hairline. Without it, the 0–100 viewBox scales the stroke up by ~3× on a
 * card and ~9× on a hero, and §1's "hairline and dense" becomes "thick and
 * sparse" — the exact thing it bans.
 */
export function plateSvg(seed: string, category = "", opts: PlateSvgOptions = {}): string {
  const { p, hAmp, rotate } = plateParams(seed);
  const density = opts.density ?? "grid";
  const perTurn = clampInt(opts.samples ?? SAMPLES_PER_LOBE[density] * (p + 1), 12, 400);
  const turns = clampInt(opts.turns ?? TURNS[density], 1, 24);
  const passes = clampInt(opts.passes ?? (density === "hero" ? 4 : density === "thumb" ? 1 : 2), 1, 8);
  const d = guillochePath(p, hAmp, perTurn, turns, passes);
  const cat = washFor(category) === null ? "none" : category.trim().toLowerCase();

  return (
    `<svg class="plate-engraving" data-category="${cat}" viewBox="0 0 100 100"` +
    ` preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">` +
    `<path d="${d}" transform="rotate(${rotate} 50 50)" fill="none" stroke="var(--brass)"` +
    ` stroke-width=".5" stroke-linejoin="round" vector-effect="non-scaling-stroke" opacity=".22"/>` +
    `</svg>`
  );
}

/**
 * Two initials, uppercased — the monogram, and the same letters the member
 * lists use. Falls back to the wordmark rather than to nothing.
 *
 * A one-word name takes its first two letters ("Nightform" → "NI"), not one
 * (§10.5): a lone letter reads thinner than the two-letter monograms beside it
 * in a grid, and the grid is where the plate has to hold its own.
 */
const ARTICLES = new Set(["the", "a", "an", "le", "la", "les", "el", "il"]);

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "2C";

  // Drop a leading article first. Without this "The Cold Room", "The Bica Table"
  // and "The Sunrise Court" all monogram as T-something, and a grid of plates
  // reads as one repeated letter — the opposite of the distinct series the plate
  // exists to create. Only dropped when a word is left behind it.
  const significant =
    words.length > 1 && ARTICLES.has(words[0].toLowerCase()) ? words.slice(1) : words;

  if (significant.length === 1) return significant[0].slice(0, 2).toUpperCase();
  return (significant[0].charAt(0) + significant[significant.length - 1].charAt(0)).toUpperCase();
}
