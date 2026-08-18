/**
 * Everything on the path from "I want to go" to "I have a ticket".
 *
 * `ActionArea` is the most important component in the product: eight rows in
 * the contract's state table, and the copy in each is fixed. Order inside it is
 * fixed too — circle kicker, the credit-and-places line, the button, one helper
 * line. The word "credit" never appears without a number beside it, and the
 * button never just says "Book".
 *
 * One state has a second path through it. A member with no credits is offered
 * **one ticket for this gathering** first — the circle's 1-credit pass bought
 * and spent in a single submit — with the bigger passes underneath as the
 * cheaper-per-gathering option. Where the circle sells no 1-credit pass, that
 * row falls back to exactly the pass buttons it always had.
 */

import type { Child } from "hono/jsx";
import { Button } from "./components";

/** A pass on offer. `href` points at the mock checkout, never straight at buy. */
export type PassOffer = {
  id: string;
  /** Single, Trio or Season. */
  name: string;
  credits: number;
  /** "€180" — never "€180.00", never "from". */
  price: string;
  /** The derivation: "3 gatherings · €60 each". */
  derivation: string;
  /** `/circles/:slug/passes/:packageId/checkout`. */
  href: string;
  /** Defaults to `Take {name}`. */
  cta?: string;
};

/* ---------- the three passes, as one bordered table (§5) ---------- */

/**
 * One bordered table with hairline dividers — explicitly **not** three pricing
 * cards. Wrapped in its own scroll box so a narrow phone scrolls the table
 * rather than the page.
 */
export function PassTable(props: { passes: PassOffer[]; caption?: string }) {
  const { passes, caption } = props;
  return (
    <div class="bordered scroll-x" tabindex={0}>
      <table class="pass-table">
        {caption !== undefined ? <caption class="vh">{caption}</caption> : null}
        <thead>
          <tr>
            <th scope="col">Pass</th>
            <th scope="col">Credits</th>
            <th scope="col">Price</th>
            <th scope="col">
              <span class="vh">Take it</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {passes.map((p) => (
            <tr>
              <th scope="row" class="pass-name">
                {p.name}
              </th>
              <td class="num">{p.credits}</td>
              <td>
                <span class="pass-price">{p.price}</span>
                <span class="pass-derivation">{p.derivation}</span>
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
  /** Not a member of a public circle: buying a pass joins it. */
  | { kind: "join-public"; passes: PassOffer[] }
  /** Not a member of a private circle: the wall is real. */
  | { kind: "join-private"; requestAction: string; next?: string }
  | { kind: "pending"; hostFirstName: string }
  | { kind: "no-credits"; passes: PassOffer[] }
  | { kind: "ready"; bookAction: string; creditsLeft: number; creditsTotal: number }
  | { kind: "booked"; code: string; ticketHref: string }
  | { kind: "full"; nextUp?: { title: string; when: string; href: string } };

export type ActionAreaProps = {
  circle: { slug: string; name: string };
  placesLeft: number;
  capacity: number;
  /** Always 1 today: booking spends one credit. */
  creditCost?: number;
  state: ActionState;
  /**
   * The gathering this area belongs to, for `POST /events/:slug/ticket`.
   * Optional: when it is absent the slug is read back out of the pass links,
   * which the gathering page builds as `…/checkout?next=/events/<slug>` (see
   * `eventSlugFrom`). Pass it explicitly and that fallback is never used.
   */
  eventSlug?: string;
  /**
   * The one-time nonce for the single-ticket form. Defaults to a fresh one per
   * render, which is what makes a double tap collide instead of buying twice.
   */
  ticketNonce?: string;
};

function PassButtons(props: { heading: string; passes: PassOffer[] }) {
  return (
    <>
      <p class="action-heading">{props.heading}</p>
      <div class="action-passes">
        {props.passes.map((p) => (
          <Button href={p.href} variant="ghost" block={true}>
            {p.name} · {p.price} · {p.credits} {p.credits === 1 ? "credit" : "credits"}
          </Button>
        ))}
      </div>
    </>
  );
}

/* ---------- buying one ticket, without choosing a pass ---------- */

/**
 * Which gathering these pass links were built for.
 *
 * The gathering page hands the action area a circle and a state and nothing
 * that names the gathering — but it builds every pass link with
 * `?next=/events/<slug>` so a member lands back where they were. That is where
 * the slug comes from when `eventSlug` is not supplied.
 *
 * Anything that is not a single `/events/<slug>` path returns null, and the
 * caller then simply does not offer a ticket. The circle page's pass table has
 * no `next` at all, so it can never accidentally be treated as a gathering.
 */
function eventSlugFrom(passes: PassOffer[], explicit?: string): string | null {
  if (explicit !== undefined && explicit !== "") return explicit;
  for (const pass of passes) {
    const query = pass.href.indexOf("?");
    if (query === -1) continue;
    const next = new URLSearchParams(pass.href.slice(query + 1)).get("next");
    const match = next === null ? null : /^\/events\/([A-Za-z0-9-]+)$/.exec(next);
    if (match) return match[1]!;
  }
  return null;
}

/**
 * "Buy a ticket — €135": the 1-credit pass and the booking in one submit
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
  const { circle, placesLeft, capacity, creditCost = 1, state, eventSlug, ticketNonce } = props;

  // A member with no credits is offered the single ticket first and the passes
  // underneath as the cheaper-per-gathering option. Both halves have to be
  // there: no 1-credit pass, or no gathering to attach it to, and this falls
  // back to exactly the pass buttons that were here before.
  const noCredits = state.kind === "no-credits" ? state.passes : [];
  const single = noCredits.find((p) => p.credits === 1);
  const ticketSlug = eventSlugFrom(noCredits, eventSlug);
  const ticketAction =
    single !== undefined && ticketSlug !== null ? `/events/${ticketSlug}/ticket` : null;

  return (
    <div class="action">
      <p class="action-kicker">
        <a href={`/circles/${circle.slug}`}>{circle.name}</a>
      </p>

      <p class="action-line">
        {creditCost} {creditCost === 1 ? "credit" : "credits"} · {placesLeft} of {capacity} places left
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
          <PassButtons heading="Reserve with a pass" passes={state.passes} />
          <p class="action-help">Buying a pass joins the circle.</p>
        </>
      ) : null}

      {state.kind === "join-private" ? (
        <>
          <form method="post" action={state.requestAction}>
            {state.next !== undefined ? <input type="hidden" name="next" value={state.next} /> : null}
            <Button type="submit" variant="primary" block={true}>
              Request an invitation
            </Button>
          </form>
          <p class="action-help">This circle approves members by hand.</p>
        </>
      ) : null}

      {state.kind === "pending" ? (
        <p class="action-help">
          Your request is with {state.hostFirstName}. Meanwhile: <a href="/events">other gatherings</a> or{" "}
          <a href="/account">your account</a>.
        </p>
      ) : null}

      {state.kind === "no-credits" ? (
        ticketAction !== null && single !== undefined ? (
          <>
            <TicketButton action={ticketAction} price={single.price} nonce={ticketNonce} />
            <p class="action-help">One place at this gathering. No card is charged.</p>
            <div style="margin-block-start:24px">
              <PassButtons
                heading="or save with 3 or 6"
                passes={state.passes.filter((p) => p.credits > 1)}
              />
            </div>
          </>
        ) : (
          <PassButtons heading="You're in. You need a credit." passes={state.passes} />
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
            Uses 1 of your {state.creditsLeft} {state.creditsLeft === 1 ? "credit" : "credits"}.
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
              Next from this circle:{" "}
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
  /** "1 credit · 4 places left". */
  note?: string;
  /** The button or the form that wraps it. */
  children?: Child;
};

/**
 * Opaque, never glass. Lives on `/circles/:slug` and `/events/:slug` only,
 * never global, and is rendered **after `</main>`** so tab order matches
 * visual order — pass it to `Layout` as `actionBar`, which also sets
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
        <circle cx="36" cy="36" r="34" />
        <circle cx="36" cy="36" r="30.5" stroke-dasharray="1.4 6.6" />
        <circle cx="36" cy="36" r="25" />
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
  circleName: string;
  /** "Sat 23 Aug · 06:30–09:00". */
  when: string;
  venue: string;
  address: string;
  /** Which pass this drew from: "Trio · 2 credits left". */
  passName: string;
  bring?: string;
  /** "Free until Thu 21 Aug, 18:00". */
  cancelBy: string;
  /** Drives the ticket's ground offset, same hash as the gathering's plate. */
  seed: string;
};

export function TicketPlate(props: TicketPlateProps) {
  const { code, title, circleName, when, venue, address, passName, bring, cancelBy } = props;
  return (
    <div class="ticket">
      <Seal />
      <p class="micro micro--brass">{circleName}</p>
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
          <dd class="ticket-dd">{passName}</dd>
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
  circleName: string;
  passName: string;
  credits: number;
  /** "€480". */
  price: string;
  /** "6 gatherings · €80 each". */
  perGathering: string;
  /** `/circles/:slug/passes/:packageId/buy`. */
  action: string;
  /** Burned server-side on first POST; a replay 302s with "already processed". */
  nonce: string;
  next?: string;
  /** Demo only. Never a real card, and never an enabled card input. */
  cardLast4?: string;
};

export function CheckoutSummary(props: CheckoutSummaryProps) {
  const { circleName, passName, credits, price, perGathering, action, nonce, next, cardLast4 } = props;
  return (
    <form class="checkout" method="post" action={action}>
      <input type="hidden" name="nonce" value={nonce} />
      {next !== undefined ? <input type="hidden" name="next" value={next} /> : null}

      <dl class="checkout-lines">
        <div class="checkout-line">
          <dt>Circle</dt>
          <dd>{circleName}</dd>
        </div>
        <div class="checkout-line">
          <dt>Pass</dt>
          <dd>{passName}</dd>
        </div>
        <div class="checkout-line">
          <dt>Credits</dt>
          <dd class="num">{credits}</dd>
        </div>
        <div class="checkout-line">
          <dt>Price</dt>
          <dd class="pass-price">{price}</dd>
        </div>
        <div class="checkout-line">
          <dt>Works out at</dt>
          <dd class="meta">{perGathering}</dd>
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

/* ---------- credits (§5 account) ---------- */

/**
 * N hairline squares, filled = spent. Not a progress bar — the count is
 * readable at a glance because you can count the squares.
 */
export function CreditSquares(props: { total: number; used: number; label?: string }) {
  const total = Math.max(0, Math.trunc(props.total));
  const used = Math.min(total, Math.max(0, Math.trunc(props.used)));
  const left = total - used;
  const squares: number[] = [];
  for (let i = 0; i < total; i++) squares.push(i);

  return (
    <div>
      <div class="credits" role="img" aria-label={props.label ?? `${left} of ${total} credits left`}>
        {squares.map((i) => (
          <span class={i < used ? "credit-sq is-spent" : "credit-sq"} />
        ))}
      </div>
      <p class="meta num" style="margin-block-start:12px">
        {left} of {total} left
      </p>
    </div>
  );
}
