/**
 * Turning stored values into the strings the pages show.
 *
 * Two rules hold everywhere in this file:
 *
 *   1. **Deterministic.** Every function takes everything it needs as an
 *      argument — including `now`, and including the time zone, which defaults
 *      to `"UTC"` rather than the machine's. A formatter that reads the clock
 *      or the host locale passes on one machine and fails on another, and a
 *      Worker isolate's zone is UTC regardless of where the reader is.
 *   2. **Assembled from `Intl` parts, not from `Intl` output.** ICU inserts
 *      commas ("Fri, 12 Sep") and swaps separators between versions. Reading
 *      the parts and joining them ourselves pins the shape the design asks
 *      for: `Fri 12 Sep · 18:30–22:00`.
 */

/** The one accent character in a date range. U+00B7. */
const MIDDOT = "·";
/** En dash, not a hyphen — this is a range, and the design is typographic. */
const EN_DASH = "–";

interface DateParts {
  weekday: string;
  day: string;
  month: string;
  hour: string;
  minute: string;
}

function partsOf(d: Date, timeZone: string): DateParts {
  const parts = new Map(
    // en-US, not en-GB: CLDR's British short months are not all three letters
    // ("Sept"), and a date line that is one character wider in September only
    // is exactly the kind of thing this design notices.
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      // h23 explicitly: `hour12: false` renders midnight as "24:00" under some
      // locale/ICU pairings, which reads as a bug on a ticket.
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((part) => [part.type, part.value] as const),
  );
  return {
    weekday: parts.get("weekday") ?? "",
    day: parts.get("day") ?? "",
    month: parts.get("month") ?? "",
    hour: parts.get("hour") ?? "",
    minute: parts.get("minute") ?? "",
  };
}

/** `2026-09-12` in the given zone — the key two Dates share iff they are the same day there. */
function dayKey(d: Date, timeZone: string): string {
  const parts = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(d)
      .map((part) => [part.type, part.value] as const),
  );
  return `${parts.get("year") ?? ""}-${parts.get("month") ?? ""}-${parts.get("day") ?? ""}`;
}

/** Whole days between two `dayKey`s, ignoring the time of day entirely. */
function daysBetween(fromKey: string, toKey: string): number {
  const from = Date.parse(`${fromKey}T00:00:00Z`);
  const to = Date.parse(`${toKey}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/**
 * Integer cents to the string on the price card — `$1,200`, `$180`, `$1,200.50`.
 *
 * The cents are dropped when they are zero, which is the whole reason this is
 * not a bare `Intl.NumberFormat`: every price in `packages` is a round number,
 * and `$1,200.00` on a page this quiet looks like a receipt.
 *
 * Assumes a two-decimal currency (USD, EUR, GBP). A zero-decimal one such as
 * JPY would need its minor unit taken into account.
 */
export function formatMoney(cents: number, currency: string): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}

/** `Fri 12 Sep`. */
export function formatDay(d: Date, timeZone = "UTC"): string {
  const p = partsOf(d, timeZone);
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** `18:30`, always 24-hour. */
export function formatTime(d: Date, timeZone = "UTC"): string {
  const p = partsOf(d, timeZone);
  return `${p.hour}:${p.minute}`;
}

/**
 * When an event runs.
 *
 *   same day   `Fri 12 Sep · 18:30–22:00`
 *   over midnight  `Fri 12 Sep 22:00 – Sat 13 Sep 03:00`
 *
 * The day is only printed twice when it actually changes, so the common case
 * stays one short line on a card.
 */
export function formatDateRange(startsAt: Date, endsAt: Date, timeZone = "UTC"): string {
  const start = formatDay(startsAt, timeZone);
  const startTime = formatTime(startsAt, timeZone);
  const endTime = formatTime(endsAt, timeZone);

  if (dayKey(startsAt, timeZone) === dayKey(endsAt, timeZone)) {
    return `${start} ${MIDDOT} ${startTime}${EN_DASH}${endTime}`;
  }
  return `${start} ${startTime} ${EN_DASH} ${formatDay(endsAt, timeZone)} ${endTime}`;
}

/**
 * How soon, in words: `Today`, `Tomorrow`, `In 3 days`, else the date itself.
 *
 * `now` is a parameter rather than a `new Date()` inside, so a test can say
 * what "today" means instead of only passing on the day it was written.
 * Counting is by calendar day in `timeZone`, not by elapsed hours: 23:00
 * tonight and 01:00 tomorrow are "Today" and "Tomorrow", two hours apart.
 *
 * Past dates and anything beyond a week fall through to `formatDay` — "In 63
 * days" is not information anyone can use.
 */
export function relativeDay(d: Date, now: Date, timeZone = "UTC"): string {
  const days = daysBetween(dayKey(now, timeZone), dayKey(d, timeZone));
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days >= 2 && days <= 6) return `In ${days} days`;
  return formatDay(d, timeZone);
}

/**
 * "Monaco, Monaco" is what you get when a city-state's country repeats its city.
 * Print one of them.
 */
export function placeLabel(city: string, country: string): string {
  return city.trim().toLowerCase() === country.trim().toLowerCase()
    ? city
    : `${city}, ${country}`;
}

/** "1 member" / "3 members". The seed never produces n=1, so this only ever shows to a real new host. */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
