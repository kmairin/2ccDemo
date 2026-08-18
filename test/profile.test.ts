/**
 * Member profiles, and buying one ticket.
 *
 * Driven through `app.request()` against the REAL local Postgres, the same way
 * `test/pages.test.ts` and `test/api.test.ts` are. The purchase tests count
 * rows before and after with SQL rather than trusting the redirect: "it 302'd"
 * and "an order and a booking exist" are different claims, and only the second
 * one is the feature.
 *
 * They need Postgres running and `npm run seed` applied. Every member these
 * tests create is prefixed `profiletest-`, and `afterAll` unwinds their
 * bookings, passes, orders and memberships by hand before deleting them — the
 * FKs from `passes` to `orders` and from `bookings` to `passes` carry no
 * ON DELETE, so a cascade from `users` leaves orphans behind (the same reason
 * `test/flows.test.ts` unwinds by hand). The seed is left as it was found.
 */
import { jsx } from "hono/jsx";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { ActionArea, type PassOffer } from "../src/ui/booking";
import { AttendeeList, MemberList, type PersonEntry } from "../src/ui/people";
import { hasDatabase } from "./support/database";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/loop_dev";

/** The env a handler sees locally: no data-service binding, so `src/db.ts` dials Postgres. */
const env = { DATABASE_URL };

const sql = postgres(DATABASE_URL, { max: 1 });

const suite = hasDatabase ? describe : describe.skip;

/**
 * One value per run, so a nonce is stable inside a test (that is what the
 * replay test needs) and never collides with the run before it. The nonce is
 * spent into `orders.reference`, which is uniquely indexed — a fixed literal
 * would make the second run of this file look like a replay of the first.
 */
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Every member these tests create, so `afterAll` can take their rows with them. */
const created: string[] = [];

afterAll(async () => {
  // No database in CI, so there is nothing to unwind — and running these
  // deletes anyway fails the whole file before a single test is skipped.
  if (!hasDatabase) return;
  if (hasDatabase && created.length > 0) {
    // Dependency order, by hand: the FKs from `passes` to `orders` and from
    // `bookings` to `passes` have no ON DELETE, so a cascade from `users` is
    // not safe here. Same reason `test/flows.test.ts` unwinds by hand.
    await sql`delete from bookings where user_id = any(${created})`;
    await sql`delete from passes where user_id = any(${created})`;
    await sql`delete from orders where user_id = any(${created})`;
    await sql`delete from circle_members where user_id = any(${created})`;
  }
  await sql`delete from users where email like 'profiletest-%'`;
  await sql.end();
});

const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function get(
  path: string,
  cookie?: string,
): Promise<{ status: number; html: string; res: Response }> {
  const res = await app.request(path, cookie ? { headers: { cookie } } : {}, env);
  return { status: res.status, html: await res.text(), res };
}

async function post(
  path: string,
  fields: Record<string, string>,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = { ...FORM };
  if (cookie) headers.cookie = cookie;
  return app.request(
    path,
    { method: "POST", headers, body: new URLSearchParams(fields).toString() },
    env,
  );
}

function sessionCookie(res: Response): string {
  const raw = res.headers.get("set-cookie");
  expect(raw, "no session cookie was set").toBeTruthy();
  return raw!.split(";")[0]!;
}

/** Sign a throwaway member in and hand back their cookie and their id. */
async function signUp(name: string): Promise<{ cookie: string; id: string; email: string }> {
  const email = `profiletest-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const res = await post("/auth/login", { email, name });
  expect(res.status).toBe(302);
  const [row] = await sql<{ id: string }[]>`select id from users where email = ${email}`;
  expect(row, "the member was not created").toBeTruthy();
  created.push(row!.id);
  return { cookie: sessionCookie(res), id: row!.id, email };
}

/** Render a component to HTML without JSX syntax — this file is a `.ts`. */
function render(node: unknown): string {
  const html = String(node);
  expect(html, "component rendered asynchronously").not.toContain("[object Promise]");
  return html;
}

/* ------------------------------------------------------- the public profile */

suite("GET /members/:id", () => {
  it("shows a member's name, line, city and note, and never their email", async () => {
    const [seeded] = await sql<
      { id: string; email: string; name: string; headline: string; city: string; bio: string }[]
    >`select id, email, name, headline, city, bio from users
        where email = 'member@2cc.club' limit 1`;
    expect(seeded, "seed the database first: npm run seed").toBeTruthy();
    const member = seeded!;

    const { status, html, res } = await get(`/members/${member.id}`);
    expect(status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");

    expect(html).toContain(member.name);
    expect(html).toContain(member.headline);
    expect(html).toContain(member.city);
    expect(html).toContain(member.bio.slice(0, 40));

    // The one thing this page must never carry.
    expect(html).not.toContain(member.email);
  });

  it("lists the circles they are approved in, and never a pending request", async () => {
    const [seeded] = await sql<{ id: string }[]>`
      select id from users where email = 'member@2cc.club' limit 1`;
    const rows = await sql<{ slug: string; status: string }[]>`
      select c.slug, cm.status from circle_members cm
        join circles c on c.id = cm.circle_id
       where cm.user_id = ${seeded!.id}`;
    const approved = rows.filter((r) => r.status === "approved");
    const pending = rows.filter((r) => r.status === "pending");
    expect(approved.length, "seed has no approved membership to check").toBeGreaterThan(0);

    const { html } = await get(`/members/${seeded!.id}`);
    for (const row of approved) expect(html).toContain(`/circles/${row.slug}`);
    for (const row of pending) expect(html).not.toContain(`/circles/${row.slug}`);
  });

  it("lists the gatherings they hold a confirmed place at", async () => {
    const [seeded] = await sql<{ id: string }[]>`
      select id from users where email = 'member@2cc.club' limit 1`;
    const booked = await sql<{ slug: string }[]>`
      select e.slug from bookings b
        join events e on e.id = b.event_id
       where b.user_id = ${seeded!.id} and b.status = 'confirmed'
         and e.status = 'published' and e.starts_at >= now()`;

    const { html } = await get(`/members/${seeded!.id}`);
    for (const row of booked) expect(html).toContain(`/events/${row.slug}`);
  });

  it("is a styled 404 for an id nobody has", async () => {
    const { status, html } = await get("/members/not-a-real-member");
    expect(status).toBe(404);
    expect(html).toContain("No such member");
    // A styled page, not the JSON fallthrough.
    expect(html).toContain("<html");
  });
});

/* -------------------------------------------------------------- the JSON */

suite("GET /api/members/:id", () => {
  it("returns the member, their communities and what they are attending", async () => {
    const [seeded] = await sql<{ id: string; email: string; name: string }[]>`
      select id, email, name from users where email = 'member@2cc.club' limit 1`;
    const res = await app.request(`/api/members/${seeded!.id}`, {}, env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      member: { id: string; name: string; headline: string | null; city: string | null; bio: string | null };
      communities: { slug: string; role: string }[];
      attending: { slug: string; startsAt: string }[];
    };

    expect(Object.keys(body.member).sort()).toEqual(["bio", "city", "headline", "id", "name"]);
    expect(body.member.id).toBe(seeded!.id);
    expect(body.member.name).toBe(seeded!.name);
    expect(Array.isArray(body.communities)).toBe(true);
    expect(Array.isArray(body.attending)).toBe(true);

    // Belt and braces: no email anywhere in the payload, at any depth.
    expect(JSON.stringify(body)).not.toContain(seeded!.email);
    expect(JSON.stringify(body)).not.toContain("@2cc.club");
  });

  it("404s an unknown id and 400s a bad limit", async () => {
    const missing = await app.request("/api/members/nope", {}, env);
    expect(missing.status).toBe(404);

    const [seeded] = await sql<{ id: string }[]>`
      select id from users where email = 'member@2cc.club' limit 1`;
    const bad = await app.request(`/api/members/${seeded!.id}?limit=0`, {}, env);
    expect(bad.status).toBe(400);
  });
});

/* ----------------------------------------------------------- the edit form */

suite("/account/profile", () => {
  it("sends a signed-out visitor to the join form", async () => {
    const res = await app.request("/account/profile", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/join?next=${encodeURIComponent("/account/profile")}`);
  });

  it("opens pre-filled with what the member already has", async () => {
    const me = await signUp("Profile Reader");
    await sql`update users set headline = 'Skipper, two crossings', city = 'Porto', bio = 'Sails in March.' where id = ${me.id}`;

    const { status, html } = await get("/account/profile", me.cookie);
    expect(status).toBe(200);
    expect(html).toContain('value="Profile Reader"');
    expect(html).toContain('value="Skipper, two crossings"');
    expect(html).toContain('value="Porto"');
    expect(html).toContain("Sails in March.");
  });

  it("saves, 302s, and the public profile shows the new values", async () => {
    const me = await signUp("Profile Writer");

    const res = await post(
      "/account/profile",
      {
        name: "Profile Writer",
        headline: "Distiller, Reid & Sons",
        city: "Edinburgh",
        bio: "Fills casks by hand on Thursdays. Turns up for anything on cold water.",
      },
      me.cookie,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/account/profile");

    const [row] = await sql<{ name: string; headline: string; city: string; bio: string }[]>`
      select name, headline, city, bio from users where id = ${me.id}`;
    expect(row!.headline).toBe("Distiller, Reid & Sons");
    expect(row!.city).toBe("Edinburgh");
    expect(row!.bio).toContain("Fills casks by hand");

    const { html } = await get(`/members/${me.id}`);
    expect(html).toContain("Distiller, Reid &amp; Sons");
    expect(html).toContain("Edinburgh");
  });

  it("stores a blank optional field as null rather than an empty string", async () => {
    const me = await signUp("Profile Blanker");
    await sql`update users set headline = 'Something', city = 'Somewhere', bio = 'Something else.' where id = ${me.id}`;

    const res = await post(
      "/account/profile",
      { name: "Profile Blanker", headline: "", city: "", bio: "" },
      me.cookie,
    );
    expect(res.status).toBe(302);

    const [row] = await sql<{ headline: string | null; city: string | null; bio: string | null }[]>`
      select headline, city, bio from users where id = ${me.id}`;
    expect(row!.headline).toBeNull();
    expect(row!.city).toBeNull();
    expect(row!.bio).toBeNull();
  });

  it("re-renders with 400, everything typed still in it, when the name is missing", async () => {
    const me = await signUp("Profile Blank Name");

    const res = await post(
      "/account/profile",
      { name: "   ", headline: "Naval architect", city: "Copenhagen", bio: "Draws hulls." },
      me.cookie,
    );
    expect(res.status).toBe(400);

    const html = await res.text();
    expect(html).toContain("A name is needed.");
    expect(html).toContain("aria-invalid=\"true\"");
    // Nothing typed is lost.
    expect(html).toContain('value="Naval architect"');
    expect(html).toContain('value="Copenhagen"');
    expect(html).toContain("Draws hulls.");

    // And nothing was written.
    const [row] = await sql<{ name: string }[]>`select name from users where id = ${me.id}`;
    expect(row!.name).toBe("Profile Blank Name");
  });

  it("refuses a headline over 80 characters and a note over 600", async () => {
    const me = await signUp("Profile Overlong");

    const long = await post(
      "/account/profile",
      { name: "Profile Overlong", headline: "x".repeat(81), city: "", bio: "" },
      me.cookie,
    );
    expect(long.status).toBe(400);
    expect(await long.text()).toContain("longer than 80 characters");

    const wordy = await post(
      "/account/profile",
      { name: "Profile Overlong", headline: "", city: "", bio: "y".repeat(601) },
      me.cookie,
    );
    expect(wordy.status).toBe(400);
    expect(await wordy.text()).toContain("longer than 600 characters");

    // 80 and 600 exactly are fine — the boundary is inclusive.
    const ok = await post(
      "/account/profile",
      { name: "Profile Overlong", headline: "x".repeat(80), city: "", bio: "y".repeat(600) },
      me.cookie,
    );
    expect(ok.status).toBe(302);
  });

  it("is linked from the account page", async () => {
    const me = await signUp("Profile Linked");
    const { html } = await get("/account", me.cookie);
    expect(html).toContain('href="/account/profile"');
  });
});

/* ------------------------------------------------- the people lists link out */

describe("the member and attendee lists", () => {
  const withId: PersonEntry = {
    id: "u-1",
    name: "Latifa Al Marri",
    headline: "UAE national padel squad",
    city: "Dubai",
  };
  const withoutId: PersonEntry = { name: "Marcus Osei", headline: "Structural engineer" };

  it("links a member to their profile when it is given an id", () => {
    const html = render(jsx(MemberList, { members: [withId], total: 1 }));
    expect(html).toContain('href="/members/u-1"');
    expect(html).toContain("Latifa Al Marri");
  });

  it("links an attendee to their profile when it is given an id", () => {
    const html = render(jsx(AttendeeList, { attendees: [withId], going: 1, capacity: 12 }));
    expect(html).toContain('href="/members/u-1"');
  });

  it("renders the name as plain text when there is no id to link to", () => {
    const html = render(jsx(MemberList, { members: [withoutId], total: 1 }));
    expect(html).toContain("Marcus Osei");
    expect(html).not.toContain("/members/");
  });
});

/* ---------------------------------------------- the single ticket, in the UI */

describe("the gathering action area, for a member with no credits", () => {
  const offers = (slug: string): PassOffer[] => {
    const next = `?next=${encodeURIComponent(`/events/${slug}`)}`;
    return [
      {
        id: "single",
        name: "Single",
        credits: 1,
        price: "€135",
        derivation: "1 gathering",
        href: `/circles/cap-ferrat/passes/single/checkout${next}`,
      },
      {
        id: "trio",
        name: "Trio",
        credits: 3,
        price: "€360",
        derivation: "3 gatherings · €120 each",
        href: `/circles/cap-ferrat/passes/trio/checkout${next}`,
      },
      {
        id: "season",
        name: "Season",
        credits: 6,
        price: "€660",
        derivation: "6 gatherings · €110 each",
        href: `/circles/cap-ferrat/passes/season/checkout${next}`,
      },
    ];
  };

  const area = (passes: PassOffer[]) =>
    render(
      jsx(ActionArea, {
        circle: { slug: "cap-ferrat", name: "Cap Ferrat Sailing Society" },
        placesLeft: 4,
        capacity: 12,
        state: { kind: "no-credits", passes },
      }),
    );

  it("offers the single ticket first, and the bigger passes underneath", () => {
    const html = area(offers("shakedown-sail"));
    expect(html).toContain("Buy a ticket — €135");
    expect(html).toContain('action="/events/shakedown-sail/ticket"');
    expect(html).toContain('name="nonce"');
    expect(html).toContain("or save with 3 or 6");
    // The 1-credit pass is not repeated as a pass button beneath its own ticket.
    expect(html).not.toContain("Single · €135");
  });

  it("carries a fresh nonce on every render, so a double tap collides", () => {
    const one = /name="nonce" value="([^"]+)"/.exec(area(offers("shakedown-sail")));
    const two = /name="nonce" value="([^"]+)"/.exec(area(offers("shakedown-sail")));
    expect(one?.[1]).toBeTruthy();
    expect(one?.[1]).not.toBe(two?.[1]);
  });

  it("falls back to the pass buttons when the circle sells no 1-credit pass", () => {
    const html = area(offers("shakedown-sail").filter((p) => p.credits > 1));
    expect(html).not.toContain("Buy a ticket");
    expect(html).toContain("You need a credit.");
    expect(html).toContain("Trio · €360 · 3 credits");
  });

  it("offers nothing to buy in one step when the links do not name a gathering", () => {
    const noNext = offers("shakedown-sail").map((p) => ({ ...p, href: p.href.split("?")[0]! }));
    const html = area(noNext);
    expect(html).not.toContain("Buy a ticket");
    expect(html).toContain("You need a credit.");
  });
});

/* ------------------------------------------- the single ticket, end to end */

/** A public circle that sells a 1-credit pass and has a gathering with room. */
async function bookableTarget(): Promise<{
  circleSlug: string;
  eventSlug: string;
  priceCents: number;
}> {
  const [row] = await sql<{ circleSlug: string; eventSlug: string; priceCents: number }[]>`
    select c.slug as "circleSlug", e.slug as "eventSlug", p.price_cents as "priceCents"
      from events e
      join circles c on c.id = e.circle_id
      join packages p on p.circle_id = c.id and p.credits = 1 and p.active
     where e.status = 'published'
       and c.is_private = false
       and e.capacity > (select count(*) from bookings b
                          where b.event_id = e.id and b.status = 'confirmed')
     order by e.starts_at
     limit 1`;
  expect(row, "seed has no open gathering on a public circle").toBeTruthy();
  return { ...row!, priceCents: Number(row!.priceCents) };
}

suite("POST /events/:slug/ticket", () => {
  it("sends a signed-out visitor to the join form", async () => {
    const { eventSlug } = await bookableTarget();
    const res = await app.request(
      `/events/${eventSlug}/ticket`,
      { method: "POST", headers: FORM, body: "" },
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/join?next=");
  });

  it("404s a gathering nobody has heard of", async () => {
    const me = await signUp("Ticket Ghost");
    const res = await post("/events/not-a-real-gathering/ticket", {}, me.cookie);
    expect(res.status).toBe(404);
  });

  it("buys the 1-credit pass and books, in one submit", async () => {
    const { circleSlug, eventSlug, priceCents } = await bookableTarget();
    const me = await signUp("Ticket Buyer");

    // A member of the circle, holding nothing.
    expect((await post(`/circles/${circleSlug}/join`, {}, me.cookie)).status).toBe(302);

    const before = await ticketCounts(me.id, eventSlug);
    expect(before.orders).toBe(0);
    expect(before.bookings).toBe(0);

    const res = await post(`/events/${eventSlug}/ticket`, { nonce: `profiletest-nonce-${RUN}` }, me.cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/account\/tickets\/2CC-TKT-/);

    const after = await ticketCounts(me.id, eventSlug);
    expect(after.orders).toBe(1);
    expect(after.bookings).toBe(1);
    expect(after.attendees).toBe(before.attendees + 1);
    expect(after.paidCents).toBe(priceCents);
    // One credit bought, one credit spent — the pass is empty, not unspent.
    expect(after.creditsTotal).toBe(1);
    expect(after.creditsUsed).toBe(1);
  });

  it("creates no second order when the same form is submitted twice", async () => {
    const { circleSlug, eventSlug } = await bookableTarget();
    const me = await signUp("Ticket Double Tap");
    await post(`/circles/${circleSlug}/join`, {}, me.cookie);

    const nonce = `profiletest-replay-${RUN}`;
    const first = await post(`/events/${eventSlug}/ticket`, { nonce }, me.cookie);
    expect(first.status).toBe(302);
    const once = await ticketCounts(me.id, eventSlug);

    const replay = await post(`/events/${eventSlug}/ticket`, { nonce }, me.cookie);
    expect(replay.status).toBe(302);
    const twice = await ticketCounts(me.id, eventSlug);

    expect(twice.orders).toBe(once.orders);
    expect(twice.bookings).toBe(once.bookings);
    expect(twice.attendees).toBe(once.attendees);
    expect(twice.paidCents).toBe(once.paidCents);
  });

  it("refuses on a private circle the member has not been approved for", async () => {
    const [row] = await sql<{ eventSlug: string }[]>`
      select e.slug as "eventSlug" from events e
        join circles c on c.id = e.circle_id
       where c.is_private = true and e.status = 'published'
       limit 1`;
    if (!row) return; // the seed always has one, but do not invent a failure if it does not.

    const me = await signUp("Ticket Gatecrasher");
    const res = await post(`/events/${row.eventSlug}/ticket`, {}, me.cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/events/${row.eventSlug}`);

    const [orders] = await sql<{ n: string }[]>`
      select count(*) as n from orders where user_id = ${me.id}`;
    expect(Number(orders!.n)).toBe(0);
  });
});

/** Everything the purchase is supposed to move, counted straight from SQL. */
async function ticketCounts(
  userId: string,
  eventSlug: string,
): Promise<{
  orders: number;
  bookings: number;
  attendees: number;
  paidCents: number;
  creditsTotal: number;
  creditsUsed: number;
}> {
  const [row] = await sql<
    {
      orders: string;
      bookings: string;
      attendees: string;
      paid: string;
      total: string;
      used: string;
    }[]
  >`
    select
      (select count(*) from orders o where o.user_id = ${userId} and o.status = 'paid') as orders,
      (select count(*) from bookings b
         join events e on e.id = b.event_id
        where b.user_id = ${userId} and e.slug = ${eventSlug} and b.status = 'confirmed') as bookings,
      (select count(*) from bookings b
         join events e on e.id = b.event_id
        where e.slug = ${eventSlug} and b.status = 'confirmed') as attendees,
      (select coalesce(sum(o.amount_cents), 0) from orders o
        where o.user_id = ${userId} and o.status = 'paid') as paid,
      (select coalesce(sum(p.credits_total), 0) from passes p where p.user_id = ${userId}) as total,
      (select coalesce(sum(p.credits_used), 0) from passes p where p.user_id = ${userId}) as used`;

  return {
    orders: Number(row!.orders),
    bookings: Number(row!.bookings),
    attendees: Number(row!.attendees),
    paidCents: Number(row!.paid),
    creditsTotal: Number(row!.total),
    creditsUsed: Number(row!.used),
  };
}
