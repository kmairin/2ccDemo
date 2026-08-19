/**
 * Everything on the path from "I want to go" to "I have a ticket".
 *
 * `ActionArea` is the most important component in the product: eight rows in
 * the contract's state table, and the copy in each is fixed. Order inside it is
 * fixed too — community kicker, the ticket-and-places line, the button, one helper
 * line. The word "ticket" never appears without a number beside it, and the
 * button never just says "Book".
 *
 * One state has a second path through it. A member with no tickets is offered
 * **one ticket for this event** first — the community's 1-ticket package bought
 * and spent in a single submit — with the bigger packages underneath as the
 * cheaper-per-event option. Where the community sells no 1-ticket package, that
 * row falls back to exactly the package buttons it always had.
 */

import type { Child } from "hono/jsx";
import { Button } from "./components";

/** A package on offer. `href` points at the mock checkout, never straight at buy. */
export type PackageChoice = {
  id: string;
  /** Single, Trio or Season. */
  name: string;
  tickets: number;
  /** "€180" — never "€180.00", never "from". */
  price: string;
  /** The derivation: "3 events · €60 each". */
  derivation: string;
  /** `/communities/:slug/packages/:packageId/checkout`. */
  href: string;
  /** Defaults to `Take {name}`. */
  cta?: string;
};

/* ---------- the three packages, as one bordered table (§5) ---------- */

/**
 * One bordered table with hairline dividers — explicitly **not** three pricing
 * cards. Wrapped in its own scroll box so a narrow phone scrolls the table
 * rather than the page.
 */
export function PackageTable(props: { packages: PackageChoice[]; caption?: string }) {
  const { packages, caption } = props;
  return (
    <div class="bordered scroll-x" tabindex={0}>
      <table class="package-table">
        {caption !== undefined ? <caption class="vh">{caption}</caption> : null}
        <thead>
          <tr>
            <th scope="col">Package</th>
            <th scope="col">Tickets</th>
            <th scope="col">Price</th>
            <th scope="col">
              <span class="vh">Take it</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {packages.map((p) => (
            <tr>
              <th scope="row" class="package-name">
                {p.name}
              </th>
              <td class="num">{p.tickets}</td>
              <td>
                <span class="package-price">{p.price}</span>
                <span class="package-derivation">{p.derivation}</span>
              </td>
              <td>
                <Button href={p.href} variant="ghost">
                  {p.cta ?? `Take ${p.name}`}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- the action area ---------- */

export type ActionState =
  /** `/join?next=…`. */
  | { kind: "signed-out"; joinHref: string }
  /** Not a member of a public community: buying a package joins it. */
  | { kind: "join-public"; packages: PackageChoice[] }
  /** Not a member of a private community: the wall is real. */
  | { kind: "join-private"; requestAction: string; next?: string }
  | { kind: "pending"; hostFirstName: string }
  | { kind: "no-tickets"; packages: PackageChoice[] }
  | { kind: "ready"; bookAction: string; ticketsLeft: number; ticketsTotal: number }
  | { kind: "booked"; code: string; ticketHref: string }
  | { kind: "full"; nextUp?: { title: string; when: string; href: string } };

export type ActionAreaProps = {
  community: { slug: string; name: string };
  placesLeft: number;
  capacity: number;
  /** Always 1 today: booking spends one ticket. */
  ticketCost?: number;
  state: ActionState;
  /**
   * The event this area belongs to, for `POST /events/:slug/ticket`.
   * Optional: when it is absent the slug is read back out of the package links,
   * which the event page builds as `…/checkout?next=/events/<slug>` (see
   * `eventSlugFrom`). Pass it explicitly and that fallback is never used.
   */
  eventSlug?: string;
  /**
   * The one-time nonce for the single-ticket form. Defaults to a fresh one per
   * render, which is what makes a double tap collide instead of buying twice.
   */
  ticketNonce?: string;
};

function PackageButtons(props: { heading: string; packages: PackageChoice[] }) {
  return (
    <>
      <p class="action-heading">{props.heading}</p>
      <div class="action-packages">
        {props.packages.map((p) => (
          <Button href={p.href} variant="ghost" block={true}>
            {p.name} · {p.price} · {p.tickets} {p.tickets === 1 ? "ticket" : "tickets"}
          </Button>
        ))}
      </div>
    </>
  );
}

/* ---------- buying one ticket, without choosing a package ---------- */

/**
 * Which event these package links were built for.
 *
 * The event page hands the action area a community and a state and nothing
 * that names the event — but it builds every package link with
 * `?next=/events/<slug>` so a member lands back where they were. That is where
 * the slug comes from when `eventSlug` is not supplied.
 *
 * Anything that is not a single `/events/<slug>` path returns null, and the
 * caller then simply does not offer a ticket. The community page's package table has
 * no `next` at all, so it can never accidentally be treated as an event.
 */
function eventSlugFrom(packages: PackageChoice[], explicit?: string): string | null {
  if (explicit !== undefined && explicit !== "") return explicit;
  for (const choice of packages) {
    const query = choice.href.indexOf("?");
    if (query === -1) continue;
    const next = new URLSearchParams(choice.href.slice(query + 1)).get("next");
    const match = next === null ? null : /^\/events\/([A-Za-z0-9-]+)$/.exec(next);
    if (match) return match[1]!;
  }
  return null;
}

/**
 * "Buy a ticket — €135": the 1-ticket package and the booking in one submit
 * (`POST /events/:slug/ticket`).
 *
 * `crypto.randomUUID()` is exactly what `issuePurchaseNonce()` in `src/auth.ts`
 * returns; it is generated here rather than imported so this file keeps no
 * dependency on the auth module. A fresh one per render is the point — the
 * server spends it into the order reference, so submitting the same rendered
 * form twice collides on the unique index instead of buying a second ticket.
 */
function TicketButton(props: { action: string; price: string; nonce?: string }) {
  return (
    <form method="post" action={props.action}>
      <input type="hidden" name="nonce" value={props.nonce ?? crypto.randomUUID()} />
      <Button type="submit" variant="primary" block={true}>
        Buy a ticket — {props.price}
      </Button>
    </form>
  );
}

export function ActionArea(props: ActionAreaProps) {
  const { community, placesLeft, capacity, ticketCost = 1, state, eventSlug, ticketNonce } = props;

  // A member with no tickets is offered the single ticket first and the packages
  // underneath as the cheaper-per-event option. Both halves have to be
  // there: no 1-ticket package, or no event to attach it to, and this falls
  // back to exactly the package buttons that were here before.
  const noTickets = state.kind === "no-tickets" ? state.packages : [];
  const single = noTickets.find((p) => p.tickets === 1);
  const ticketSlug = eventSlugFrom(noTickets, eventSlug);
  const ticketAction =
    single !== undefined && ticketSlug !== null ? `/events/${ticketSlug}/ticket` : null;

  return (
    <div class="action">
      <p class="action-kicker">
        <a href={`/communities/${community.slug}`}>{community.name}</a>
      </p>

      <p class="action-line">
        {ticketCost} {ticketCost === 1 ? "ticket" : "tickets"} · {placesLeft} of {capacity} places left
      </p>

      {state.kind === "signed-out" ? (
        <>
          <Button href={state.joinHref} variant="primary" block={true}>
            Sign in to reserve
          </Button>
          <p class="action-help">Email and name. No password.</p>
        </>
      ) : null}

      {state.kind === "join-public" ? (
        <>
          <PackageButtons heading="Reserve with a package" packages={state.packages} />
          <p class="action-help">Buying a package joins the community.</p>
        </>
      ) : null}

      {state.kind === "join-private" ? (
        <>
          <form method="post" action={state.requestAction}>
            {state.next !== undefined ? <input type="hidden" name="next" value={state.next} /> : null}
            <Button type="submit" variant="primary" block={true}>
              Ask the host to join
            </Button>
          </form>
          <p class="action-help">This community approves members by hand.</p>
        </>
      ) : null}

      {state.kind === "pending" ? (
        <p class="action-help">
          Your request is with {state.hostFirstName}. Meanwhile: <a href="/events">other events</a> or{" "}
          <a href="/account">your account</a>.
        </p>
      ) : null}

      {state.kind === "no-tickets" ? (
        ticketAction !== null && single !== undefined ? (
          <>
            <TicketButton action={ticketAction} price={single.price} nonce={ticketNonce} />
            <p class="action-help">One place at this event. No card is charged.</p>
            <div style="margin-block-start:24px">
              <PackageButtons
                heading="or save with 3 or 6"
                packages={state.packages.filter((p) => p.tickets > 1)}
              />
            </div>
          </>
        ) : (
          <PackageButtons heading="You're in. You need a ticket." packages={state.packages} />
        )
      ) : null}

      {state.kind === "ready" ? (
        <>
          <form method="post" action={state.bookAction}>
            <Button type="submit" variant="primary" block={true}>
              Confirm your place
            </Button>
          </form>
          <p class="action-help">
            Uses 1 of your {state.ticketsLeft} {state.ticketsLeft === 1 ? "ticket" : "tickets"}.
          </p>
        </>
      ) : null}

      {state.kind === "booked" ? (
        <a class="action-stub" href={state.ticketHref}>
          <span>You're going</span>
          <span class="num">{state.code}</span>
        </a>
      ) : null}

      {state.kind === "full" ? (
        <>
          <Button variant="ghost" block={true} disabled={true}>
            Full
          </Button>
          {state.nextUp !== undefined ? (
            <p class="action-help">
              Next from this community:{" "}
              <a href={state.nextUp.href}>
                {state.nextUp.title}, {state.nextUp.when} →
              </a>
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/* ---------- the mobile action bar (§10.1) ---------- */

export type ActionBarProps = {
  title: string;
  /** "1 ticket · 4 places left". */
  note?: string;
  /** The button or the form that wraps it. */
  children?: Child;
};

/**
 * Opaque, never glass. Lives on `/communities/:slug` and `/events/:slug` only,
 * never global, and is rendered **after `</main>`** so tab order matches
 * visual order — package it to `Layout` as `actionBar`, which also sets
 * `class="has-actionbar"` on `<body>`. Hidden at ≥900px, where the same
 * actions live in a sticky sidebar card instead. Never both at once.
 */
export function ActionBar(props: ActionBarProps) {
  return (
    <div class="actionbar">
      <div class="actionbar-text">
        <p class="actionbar-title">{props.title}</p>
        {props.note !== undefined ? <p class="actionbar-note">{props.note}</p> : null}
      </div>
      {props.children}
    </div>
  );
}

/* ---------- the ticket (§5) ---------- */

/** A drawn seal, so the ticket reads as an object. Stroke only, no fill. */
function Seal() {
  return (
    <svg class="ticket-seal" viewBox="0 0 72 72" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" stroke-width="1">
        <community cx="36" cy="36" r="34" />
        <community cx="36" cy="36" r="30.5" stroke-dasharray="1.4 6.6" />
        <community cx="36" cy="36" r="25" />
      </g>
      <text
        x="36"
        y="36"
        text-anchor="middle"
        dominant-baseline="central"
        fill="currentColor"
        font-family="'IBM Plex Mono',monospace"
        font-size="11"
        letter-spacing="1.6"
      >
        2CC
      </text>
    </svg>
  );
}

export type TicketPlateProps = {
  /** The booking code, shown large in Plex Mono at `--t-code`. */
  code: string;
  title: string;
  communityName: string;
  /** "Sat 23 Aug · 06:30–09:00". */
  when: string;
  venue: string;
  address: string;
  /** Which package this drew from: "Trio · 2 tickets left". */
  packageName: string;
  bring?: string;
  /** "Free until Thu 21 Aug, 18:00". */
  cancelBy: string;
  /** Drives the ticket's ground offset, same hash as the event's plate. */
  seed: string;
};

export function TicketPlate(props: TicketPlateProps) {
  const { code, title, communityName, when, venue, address, packageName, bring, cancelBy } = props;
  return (
    <div class="ticket">
      <Seal />
      <p class="micro micro--brass">{communityName}</p>
      <p class="ticket-code">{code}</p>
      <h2 class="h-sec" style="margin-block-start:16px">
        {title}
      </h2>
      <dl class="ticket-grid">
        <div>
          <dt class="micro">When</dt>
          <dd class="ticket-dd num">{when}</dd>
        </div>
        <div>
          <dt class="micro">Where</dt>
          <dd class="ticket-dd">
            {venue}
            <br />
            {address}
          </dd>
        </div>
        <div>
          <dt class="micro">Drew from</dt>
          <dd class="ticket-dd">{packageName}</dd>
        </div>
        {bring !== undefined ? (
          <div>
            <dt class="micro">Bring</dt>
            <dd class="ticket-dd">{bring}</dd>
          </div>
        ) : null}
        <div>
          <dt class="micro">Cancel by</dt>
          <dd class="ticket-dd num">{cancelBy}</dd>
        </div>
      </dl>
    </div>
  );
}

/* ---------- mock checkout (contract §E) ---------- */

export type CheckoutSummaryProps = {
  communityName: string;
  packageName: string;
  tickets: number;
  /** "€480". */
  price: string;
  /** "6 events · €80 each". */
  perEvent: string;
  /** `/communities/:slug/packages/:packageId/buy`. */
  action: string;
  /** Burned server-side on first POST; a replay 302s with "already processed". */
  nonce: string;
  next?: string;
  /** Demo only. Never a real card, and never an enabled card input. */
  cardLast4?: string;
};

export function CheckoutSummary(props: CheckoutSummaryProps) {
  const { communityName, packageName, tickets, price, perEvent, action, nonce, next, cardLast4 } = props;
  return (
    <form class="checkout" method="post" action={action}>
      <input type="hidden" name="nonce" value={nonce} />
      {next !== undefined ? <input type="hidden" name="next" value={next} /> : null}

      <dl class="checkout-lines">
        <div class="checkout-line">
          <dt>Community</dt>
          <dd>{communityName}</dd>
        </div>
        <div class="checkout-line">
          <dt>Package</dt>
          <dd>{packageName}</dd>
        </div>
        <div class="checkout-line">
          <dt>Tickets</dt>
          <dd class="num">{tickets}</dd>
        </div>
        <div class="checkout-line">
          <dt>Price</dt>
          <dd class="package-price">{price}</dd>
        </div>
        <div class="checkout-line">
          <dt>Works out at</dt>
          <dd class="meta">{perEvent}</dd>
        </div>
      </dl>

      {/* Disabled on purpose: this demo records an order and never charges a
          card. There is deliberately no enabled card input anywhere. */}
      <fieldset class="checkout-card" disabled>
        <legend class="micro">Payment</legend>
        <p class="card-digits">•••• •••• •••• {cardLast4 ?? "4242"}</p>
        <p class="checkout-demo">DEMO — no card is charged</p>
      </fieldset>

      <Button type="submit" variant="primary">
        Confirm — {price}
      </Button>
    </form>
  );
}

/* ---------- tickets (§5 account) ---------- */

/**
 * N hairline squares, filled = spent. Not a progress bar — the count is
 * readable at a glance because you can count the squares.
 */
export function TicketSquares(props: { total: number; used: number; label?: string }) {
  const total = Math.max(0, Math.trunc(props.total));
  const used = Math.min(total, Math.max(0, Math.trunc(props.used)));
  const left = total - used;
  const squares: number[] = [];
  for (let i = 0; i < total; i++) squares.push(i);

  return (
    <div>
      <div class="tickets" role="img" aria-label={props.label ?? `${left} of ${total} tickets left`}>
        {squares.map((i) => (
          <span class={i < used ? "ticket-sq is-spent" : "ticket-sq"} />
        ))}
      </div>
      <p class="meta num" style="margin-block-start:12px">
        {left} of {total} left
      </p>
    </div>
  );
}
