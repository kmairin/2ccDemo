/**
 * Kitchen sink for the design system — every component, realistic dummy data.
 *
 * Scaffolding, not product: nothing in `src/` imports it except whoever mounts
 * it for a look. Mount it from `src/index.ts` with
 * `app.route("/__preview", preview)`, or render it with no server at all via
 * `renderPreview()`.
 *
 * The copy here follows §6 — named people, a cadence, a physical specific and
 * one constraint per circle; real minutes; prices with their derivation; none
 * of the banned words. It is dummy data that a designer can judge.
 */

import { Hono } from "hono";
import { ActionArea, ActionBar, CheckoutSummary, CreditSquares, PassTable, TicketPlate, type ActionState, type PassOffer } from "./booking";
import { CalendarMonth, Ledger, type CalendarDay, type CalendarEntry, type LedgerGroup } from "./calendar";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  CardGrid,
  CircleCard,
  Container,
  Divider,
  EmptyState,
  EventCard,
  Field,
  FilterRow,
  Hero,
  Meta,
  PassCard,
  PassGrid,
  Plate,
  Section,
  SectionIndex,
  Stat,
} from "./components";
import { Gallery } from "./gallery";
import { Layout } from "./layout";
import { AttendeeList, MemberList, type PersonEntry } from "./people";

/* ---------- data ---------- */

const CIRCLES = [
  {
    slug: "adriatic-sailing-society",
    name: "Adriatic Sailing Society",
    category: "sailing",
    city: "Split",
    memberCount: 47,
    tagline: "Marko Bulat sails a 1974 Swan out of Split most Saturdays. Eight berths, and you take a watch.",
  },
  // Sailing and dining sit side by side on purpose: §10.5's wash correction is
  // only worth anything if two categories are distinguishable next to each other.
  {
    slug: "table-nineteen",
    name: "Table Nineteen",
    category: "dining",
    city: "Lisbon",
    memberCount: 113,
    tagline: "Inês Carvalho cooks for nineteen at one long table in Alfama. One sitting, 20:30, no substitutions.",
  },
  {
    slug: "the-cold-room",
    name: "The Cold Room",
    category: "wellness",
    city: "Stockholm",
    memberCount: 31,
    isPrivate: true,
    tagline: "Tomas Ek keeps three ice baths and a sauna in a Södermalm pump house. Twelve places, no phones.",
  },
  {
    slug: "court-nine",
    name: "Court Nine",
    category: "sport",
    city: "Valencia",
    memberCount: 89,
    tagline: "Rafa Ortí books the clay before the heat. 06:40 on Tuesdays, four courts, bring your own grip.",
  },
  {
    slug: "the-etching-room",
    name: "The Etching Room",
    category: "art",
    city: "Copenhagen",
    memberCount: 23,
    isPrivate: true,
    tagline: "Bente Holm runs a copperplate press in Nørrebro. Thursdays, six presses, you clean your own plate.",
  },
  // One-word name, so the grid shows the §10.5 two-letter monogram ("NA").
  {
    slug: "nautholsvik",
    name: "Nauthólsvík",
    category: "wellness",
    city: "Reykjavík",
    memberCount: 61,
    tagline: "Sigrún Páls swims the same line all year, out past the jetty. Saturdays at 08:15, nobody alone.",
  },
];

const EVENT_CARDS = [
  {
    slug: "hvar-crossing-august",
    title: "The Hvar crossing",
    circleName: "Adriatic Sailing Society",
    category: "sailing",
    city: "Split",
    venue: "ACI Marina, pontoon D",
    when: "Sat 22 Aug · 06:40",
    placesLeft: 3,
  },
  {
    slug: "pump-house-tuesday",
    title: "Tuesday in the pump house",
    circleName: "The Cold Room",
    category: "wellness",
    city: "Stockholm",
    venue: "Hornstulls pumphus",
    when: "Tue 25 Aug · 06:30",
    placesLeft: 1,
  },
  {
    slug: "alfama-long-table",
    title: "The long table, Alfama",
    circleName: "Table Nineteen",
    category: "dining",
    city: "Lisbon",
    venue: "Rua dos Remédios 42",
    when: "Fri 28 Aug · 20:30",
    placesLeft: 0,
  },
];

const GALLERY = [
  { caption: "The pump house, 06:30", seed: "cold-room-photo-1" },
  { caption: "Ice baths, Södermalm", seed: "cold-room-photo-2" },
  { caption: "Tomas laying the stones", seed: "cold-room-photo-3" },
  { caption: "Sauna, second round", seed: "cold-room-photo-4" },
  { caption: "The bench, after", seed: "cold-room-photo-5" },
  { caption: "Hornstull at first light", seed: "cold-room-photo-6" },
];

const HOST: PersonEntry = {
  name: "Tomas Ek",
  headline: "Ran the Vasa cold-water club for nine years",
  city: "Stockholm",
};

const MEMBERS: PersonEntry[] = [
  { name: "Amara Okonjo", headline: "Structural engineer, bridges", city: "Stockholm" },
  { name: "Jonas Lindqvist", headline: "Boatwright, Beckholmen", city: "Stockholm" },
  { name: "Priya Raghavan", headline: "Anaesthetist, Karolinska", city: "Solna" },
  { name: "Elif Demir", headline: "Runs a paper mill in Grycksbo", city: "Falun" },
  { name: "Henrik Sørensen", headline: "Trains open-water swimmers", city: "Malmö" },
  { name: "Marta Kowalska", headline: "Cellist, Konserthuset", city: "Stockholm" },
  { name: "Yusuf Baraka", headline: "Restores wooden saunas", city: "Uppsala" },
  { name: "Lena Fischer", headline: "Cartographer, Lantmäteriet", city: "Gävle" },
];

const ATTENDEES: PersonEntry[] = [
  { name: "Amara Okonjo", headline: "Structural engineer, bridges" },
  { name: "Priya Raghavan", headline: "Anaesthetist, Karolinska" },
  { name: "Jonas Lindqvist", headline: "Boatwright, Beckholmen" },
  { name: "Henrik Sørensen", headline: "Trains open-water swimmers" },
  { name: "Elif Demir", headline: "Runs a paper mill in Grycksbo" },
];

/** Season is not exactly 6× Single (§6). */
const PASSES: PassOffer[] = [
  {
    id: "single",
    name: "Single",
    credits: 1,
    price: "€70",
    derivation: "1 gathering · €70 each",
    href: "/circles/the-cold-room/passes/single/checkout",
    cta: "Take one",
  },
  {
    id: "trio",
    name: "Trio",
    credits: 3,
    price: "€180",
    derivation: "3 gatherings · €60 each",
    href: "/circles/the-cold-room/passes/trio/checkout",
    cta: "Take the Trio",
  },
  {
    id: "season",
    name: "Season",
    credits: 6,
    price: "€330",
    derivation: "6 gatherings · €55 each",
    href: "/circles/the-cold-room/passes/season/checkout",
    cta: "Take the Season",
  },
];

const LEDGER: LedgerGroup[] = [
  {
    month: "August 2026",
    entries: [
      { slug: "hvar-crossing-august", title: "The Hvar crossing", circleName: "Adriatic Sailing Society", venue: "ACI Marina", city: "Split", category: "sailing", dayLabel: "Sat 22", monthLabel: "Aug", timeLabel: "06:40–17:20", placesLeft: 3 },
      { slug: "pump-house-tuesday", title: "Tuesday in the pump house", circleName: "The Cold Room", venue: "Hornstulls pumphus", city: "Stockholm", category: "wellness", dayLabel: "Tue 25", monthLabel: "Aug", timeLabel: "06:30–08:05", placesLeft: 1 },
      { slug: "clay-before-heat", title: "Clay before the heat", circleName: "Court Nine", venue: "Club Deportivo", city: "Valencia", category: "sport", dayLabel: "Tue 25", monthLabel: "Aug", timeLabel: "06:40–08:40", placesLeft: 6 },
      { slug: "alfama-long-table", title: "The long table, Alfama", circleName: "Table Nineteen", venue: "Rua dos Remédios 42", city: "Lisbon", category: "dining", dayLabel: "Fri 28", monthLabel: "Aug", timeLabel: "20:30–23:45", placesLeft: 0 },
      { slug: "nautholsvik-line", title: "The Nauthólsvík line", circleName: "Nauthólsvík", venue: "Nauthólsvík beach", city: "Reykjavík", category: "wellness", dayLabel: "Sat 29", monthLabel: "Aug", timeLabel: "08:15–09:25", placesLeft: 11 },
      { slug: "copperplate-thursday", title: "Copperplate Thursday", circleName: "The Etching Room", venue: "Nørrebrogade 214", city: "Copenhagen", category: "art", dayLabel: "Sun 30", monthLabel: "Aug", timeLabel: "14:10–18:00", placesLeft: 2 },
    ],
  },
  {
    month: "September 2026",
    entries: [
      { slug: "vis-overnight", title: "Overnight to Vis", circleName: "Adriatic Sailing Society", venue: "ACI Marina", city: "Split", category: "sailing", dayLabel: "Fri 04", monthLabel: "Sep", timeLabel: "17:05–11:30", placesLeft: 4 },
      { slug: "september-cold-round", title: "The September round", circleName: "The Cold Room", venue: "Hornstulls pumphus", city: "Stockholm", category: "wellness", dayLabel: "Tue 08", monthLabel: "Sep", timeLabel: "06:30–08:05", placesLeft: 9 },
      { slug: "nineteen-for-figs", title: "Nineteen, for the figs", circleName: "Table Nineteen", venue: "Rua dos Remédios 42", city: "Lisbon", category: "dining", dayLabel: "Fri 11", monthLabel: "Sep", timeLabel: "20:30–23:50", placesLeft: 5 },
      { slug: "drypoint-evening", title: "Drypoint evening", circleName: "The Etching Room", venue: "Nørrebrogade 214", city: "Copenhagen", category: "art", dayLabel: "Thu 17", monthLabel: "Sep", timeLabel: "18:20–21:40", placesLeft: 1 },
      { slug: "doubles-ladder", title: "The doubles ladder", circleName: "Court Nine", venue: "Club Deportivo", city: "Valencia", category: "sport", dayLabel: "Tue 22", monthLabel: "Sep", timeLabel: "06:40–08:40", placesLeft: 8 },
    ],
  },
  {
    month: "November 2026",
    entries: [
      { slug: "first-frost-swim", title: "First frost swim", circleName: "Nauthólsvík", venue: "Nauthólsvík beach", city: "Reykjavík", category: "wellness", dayLabel: "Sat 07", monthLabel: "Nov", timeLabel: "08:15–09:20", placesLeft: 14 },
      { slug: "winter-plates", title: "Winter plates", circleName: "The Etching Room", venue: "Nørrebrogade 214", city: "Copenhagen", category: "art", dayLabel: "Thu 19", monthLabel: "Nov", timeLabel: "18:20–21:35", placesLeft: 3 },
      { slug: "laying-up-day", title: "Laying-up day", circleName: "Adriatic Sailing Society", venue: "Brodarica yard", city: "Split", category: "sailing", dayLabel: "Sat 28", monthLabel: "Nov", timeLabel: "09:20–15:00", placesLeft: 7 },
    ],
  },
];

/* ---------- calendar, built from a fixed month so the preview is stable ---------- */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TODAY = "2026-08-18";

const CAL_ENTRIES: Record<string, CalendarEntry[]> = {
  "2026-08-04": [{ slug: "clay-before-heat", title: "Clay before the heat", timeLabel: "06:40" }],
  "2026-08-08": [
    { slug: "nautholsvik-line", title: "The Nauthólsvík line", timeLabel: "08:15" },
    { slug: "hvar-crossing-august", title: "The Hvar crossing", timeLabel: "06:40" },
  ],
  "2026-08-18": [
    { slug: "pump-house-tuesday", title: "Tuesday in the pump house", timeLabel: "06:30" },
    { slug: "clay-before-heat", title: "Clay before the heat", timeLabel: "06:40" },
    { slug: "drypoint-evening", title: "Drypoint evening", timeLabel: "18:20" },
    { slug: "alfama-long-table", title: "The long table, Alfama", timeLabel: "20:30" },
  ],
  "2026-08-22": [{ slug: "hvar-crossing-august", title: "The Hvar crossing", timeLabel: "06:40" }],
  "2026-08-25": [
    { slug: "pump-house-tuesday", title: "Tuesday in the pump house", timeLabel: "06:30" },
    { slug: "clay-before-heat", title: "Clay before the heat", timeLabel: "06:40" },
  ],
  "2026-08-28": [{ slug: "alfama-long-table", title: "The long table, Alfama", timeLabel: "20:30" }],
  "2026-08-30": [{ slug: "copperplate-thursday", title: "Copperplate Thursday", timeLabel: "14:10" }],
};

const DAY_MS = 86400000;

/** Monday-first weeks covering the whole month, plus the days either side. */
function buildMonth(year: number, month: number): CalendarDay[][] {
  const firstOfMonth = Date.UTC(year, month - 1, 1);
  const lead = (new Date(firstOfMonth).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rows = Math.ceil((lead + days) / 7);
  const start = firstOfMonth - lead * DAY_MS;

  const weeks: CalendarDay[][] = [];
  for (let w = 0; w < rows; w++) {
    const week: CalendarDay[] = [];
    for (let d = 0; d < 7; d++) {
      const cur = new Date(start + (w * 7 + d) * DAY_MS);
      const date = cur.toISOString().slice(0, 10);
      week.push({
        date,
        dayNumber: cur.getUTCDate(),
        weekdayLabel: WEEKDAYS[(cur.getUTCDay() + 6) % 7],
        inMonth: cur.getUTCMonth() === month - 1,
        isToday: date === TODAY,
        entries: CAL_ENTRIES[date] ?? [],
      });
    }
    weeks.push(week);
  }
  return weeks;
}

/* ---------- the seven states, one block each ---------- */

const STATES: { label: string; state: ActionState; placesLeft: number }[] = [
  { label: "1 · Signed out", placesLeft: 4, state: { kind: "signed-out", joinHref: "/join?next=/events/pump-house-tuesday" } },
  { label: "2 · Not a member, public circle", placesLeft: 4, state: { kind: "join-public", passes: PASSES } },
  { label: "3 · Not a member, private circle", placesLeft: 4, state: { kind: "join-private", requestAction: "/circles/the-cold-room/join", next: "/events/pump-house-tuesday" } },
  { label: "4 · Pending approval", placesLeft: 4, state: { kind: "pending", hostFirstName: "Tomas" } },
  { label: "5 · Member, no credits", placesLeft: 4, state: { kind: "no-credits", passes: PASSES } },
  { label: "6 · Member, has credits", placesLeft: 4, state: { kind: "ready", bookAction: "/events/pump-house-tuesday/book", creditsLeft: 3, creditsTotal: 3 } },
  { label: "7 · Already booked", placesLeft: 3, state: { kind: "booked", code: "2CC-K7QF-2M", ticketHref: "/account/tickets/2CC-K7QF-2M" } },
  {
    label: "8 · Full",
    placesLeft: 0,
    state: { kind: "full", nextUp: { title: "The September round", when: "Tue 8 Sep", href: "/events/september-cold-round" } },
  },
];

/* ---------- the page ---------- */

function PreviewPage() {
  return (
    <Layout
      title="Design system"
      description="Every 2CC component on one page, with dummy data."
      user={{ name: "Amara Okonjo" }}
      active="circles"
      actionBar={
        <ActionBar title="Tuesday in the pump house" note="1 credit · 1 place left">
          <Button href="#action-area" variant="primary">
            Confirm your place
          </Button>
        </ActionBar>
      }
    >
      <Container>
        <Alert tone="brass" confirm={true}>
          Booked. Tuesday in the pump house, 25 August at 06:30. Your ticket is on your account.
        </Alert>
      </Container>

      <Hero
        index={1}
        label="The design system"
        scale="hero"
        title="Every plate, rule and state in one place."
        lede="Six plates side by side, the ledger, the calendar, and all eight rows of the action area. Realistic copy, so a regression is obvious."
      >
        <Button href="#plates" variant="primary">
          Go to the plates
        </Button>
        <Button href="#action-area" variant="ghost">
          Go to the action area
        </Button>
      </Hero>

      <Section index={2} label="Circles" title="Six plates, side by side" id="plates" action={{ href: "/circles", label: "All circles" }}>
        <div style="margin-block-end:32px">
          <FilterRow
            label="Category"
            options={[
              { label: "All", href: "/circles", current: true },
              { label: "Sailing", href: "/circles?category=sailing" },
              { label: "Wellness", href: "/circles?category=wellness" },
              { label: "Dining", href: "/circles?category=dining" },
              { label: "Sport", href: "/circles?category=sport" },
              { label: "Art", href: "/circles?category=art" },
            ]}
          />
        </div>
        <CardGrid>
          {CIRCLES.map((c) => (
            <CircleCard
              slug={c.slug}
              name={c.name}
              tagline={c.tagline}
              city={c.city}
              category={c.category}
              memberCount={c.memberCount}
              isPrivate={c.isPrivate}
            />
          ))}
        </CardGrid>
      </Section>

      <Section index={3} label="Gatherings" title="Cards, and the hero plate">
        <CardGrid wide={true}>
          {EVENT_CARDS.map((e) => (
            <EventCard
              slug={e.slug}
              title={e.title}
              circleName={e.circleName}
              city={e.city}
              venue={e.venue}
              when={e.when}
              placesLeft={e.placesLeft}
              category={e.category}
            />
          ))}
        </CardGrid>

        <div style="margin-block-start:48px">
          <Plate seed="the-cold-room" category="wellness" monogram="TC" shape="hero" density="hero" />
          <h3 class="h-page" style="margin-top:-.4em;position:relative">
            The Cold Room
          </h3>
        </div>
      </Section>

      <Section index={4} label="Photographs" title="The archive strip">
        <p class="prose" style="margin-block-end:24px">
          There is no photography, so the strip is generated plates with real captions. Scroll it
          sideways, or focus it and use the arrow keys.
        </p>
        <Gallery label="The Cold Room, archive" category="wellness" items={GALLERY} />
      </Section>

      <Section index={5} label="Members" title="Who is in this circle">
        <MemberList members={MEMBERS} host={HOST} total={31} moreHref="/circles/the-cold-room#members" />
      </Section>

      <Section index={6} label="Attendees" title="Who is coming">
        <div class="stack stack--wide">
          <AttendeeList attendees={ATTENDEES} going={9} capacity={12} />
          <Divider />
          <AttendeeList
            attendees={ATTENDEES}
            going={9}
            capacity={12}
            signedOut={true}
            signInHref="/join?next=/events/pump-house-tuesday"
          />
        </div>
      </Section>

      <Section index={7} label="The ledger" title="Gatherings, as a ledger" action={{ href: "/events", label: "All gatherings" }}>
        <Ledger groups={LEDGER} />
      </Section>

      {/* The Section title is not the month: CalendarMonth renders the month
          label as its own <h2>. On /calendar the page's <h1> is the subject
          and the component supplies the only heading under it. */}
      <Section index={8} label="Calendar" title="The month view">
        <CalendarMonth
          monthLabel="August 2026"
          prevHref="/calendar?month=2026-07"
          nextHref="/calendar?month=2026-09"
          prevLabel="July"
          nextLabel="September"
          weeks={buildMonth(2026, 8)}
        />
      </Section>

      <Section index={9} label="Passes" title="One table, not three cards">
        <PassTable passes={PASSES} caption="The three passes for The Cold Room" />

        <h3 class="h-card" style="margin-block-start:48px">
          Passes you hold
        </h3>
        <div style="margin-block-start:16px">
          <PassGrid>
            <PassCard name="Trio" credits={3} price="€180" derivation="3 gatherings · €60 each" note="The Cold Room">
              <div style="margin-block-start:16px">
                <CreditSquares total={3} used={1} />
              </div>
            </PassCard>
            <PassCard name="Season" credits={6} price="€330" derivation="6 gatherings · €55 each" note="Court Nine">
              <div style="margin-block-start:16px">
                <CreditSquares total={6} used={4} />
              </div>
            </PassCard>
            <PassCard name="Single" credits={1} price="€70" derivation="1 gathering · €70 each" note="Table Nineteen">
              <div style="margin-block-start:16px">
                <CreditSquares total={1} used={1} />
              </div>
            </PassCard>
          </PassGrid>
        </div>
      </Section>

      <Section index={10} label="Action area" title="All eight states" id="action-area">
        <div class="grid grid--hair">
          {STATES.map((s) => (
            <div style="background:var(--card);padding:24px">
              <p class="micro" style="margin-block-end:16px">
                {s.label}
              </p>
              <ActionArea
                circle={{ slug: "the-cold-room", name: "The Cold Room" }}
                placesLeft={s.placesLeft}
                capacity={12}
                state={s.state}
              />
            </div>
          ))}
        </div>
      </Section>

      <Section index={11} label="Checkout" title="The mock payment step">
        <CheckoutSummary
          circleName="The Cold Room"
          passName="Season"
          credits={6}
          price="€330"
          perGathering="6 gatherings · €55 each"
          action="/circles/the-cold-room/passes/season/buy"
          nonce="7f3a91c0d2"
          next="/events/pump-house-tuesday"
        />
      </Section>

      <Section index={12} label="Ticket" title="The issued document">
        <TicketPlate
          seed="pump-house-tuesday"
          code="2CC-K7QF-2M"
          title="Tuesday in the pump house"
          circleName="The Cold Room"
          when="Tue 25 Aug · 06:30–08:05"
          venue="Hornstulls pumphus"
          address="Bergsunds strand 33, 117 38 Stockholm"
          passName="Trio · 2 credits left"
          bring="Towel, sandals, no phone"
          cancelBy="Mon 24 Aug · 18:00"
        />
      </Section>

      <Section index={13} label="Small pieces" title="The rest of the kit">
        <div class="stack stack--wide">
          <SectionIndex index="03" label="Gatherings" />

          <p class="prose">
            Buttons, status text, metadata, stats and the avatar, shown together so a regression is
            obvious. The long unbroken token that follows proves nothing pushes the page sideways at
            375px: Reykjavikursundhollarvetrarsundfelagsformadurinn
          </p>

          <div class="row">
            <Button variant="primary" type="submit">
              Confirm your place
            </Button>
            <Button variant="ghost" type="button">
              Request an invitation
            </Button>
            <Button variant="quiet" href="/events">
              All gatherings
            </Button>
            <Button variant="ghost" disabled={true}>
              Full
            </Button>
          </div>

          <div class="row">
            <Badge tone="brass">4 left</Badge>
            <Badge tone="warn">1 left</Badge>
            <Badge tone="rust">Cancelled</Badge>
            <Badge tone="slate">Pending</Badge>
            <Badge>Full</Badge>
            <Avatar name="Amara Okonjo" />
            <Meta bright={true}>Stockholm · Sweden</Meta>
            <Meta num={true}>31 members</Meta>
          </div>

          <div class="row" style="gap:48px">
            <Stat label="Places left" value={4} tone="brass" />
            <Stat label="Members" value={31} />
            <Stat label="Cities" value={11} />
          </div>

          <Divider />

          <div class="stack">
            <Alert tone="brass">One credit will be spent when you confirm this booking.</Alert>
            <Alert>Your request to join The Cold Room is with Tomas.</Alert>
            <Alert tone="warn">One place left. Cancelling after Monday 18:00 keeps the credit spent.</Alert>
            <Alert tone="rust">That gathering is full. Nothing was charged.</Alert>
          </div>

          <Divider />

          <form class="column-420" method="post" action="/auth/login">
            <p class="invitation" style="margin-block-end:32px">
              You have been invited to join. Two fields, and you are in.
            </p>
            <Field
              label="Full name"
              name="name"
              value="Amara Okonjo"
              required={true}
              autocomplete="name"
            />
            <Field
              label="Email"
              name="email"
              type="email"
              placeholder="you@example.com"
              required={true}
              autocomplete="email"
              inputmode="email"
              enterkeyhint="go"
              autocapitalize="off"
              spellcheck={false}
              hint="No password. We send nothing but your ticket."
            />
            <Field
              label="Invitation code"
              name="code"
              code={true}
              value="COLD-2026"
              error="That code has already been used."
            />
            <Field
              label="Anything the host should know"
              name="note"
              multiline={true}
              rows={3}
              placeholder="Injuries, dietary needs, arrival time"
            />
            <div style="margin-block-start:32px">
              <Button type="submit" variant="primary">
                Accept the invitation
              </Button>
            </div>
          </form>

          <Divider />

          <EmptyState
            title="No gatherings scheduled"
            note="Tomas posts the winter calendar in October."
            action={{ href: "/circles", label: "Other circles" }}
          />
        </div>
      </Section>

      <Container>
        <Meta>Every exported component above, on dummy data.</Meta>
      </Container>
    </Layout>
  );
}

/**
 * The kitchen-sink page as one HTML string. Synchronous — every component here
 * is a plain function, so this never needs a server or a request.
 */
export function renderPreview(): string {
  const node = (<PreviewPage />) as unknown as { toString(): string | Promise<string> };
  const rendered = node.toString();
  if (typeof rendered !== "string") {
    throw new Error("preview rendered asynchronously; expected a synchronous string");
  }
  return rendered;
}

/** Mountable sub-app: `app.route("/__preview", preview)`. */
const preview = new Hono();

preview.get("/", (c) => c.html(renderPreview()));

export default preview;
