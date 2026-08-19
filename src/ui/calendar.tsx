/**
 * The two date-organised views of events.
 *
 * `Ledger` is §5's list: not a card grid — an 88px mono date column, hairline
 * rows, a 64px square plate thumb and month group headers.
 *
 * `CalendarMonth` is the contract's §D: a month grid at ≥900px that collapses
 * to the same day-grouped list at ≤899px. Both shapes are rendered from the
 * same data and swapped by a media query, exactly as the nav is — forcing one
 * layout to reflow into the other is unreliable across engines.
 */

import { Plate } from "./components";
import { initials } from "./plate";

/* ---------- ledger ---------- */

export type LedgerEntry = {
  slug: string;
  title: string;
  communityName: string;
  venue: string;
  city: string;
  category?: string;
  /** "Sat 23" — already formatted. This file never touches dates. */
  dayLabel: string;
  /** "Aug". */
  monthLabel: string;
  /** "06:30" or "06:30–09:00". */
  timeLabel: string;
  placesLeft: number;
  /** A real photograph under design/assets/. Null falls back to the plate. */
  coverKey?: string | null;
};

export type LedgerGroup = {
  /** "August 2026". */
  month: string;
  entries: LedgerEntry[];
};

export function Ledger(props: { groups: LedgerGroup[] }) {
  return (
    <div class="ledger">
      {props.groups.map((group) => (
        <>
          <div class="ledger-month">
            <span class="micro">{group.month}</span>
            <span class="meta num">{group.entries.length}</span>
          </div>
          {group.entries.map((e) => (
            <div class="ledger-row linkbox">
              {/* Three explicit lines. Letting "Aug · 06:40–17:20" wrap inside
                  88px strands the separator at the end of a line. */}
              <p class="ledger-date">
                <b>{e.dayLabel}</b>
                <span>{e.monthLabel}</span>
                <span>{e.timeLabel}</span>
              </p>
              {/* The photograph, at 64px. Falling back to a plate, where the
                  community's monogram is what keeps a 64px square from reading as
                  a failed thumbnail — with no subject all eight rows look
                  alike. */}
              <Plate
                seed={e.slug}
                category={e.category ?? ""}
                monogram={initials(e.communityName)}
                rule={true}
                shape="bare"
                density="thumb"
                className="ledger-thumb"
                objectKey={e.coverKey}
                alt=""
              />
              <div class="ledger-main">
                <h3 class="ledger-title linkbox-title">
                  <a href={`/events/${e.slug}`}>{e.title}</a>
                </h3>
                <p class="meta">
                  {e.communityName} · {e.venue}, {e.city}
                </p>
              </div>
              <div class="ledger-foot">
                <span class={e.placesLeft <= 0 ? "status" : e.placesLeft <= 3 ? "status status--warn" : "status status--brass"}>
                  {e.placesLeft <= 0 ? "Full" : `${e.placesLeft} left`}
                </span>
              </div>
            </div>
          ))}
        </>
      ))}
    </div>
  );
}

/* ---------- month view ---------- */

export type CalendarEntry = {
  slug: string;
  title: string;
  /** "18:30". */
  timeLabel: string;
};

export type CalendarDay = {
  /** `YYYY-MM-DD`. */
  date: string;
  dayNumber: number;
  /** "Sat" — used by the ≤899px list. */
  weekdayLabel: string;
  /** False for the leading and trailing days borrowed from adjacent months. */
  inMonth: boolean;
  isToday: boolean;
  /** Published events only. */
  entries: CalendarEntry[];
};

export type CalendarMonthProps = {
  /**
   * "August 2026". Rendered as this component's own `<h2>`, so the page around
   * it supplies the `<h1>` and does not repeat the month in a section title.
   */
  monthLabel: string;
  /** `/calendar?month=YYYY-MM` for the month either side. */
  prevHref: string;
  nextHref: string;
  prevLabel?: string;
  nextLabel?: string;
  /** Weeks of exactly seven days, in display order. */
  weeks: CalendarDay[][];
  /** Column headings, in the same order as the weeks. */
  weekdayNames?: string[];
};

const DEFAULT_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The first three, then `+N`. */
const MAX_PER_DAY = 3;

function DayEntries(props: { entries: CalendarEntry[] }) {
  const shown = props.entries.slice(0, MAX_PER_DAY);
  const hidden = props.entries.length - shown.length;
  return (
    <>
      {shown.map((e) => (
        <p class="cal-entry">
          <a href={`/events/${e.slug}`}>
            <span class="num">{e.timeLabel}</span>
            <span class="cal-entry-title"> · {e.title}</span>
          </a>
        </p>
      ))}
      {hidden > 0 ? <p class="cal-more">+{hidden}</p> : null}
    </>
  );
}

export function CalendarMonth(props: CalendarMonthProps) {
  const { monthLabel, prevHref, nextHref, prevLabel, nextLabel, weeks } = props;
  const weekdays = props.weekdayNames ?? DEFAULT_WEEKDAYS;
  const days = weeks.flat();
  const listDays = days.filter((d) => d.inMonth && d.entries.length > 0);

  return (
    <div>
      <div class="cal-head">
        <h2 class="h-sec">{monthLabel}</h2>
        <nav class="cal-nav" aria-label="Month">
          <a class="btn btn--quiet" href={prevHref} rel="prev">
            ← {prevLabel ?? "Previous"}
          </a>
          <a class="btn btn--quiet" href={nextHref} rel="next">
            {nextLabel ?? "Next"} →
          </a>
        </nav>
      </div>

      <div class="cal-dow" aria-hidden="true">
        {weekdays.map((w) => (
          <span class="micro">{w}</span>
        ))}
      </div>

      <div class="cal-grid">
        {days.map((d) => (
          <div
            class={`cal-cell${d.inMonth ? "" : " is-outside"}${d.isToday ? " is-today" : ""}`}
            aria-current={d.isToday ? "date" : undefined}
          >
            <span class="cal-num">{d.dayNumber}</span>
            <DayEntries entries={d.entries} />
          </div>
        ))}
      </div>

      <div class="cal-list">
        {listDays.length === 0 ? (
          <p class="cal-empty">No events this month.</p>
        ) : (
          listDays.map((d) => (
            <div class={d.isToday ? "cal-day-row is-today" : "cal-day-row"}>
              <p class="cal-day-label">
                <span>{d.weekdayLabel}</span>
                <span class="num">{d.dayNumber}</span>
              </p>
              <div>
                <DayEntries entries={d.entries} />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
