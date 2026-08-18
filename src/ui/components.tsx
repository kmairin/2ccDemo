/**
 * The 2CC component kit — the pieces pages are assembled from.
 *
 * Every component takes plain, explicitly typed props and renders server-side.
 * Nothing here formats a date or a currency: pass `when` and `price` already
 * formatted (that lives in `src/lib/format.ts`, owned elsewhere), so this file
 * stays a pure view layer. Nothing here imports `src/schema.ts` either — the
 * prop types are narrow and local on purpose.
 *
 * Larger set-pieces live beside this file: `gallery.tsx`, `calendar.tsx`
 * (which also owns the ledger), `people.tsx`, `booking.tsx`.
 */

import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { initials, plateStyle, plateSvg, type PlateDensity } from "./plate";

/** A right-aligned link on a section head, or the action on an empty state. */
export type LinkAction = { href: string; label: string };

/** Status colours. Never a fill, never a chip — §5 and §7. */
export type Tone = "quiet" | "brass" | "warn" | "rust" | "slate";

/* ---------- the plate ---------- */

export type PlateProps = {
  /** The slug. Everything about the plate derives from `FNV-1a(seed)`. */
  seed: string;
  /** sailing | wellness | dining | sport | art. Anything else renders washless. */
  category?: string;
  /** The monogram deboss — the plate's subject, so it never reads as a missing image. */
  monogram?: string;
  /** Gatherings get a chart rule instead of a monogram (§1). */
  rule?: boolean;
  shape?: "card" | "square" | "hero" | "bare";
  density?: PlateDensity;
  /** Set false on plates under ~48px, where a hairline engraving is mush. */
  engraving?: boolean;
  /**
   * An R2 key. When it is set the component renders `<img src="/assets/…">`
   * from the bucket, and that is now the normal case — every circle and every
   * gathering has a photograph. The generated plate below is the fallback for
   * a record that does not.
   */
  objectKey?: string | null;
  /** Only used for a real photograph. Generated plates are decorative. */
  alt?: string;
  className?: string;
};

export function Plate(props: PlateProps) {
  const {
    seed,
    category = "",
    monogram,
    rule,
    shape = "card",
    density = "grid",
    engraving = true,
    objectKey,
    alt,
    className,
  } = props;

  const cls = ["plate", shape === "bare" ? "" : `plate--${shape}`, className ?? ""]
    .filter(Boolean)
    .join(" ");

  if (objectKey !== undefined && objectKey !== null && objectKey !== "") {
    // `plate--photo` drops the generated ground and adds the hairline-plus-
    // vignette overlay: on paper a pale photograph otherwise bleeds into the
    // page and the card loses its edge.
    return (
      <div class={`${cls} plate--photo`}>
        <img class="plate-photo" src={`/assets/${objectKey}`} alt={alt ?? ""} loading="lazy" decoding="async" />
      </div>
    );
  }

  return (
    <div class={cls} style={plateStyle(seed, category)}>
      {engraving ? raw(plateSvg(seed, category, { density })) : null}
      {rule ? <span class="plate-rule" aria-hidden="true" /> : null}
      {monogram ? (
        <span class="plate-mono" aria-hidden="true">
          {monogram}
        </span>
      ) : null}
    </div>
  );
}

/* ---------- layout pieces ---------- */

/** A plain max-width column. Heroes and sections bring their own. */
export function Container(props: { children?: Child }) {
  return <div class="shell">{props.children}</div>;
}

/**
 * Gesture 1 of 2: the rule-and-index. A 24px brass hairline, a mono numeral
 * and a micro-caps label — `— 03 / GATHERINGS`. It opens every section on
 * every screen, and it is half of what carries the brand (§3).
 */
export function SectionIndex(props: { index: string | number; label: string }) {
  const n = typeof props.index === "number" ? String(props.index).padStart(2, "0") : props.index;
  return (
    <p class="index">
      <span class="index-rule" aria-hidden="true" />
      <span class="index-num">{n}</span>
      <span class="index-sep" aria-hidden="true">
        /
      </span>
      <span class="index-label">{props.label}</span>
    </p>
  );
}

export type HeroProps = {
  title: string;
  index?: string | number;
  label?: string;
  lede?: string;
  /** `hero` is the landing statement; `page` is every other `<h1>`. */
  scale?: "hero" | "page";
  children?: Child;
};

/** The page's one `<h1>` — the subject (§10.4). */
export function Hero(props: HeroProps) {
  const { title, index, label, lede, scale = "page", children } = props;
  return (
    <section class="hero">
      <div class="shell">
        <div class="eight">
          {index !== undefined && label !== undefined ? (
            <SectionIndex index={index} label={label} />
          ) : null}
          <h1 class={scale === "hero" ? "h-hero" : "h-page"}>{title}</h1>
          {lede !== undefined ? <p class="lede">{lede}</p> : null}
        </div>
        {children !== undefined ? <div class="hero-actions">{children}</div> : null}
      </div>
    </section>
  );
}

export type SectionProps = {
  title: string;
  index?: string | number;
  label?: string;
  action?: LinkAction;
  /** Drop the `<div class="shell">` when the caller is already inside one. */
  bare?: boolean;
  id?: string;
  children?: Child;
};

export function Section(props: SectionProps) {
  const { title, index, label, action, bare, id, children } = props;
  const head = (
    <>
      <div class="section-head">
        <div class="section-heading">
          {index !== undefined && label !== undefined ? (
            <SectionIndex index={index} label={label} />
          ) : null}
          <h2 class="h-sec">{title}</h2>
        </div>
        {action !== undefined ? (
          <a class="section-action" href={action.href}>
            {action.label}
          </a>
        ) : null}
      </div>
      {children}
    </>
  );
  return (
    <section class="section" id={id}>
      {bare === true ? head : <div class="shell">{head}</div>}
    </section>
  );
}

/**
 * The printed-index grid: one column at 375 (plates full-bleed past the
 * gutters), two at 768, three at 1280, hairlines shared between cells (§4).
 */
export function CardGrid(props: { wide?: boolean; bleed?: boolean; children?: Child }) {
  const cls = [
    "grid",
    "grid--hair",
    props.wide === true ? "grid--wide" : "",
    props.bleed === false ? "" : "grid--bleed",
  ]
    .filter(Boolean)
    .join(" ");
  return <div class={cls}>{props.children}</div>;
}

export function Divider() {
  return <hr class="rule" />;
}

/* ---------- cards ---------- */

export type CircleCardProps = {
  slug: string;
  name: string;
  tagline: string;
  city: string;
  /** sailing | wellness | dining | sport | art. A category is a word, never an icon. */
  category: string;
  memberCount: number;
  isPrivate?: boolean;
  /** A real photograph under design/assets/. Null falls back to the plate. */
  coverKey?: string | null;
};

export function CircleCard(props: CircleCardProps) {
  const { slug, name, tagline, city, category, memberCount, isPrivate, coverKey } = props;
  return (
    <article class="card">
      <Plate seed={slug} category={category} monogram={initials(name)} objectKey={coverKey} alt={name} />
      <div class="card-body">
        <span class="micro micro--brass">{category}</span>
        <h3 class="h-card card-title">
          <a href={`/circles/${slug}`}>{name}</a>
        </h3>
        <p class="card-text">{tagline}</p>
        <div class="card-foot">
          <span class="meta">{city}</span>
          <span class="meta num">{memberCount === 1 ? "1 member" : `${memberCount} members`}</span>
          {isPrivate === true ? <span class="status">By request</span> : null}
        </div>
      </div>
    </article>
  );
}

export type EventCardProps = {
  slug: string;
  title: string;
  circleName: string;
  city: string;
  venue: string;
  /** Already formatted — this component never touches dates. */
  when: string;
  placesLeft: number;
  category?: string;
  /** A real photograph under design/assets/. Null falls back to the plate. */
  coverKey?: string | null;
};

export function EventCard(props: EventCardProps) {
  const { slug, title, circleName, city, venue, when, placesLeft, category, coverKey } = props;
  const full = placesLeft <= 0;
  return (
    <article class="card">
      <Plate seed={slug} category={category ?? ""} rule={true} objectKey={coverKey} alt={title} />
      <div class="card-body">
        <span class="meta num">{when}</span>
        <h3 class="h-card card-title">
          <a href={`/events/${slug}`}>{title}</a>
        </h3>
        <p class="card-text">
          {venue} · {city}
        </p>
        <div class="card-foot">
          <span class="meta">{circleName}</span>
          <Badge tone={full ? "quiet" : placesLeft <= 3 ? "warn" : "brass"}>
            {full ? "Full" : `${placesLeft} left`}
          </Badge>
        </div>
      </div>
    </article>
  );
}

export type PassCardProps = {
  /** Single, Trio or Season. */
  name: string;
  credits: number;
  /** Already formatted, e.g. "€180". Never "€180.00", never "from". */
  price: string;
  /** The derivation: "3 gatherings · €60 each". */
  derivation?: string;
  note?: string;
  children?: Child;
};

/**
 * A pass as a card. The circle page uses `PassTable` instead — §5 is explicit
 * that three pricing cards are the wrong shape there. This is for `/account`,
 * where a pass is a thing you own rather than a thing you are choosing between.
 */
export function PassCard(props: PassCardProps) {
  const { name, credits, price, derivation, note, children } = props;
  return (
    <div class="pass-card">
      <span class="micro">
        {credits} {credits === 1 ? "credit" : "credits"}
      </span>
      <h3 class="pass-name">{name}</h3>
      <p class="pass-card-price">{price}</p>
      {derivation !== undefined ? <p class="meta">{derivation}</p> : null}
      {note !== undefined ? <p class="meta">{note}</p> : null}
      {children}
    </div>
  );
}

export function PassGrid(props: { children?: Child }) {
  return <div class="pass-grid">{props.children}</div>;
}

/* ---------- small pieces ---------- */

export type StatProps = { label: string; value: string | number; tone?: "brass" };

export function Stat(props: StatProps) {
  return (
    <div class={props.tone === "brass" ? "stat stat--brass" : "stat"}>
      <span class="stat-value">{props.value}</span>
      <span class="micro">{props.label}</span>
    </div>
  );
}

/** Status as uppercase micro text. Never a coloured chip, never a pill (§5). */
export function Badge(props: { tone?: Tone; children?: Child }) {
  const tone = props.tone ?? "quiet";
  return <span class={tone === "quiet" ? "status" : `status status--${tone}`}>{props.children}</span>;
}

export type ButtonProps = {
  /** Given an `href`, renders an anchor; otherwise a `<button>`. */
  href?: string;
  type?: "button" | "submit";
  /** One `primary` per screen: ivory fill, ink text (§2). */
  variant?: "primary" | "ghost" | "quiet";
  block?: boolean;
  disabled?: boolean;
  name?: string;
  value?: string;
  ariaLabel?: string;
  children?: Child;
};

export function Button(props: ButtonProps) {
  const { href, type, variant, block, disabled, name, value, ariaLabel, children } = props;
  const cls = `btn btn--${variant ?? "ghost"}${block === true ? " btn--block" : ""}`;
  if (href !== undefined) {
    return (
      <a class={cls} href={href} aria-label={ariaLabel} aria-disabled={disabled === true ? "true" : undefined}>
        {children}
      </a>
    );
  }
  return (
    <button
      class={cls}
      type={type ?? "submit"}
      name={name}
      value={value}
      aria-label={ariaLabel}
      disabled={disabled === true}
    >
      {children}
    </button>
  );
}

export type FieldProps = {
  label: string;
  name: string;
  type?: string;
  value?: string;
  placeholder?: string;
  required?: boolean;
  /** Renders a `<textarea>` instead of an `<input>`. */
  multiline?: boolean;
  rows?: number;
  hint?: string;
  /** Present means the field failed validation: sets `aria-invalid` and describes it. */
  error?: string;
  autocomplete?: string;
  inputmode?: "none" | "text" | "search" | "email" | "numeric" | "decimal" | "tel" | "url";
  enterkeyhint?: "enter" | "done" | "go" | "next" | "previous" | "search" | "send";
  autocapitalize?: "none" | "off" | "on" | "sentences" | "words" | "characters";
  spellcheck?: boolean;
  /** Monospaced, uppercase — for invitation codes. */
  code?: boolean;
};

/**
 * A labelled control on bare ink: `border:0`, one rule underneath (§5 Join).
 * The rule is `--line-strong`, because it is the only thing defining the
 * control and §10.2 measured `--line` at 1.16:1 against SC 1.4.11's 3:1.
 */
export function Field(props: FieldProps) {
  const {
    label,
    name,
    type,
    value,
    placeholder,
    required,
    multiline,
    rows,
    hint,
    error,
    autocomplete,
    inputmode,
    enterkeyhint,
    autocapitalize,
    spellcheck,
    code,
  } = props;

  const id = `f-${name}`;
  const hintId = hint !== undefined ? `${id}-hint` : undefined;
  const errorId = error !== undefined ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;

  return (
    <div class={code === true ? "field field-code" : "field"}>
      <label class="field-label" for={id}>
        {label}
        {required === true ? <span class="field-req"> *</span> : null}
      </label>
      {multiline === true ? (
        <textarea
          id={id}
          name={name}
          rows={rows ?? 5}
          placeholder={placeholder}
          required={required === true}
          aria-invalid={error !== undefined ? "true" : undefined}
          aria-describedby={describedBy}
        >
          {value}
        </textarea>
      ) : (
        <input
          id={id}
          name={name}
          type={type ?? "text"}
          value={value}
          placeholder={placeholder}
          required={required === true}
          autocomplete={autocomplete}
          inputmode={inputmode}
          enterkeyhint={enterkeyhint}
          autocapitalize={autocapitalize}
          spellcheck={spellcheck}
          aria-invalid={error !== undefined ? "true" : undefined}
          aria-describedby={describedBy}
        />
      )}
      {error !== undefined ? (
        <span class="field-error" id={errorId}>
          {error}
        </span>
      ) : null}
      {hint !== undefined ? (
        <span class="field-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export type EmptyStateProps = { title: string; note?: string; action?: LinkAction };

/** Fact plus next action. No apology, no illustration, no exclamation mark (§6). */
export function EmptyState(props: EmptyStateProps) {
  const { title, note, action } = props;
  return (
    <div class="empty">
      <h3 class="h-card">{title}</h3>
      {note !== undefined ? <p class="empty-note">{note}</p> : null}
      {action !== undefined ? (
        <div class="empty-action">
          <Button href={action.href} variant="quiet">
            {action.label}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The quiet metadata voice. `micro` is reserved for categories and prices (§3). */
export function Meta(props: { bright?: boolean; num?: boolean; children?: Child }) {
  const cls = ["meta", props.bright === true ? "meta--bright" : "", props.num === true ? "num" : ""]
    .filter(Boolean)
    .join(" ");
  return <span class={cls}>{props.children}</span>;
}

/** Initials in a hairline square. Never a colour, never a circle (§7). */
export function Avatar(props: { name: string }) {
  return (
    <span class="avatar" aria-hidden="true">
      {initials(props.name)}
    </span>
  );
}

export type AlertProps = { tone?: Tone; confirm?: boolean; children?: Child };

/**
 * The confirmation banner: first child of `<main>`, above the `<h1>`,
 * `role="status"`, no auto-dismiss and no dismiss control (§10.4). The real
 * screen-reader announcement is the `<title>`.
 */
export function Alert(props: AlertProps) {
  const tone = props.tone ?? "quiet";
  const cls = ["alert", tone === "quiet" ? "" : `alert--${tone}`, props.confirm === true ? "alert--confirm" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div class={cls} role="status">
      {props.children}
    </div>
  );
}

export type FilterOption = { label: string; href: string; current?: boolean };

/** Micro-caps hairline row, active marked by a 1px brass underline. Never pills (§5). */
export function FilterRow(props: { label: string; options: FilterOption[] }) {
  return (
    <nav class="filters" aria-label={props.label}>
      {props.options.map((o) => (
        <a class="filter" href={o.href} aria-current={o.current === true ? "page" : undefined}>
          {o.label}
        </a>
      ))}
    </nav>
  );
}
