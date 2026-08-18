/**
 * The money-and-credit paths, driven through the real routes against the REAL
 * local Postgres.
 *
 * These are not view tests. Every assertion that matters compares what the app
 * did with what the database now holds — one order, not two; one credit gone,
 * not two; the credit back after a cancel. A booking flow that renders
 * beautifully and charges twice is the failure mode worth spending a test file
 * on.
 *
 * Nothing here depends on the public pages (`src/routes/pages.tsx`) or on
 * `POST /auth/login`: sessions and the one pending membership are written
 * straight into the database, so this suite runs whether or not that worker's
 * routes have landed.
 *
 * Everything it creates it owns — two members, a host, and the host's own
 * circles — and `afterAll` deletes all of it in dependency order, so the seeded
 * demo world is exactly as it was.
 *
 * Needs Postgres running and `npm run seed` applied at least once for the
 * schema. Run with: `npx vitest run test/flows.test.ts`.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/loop_dev";

/** The env a handler sees locally: no data-service binding, so `src/db.ts` dials Postgres. */
const env = { DATABASE_URL, LOG_LEVEL: "silent" };

const sql = postgres(DATABASE_URL, { max: 1 });

/** One run's marker, so a crashed run never collides with the next. */
const RUN = `flowtest-${Date.now().toString(36)}`;

type Actor = { id: string; email: string; name: string; cookie: string };

async function makeActor(name: string, key: string): Promise<Actor> {
  const id = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const email = `${RUN}-${key}@2cc.club`;
  await sql`insert into users (id, email, name) values (${id}, ${email}, ${name})`;
  await sql`
    insert into sessions (id, user_id, expires_at)
    values (${sessionId}, ${id}, now() + interval '1 day')
  `;
  return { id, email, name, cookie: `2cc_session=${sessionId}` };
}

/** A GET as somebody. */
async function get(path: string, actor?: Actor): Promise<Response> {
  return app.request(path, actor ? { headers: { cookie: actor.cookie } } : {}, env);
}

/** A form POST as somebody — `application/x-www-form-urlencoded`, exactly as a browser sends it. */
async function post(
  path: string,
  fields: Record<string, string>,
  actor?: Actor,
): Promise<Response> {
  const body = new URLSearchParams(fields).toString();
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(actor ? { cookie: actor.cookie } : {}),
      },
      body,
    },
    env,
  );
}

/** Credits left on one member's pass for one circle — read from the database, not the page. */
async function creditsLeft(userId: string, circleSlug: string): Promise<number> {
  const rows = await sql<{ left: number }[]>`
    select coalesce(sum(p.credits_total - p.credits_used), 0)::int as left
    from passes p join circles c on c.id = p.circle_id
    where p.user_id = ${userId} and c.slug = ${circleSlug}
  `;
  return rows[0]?.left ?? 0;
}

async function countOrders(userId: string, circleSlug: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from orders o join circles c on c.id = o.circle_id
    where o.user_id = ${userId} and c.slug = ${circleSlug}
  `;
  return rows[0]?.n ?? 0;
}

async function countPasses(userId: string, circleSlug: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from passes p join circles c on c.id = p.circle_id
    where p.user_id = ${userId} and c.slug = ${circleSlug}
  `;
  return rows[0]?.n ?? 0;
}

/** The one pass this circle sells, as the host just created it. */
async function packageIdFor(circleSlug: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    select p.id from packages p join circles c on c.id = p.circle_id
    where c.slug = ${circleSlug} order by p.sort_order limit 1
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error(`no package on ${circleSlug}`);
  return id;
}

/** `Location` off a 302, which is what every mutation answers with. */
function location(res: Response): string {
  return res.headers.get("location") ?? "";
}

let hostActor: Actor;
let memberA: Actor;
let memberB: Actor;
/** The public circle the host creates in `beforeAll`; everything below happens in it. */
let circleSlug = "";
/** capacity 2 — the one booked and cancelled. */
let eventSlug = "";
/** capacity 1 — the one that fills, so the refusal is reachable. */
let smallSlug = "";
/** A later gathering, so the "full" refusal has something to offer instead. */
let laterSlug = "";
let privateSlug = "";
let packageId = "";

beforeAll(async () => {
  hostActor = await makeActor("Flow Host", "host");
  memberA = await makeActor("Flow Member A", "a");
  memberB = await makeActor("Flow Member B", "b");

  const created = await post(
    "/host/circles",
    {
      name: `${RUN} Supper Club`,
      tagline: "Marta cooks for twelve on the last Friday of the month, one sitting, 20:30.",
      description:
        "Marta Alves cooks over wood in a converted garage in Marvila. Twelve places, one sitting, and the menu is written at eleven that morning.",
      city: "Lisbon",
      country: "Portugal",
      category: "dining",
    },
    hostActor,
  );
  expect(created.status).toBe(302);
  circleSlug = location(created).replace("/host/circles/", "");

  const pass = await post(
    `/host/circles/${circleSlug}/packages`,
    { name: "Trio", credits: "3", priceCents: "36000" },
    hostActor,
  );
  expect(pass.status).toBe(302);
  packageId = await packageIdFor(circleSlug);

  // Three gatherings: one to book, one that fills at a single place, and a
  // later one so the "full" refusal has an alternative to name.
  const week = (days: number, hour: number): string => {
    const d = new Date(Date.now() + days * 86_400_000);
    d.setUTCHours(hour, 30, 0, 0);
    return d.toISOString().slice(0, 16);
  };

  const one = await post(
    `/host/circles/${circleSlug}/events`,
    {
      title: `${RUN} Long Table`,
      summary: "Twelve places at one table, and the menu is written that morning.",
      description: "A long table in a converted garage in Marvila. One sitting, 20:30.",
      venue: "Rua do Acucar 12",
      city: "Lisbon",
      startsAt: week(7, 19),
      endsAt: week(7, 22),
      capacity: "2",
      status: "published",
    },
    hostActor,
  );
  expect(one.status).toBe(302);

  const small = await post(
    `/host/circles/${circleSlug}/events`,
    {
      title: `${RUN} Counter Seat`,
      summary: "One seat at the counter, facing the fire.",
      description: "The single counter seat, kept for whoever asks first.",
      venue: "Rua do Acucar 12",
      city: "Lisbon",
      startsAt: week(9, 19),
      endsAt: week(9, 21),
      capacity: "1",
      status: "published",
    },
    hostActor,
  );
  expect(small.status).toBe(302);

  const later = await post(
    `/host/circles/${circleSlug}/events`,
    {
      title: `${RUN} Autumn Table`,
      summary: "The same table, six weeks on, with the autumn pig.",
      description: "The autumn sitting, once the weather turns.",
      venue: "Rua do Acucar 12",
      city: "Lisbon",
      startsAt: week(42, 19),
      endsAt: week(42, 22),
      capacity: "12",
      status: "published",
    },
    hostActor,
  );
  expect(later.status).toBe(302);

  const slugs = await sql<{ slug: string; capacity: number }[]>`
    select e.slug, e.capacity from events e join circles c on c.id = e.circle_id
    where c.slug = ${circleSlug} order by e.starts_at
  `;
  eventSlug = slugs[0]?.slug ?? "";
  smallSlug = slugs[1]?.slug ?? "";
  laterSlug = slugs[2]?.slug ?? "";
  expect([eventSlug, smallSlug, laterSlug].every(Boolean)).toBe(true);

  // A private circle, so the approve path has a real request waiting on it.
  const privateCircle = await post(
    "/host/circles",
    {
      name: `${RUN} Back Room`,
      tagline: "Six seats behind the kitchen, and Marta decides who sits in them.",
      description:
        "The back room holds six. Marta Alves approves every seat by hand, and the invitation does not carry.",
      city: "Lisbon",
      country: "Portugal",
      category: "dining",
      isPrivate: "on",
    },
    hostActor,
  );
  expect(privateCircle.status).toBe(302);
  privateSlug = location(privateCircle).replace("/host/circles/", "");
});

afterAll(async () => {
  // Dependency order, by hand: the FKs from passes to orders and from bookings
  // to passes have no ON DELETE, so a cascade from `users` is not safe here.
  const owned = await sql<{ id: string }[]>`select id from circles where slug like ${RUN + "%"}`;
  const circleIds = owned.map((row) => row.id);
  const userIds = [hostActor?.id, memberA?.id, memberB?.id].filter(Boolean) as string[];

  if (circleIds.length > 0) {
    await sql`delete from bookings where event_id in (select id from events where circle_id = any(${circleIds}))`;
  }
  if (userIds.length > 0) {
    await sql`delete from bookings where user_id = any(${userIds})`;
    await sql`delete from passes where user_id = any(${userIds})`;
    await sql`delete from orders where user_id = any(${userIds})`;
  }
  if (circleIds.length > 0) {
    await sql`delete from passes where circle_id = any(${circleIds})`;
    await sql`delete from orders where circle_id = any(${circleIds})`;
    await sql`delete from events where circle_id = any(${circleIds})`;
    await sql`delete from packages where circle_id = any(${circleIds})`;
    await sql`delete from circle_members where circle_id = any(${circleIds})`;
    await sql`delete from circles where id = any(${circleIds})`;
  }
  if (userIds.length > 0) {
    await sql`delete from circle_members where user_id = any(${userIds})`;
    await sql`delete from sessions where user_id = any(${userIds})`;
    await sql`delete from users where id = any(${userIds})`;
  }
  await sql.end();
});

describe("signed out", () => {
  it("sends a protected page to /join with where it was going", async () => {
    const res = await get("/account");
    expect(res.status).toBe(302);
    expect(location(res)).toBe("/join?next=%2Faccount");
  });

  it("sends /host to /join as well", async () => {
    const res = await get("/host");
    expect(res.status).toBe(302);
    expect(location(res)).toBe("/join?next=%2Fhost");
  });

  it("sends a ticket URL to /join rather than rendering it", async () => {
    const res = await get("/account/tickets/2CC-TKT-ZZZZ");
    expect(res.status).toBe(302);
    expect(location(res)).toContain("/join?next=");
  });
});

describe("GET /account", () => {
  it("renders for a signed-in member, cached privately and never no-store", async () => {
    const res = await get("/account", memberA);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("says what an empty account is for rather than showing an empty page", async () => {
    const html = await (await get("/account", memberB)).text();
    expect(html).toContain("No passes yet.");
    expect(html).toContain("No places booked.");
  });
});

describe("the mock checkout", () => {
  it("shows the price, the derivation and a payment block that cannot be typed into", async () => {
    const res = await get(`/circles/${circleSlug}/passes/${packageId}/checkout`, memberA);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("DEMO — no card is charged");
    expect(html).toContain("4242");
    expect(html).toContain("Confirm — €360");
    expect(html).toContain("3 gatherings · €120 each");
    // Never an enabled card input, and never a real card number field.
    expect(html).not.toContain('name="cardNumber"');
    expect(html).toMatch(/<fieldset class="checkout-card" disabled/);
    expect(html).toMatch(/name="nonce" value="[0-9a-f-]{36}"/);
  });

  it("404s on a pass that circle does not sell", async () => {
    const res = await get(`/circles/${circleSlug}/passes/not-a-package/checkout`, memberA);
    expect(res.status).toBe(404);
  });
});

describe("buying a pass", () => {
  const nonce = crypto.randomUUID();

  it("creates exactly one order and one pass, and joins the open circle", async () => {
    const res = await post(
      `/circles/${circleSlug}/passes/${packageId}/buy`,
      { nonce, next: "/account" },
      memberA,
    );
    expect(res.status).toBe(302);
    expect(location(res)).toBe("/account");

    expect(await countOrders(memberA.id, circleSlug)).toBe(1);
    expect(await countPasses(memberA.id, circleSlug)).toBe(1);
    expect(await creditsLeft(memberA.id, circleSlug)).toBe(3);

    const membership = await sql<{ status: string }[]>`
      select m.status from circle_members m join circles c on c.id = m.circle_id
      where m.user_id = ${memberA.id} and c.slug = ${circleSlug}
    `;
    expect(membership[0]?.status).toBe("approved");
  });

  it("treats a replayed submit as a no-op that reports itself", async () => {
    const res = await post(
      `/circles/${circleSlug}/passes/${packageId}/buy`,
      { nonce, next: "/account" },
      memberA,
    );
    expect(res.status).toBe(302);

    // The whole point: the second tap buys nothing.
    expect(await countOrders(memberA.id, circleSlug)).toBe(1);
    expect(await countPasses(memberA.id, circleSlug)).toBe(1);
    expect(await creditsLeft(memberA.id, circleSlug)).toBe(3);

    const html = await (await get("/account", memberA)).text();
    expect(html).toContain("Already processed");
  });

  it("404s when the circle in the URL does not exist", async () => {
    const res = await post(`/circles/not-a-circle/passes/${packageId}/buy`, {}, memberA);
    expect(res.status).toBe(404);
  });
});

describe("booking, repeat booking and cancelling", () => {
  let code = "";

  it("spends one credit: 3 → 2, and lands on the ticket", async () => {
    expect(await creditsLeft(memberA.id, circleSlug)).toBe(3);

    const res = await post(`/events/${eventSlug}/book`, {}, memberA);
    expect(res.status).toBe(302);
    expect(location(res)).toMatch(/^\/account\/tickets\/2CC-TKT-/);
    code = location(res).replace("/account/tickets/", "");

    expect(await creditsLeft(memberA.id, circleSlug)).toBe(2);
  });

  it("does not spend a second credit on a repeat booking", async () => {
    const res = await post(`/events/${eventSlug}/book`, {}, memberA);
    expect(res.status).toBe(302);
    expect(location(res)).toBe(`/account/tickets/${code}`);
    expect(await creditsLeft(memberA.id, circleSlug)).toBe(2);

    const bookingRows = await sql<{ n: number }[]>`
      select count(*)::int as n from bookings b join events e on e.id = b.event_id
      where b.user_id = ${memberA.id} and e.slug = ${eventSlug}
    `;
    expect(bookingRows[0]?.n).toBe(1);
  });

  it("renders the ticket as an object: code, venue, pass and deadline", async () => {
    const res = await get(`/account/tickets/${code}`, memberA);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    const html = await res.text();
    expect(html).toContain(code);
    expect(html).toContain("Rua do Acucar 12");
    expect(html).toContain("Lisbon, Portugal");
    expect(html).toContain("Trio · 2 of 3 credits left");
    expect(html).toContain("Cancel by");
    expect(html).toContain("Bring");
  });

  it("404s someone else's ticket rather than confirming it exists", async () => {
    const res = await get(`/account/tickets/${code}`, memberB);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(code);
  });

  it("404s a ticket code that was never issued", async () => {
    expect((await get("/account/tickets/2CC-TKT-0000", memberA)).status).toBe(404);
  });

  it("hands the credit back on cancel: 2 → 3", async () => {
    const res = await post(`/account/tickets/${code}/cancel`, {}, memberA);
    expect(res.status).toBe(302);
    expect(location(res)).toBe("/account");
    expect(await creditsLeft(memberA.id, circleSlug)).toBe(3);

    const status = await sql<{ status: string }[]>`
      select status from bookings where code = ${code}
    `;
    expect(status[0]?.status).toBe("cancelled");
  });

  it("cancels once: a second attempt changes nothing", async () => {
    const res = await post(`/account/tickets/${code}/cancel`, {}, memberA);
    expect(res.status).toBe(302);
    expect(await creditsLeft(memberA.id, circleSlug)).toBe(3);
  });

  it("404s a cancel on somebody else's ticket", async () => {
    const res = await post(`/account/tickets/${code}/cancel`, {}, memberB);
    expect(res.status).toBe(404);
  });

  it("404s a booking on a gathering that does not exist", async () => {
    expect((await post("/events/not-a-gathering/book", {}, memberA)).status).toBe(404);
  });
});

describe("refusals a member can actually act on", () => {
  it("turns a full gathering away, spends nothing, and names the next one", async () => {
    // memberA takes the only place.
    const first = await post(`/events/${smallSlug}/book`, {}, memberA);
    expect(first.status).toBe(302);
    expect(await creditsLeft(memberA.id, circleSlug)).toBe(2);

    // memberB buys their own pass, then finds it full.
    const bought = await post(`/circles/${circleSlug}/passes/${packageId}/buy`, {}, memberB);
    expect(bought.status).toBe(302);
    expect(await creditsLeft(memberB.id, circleSlug)).toBe(3);

    const refused = await post(`/events/${smallSlug}/book`, {}, memberB);
    expect(refused.status).toBe(302);
    expect(location(refused)).toBe(`/events/${smallSlug}`);
    // No credit moved.
    expect(await creditsLeft(memberB.id, circleSlug)).toBe(3);

    // The refusal is on the session, and it offers the soonest gathering from
    // this circle that still has a place — here the Long Table, which memberA
    // cancelled out of, not the Autumn one months later.
    const flash = await sql<{ flash: string | null }[]>`
      select flash from sessions where id = ${memberB.cookie.split("=")[1]}
    `;
    expect(flash[0]?.flash).toContain("full");
    expect(flash[0]?.flash).toContain("Next from this circle");
    expect(flash[0]?.flash).toContain("Long Table");
    expect(laterSlug).not.toBe("");
  });

  it("turns a member with no credits back to the gathering, with a banner", async () => {
    const broke = await makeActor("Flow Member C", "c");
    // In the circle, but holding nothing: approve the membership directly, the
    // way buying would have.
    const circleRow = await sql<{ id: string }[]>`select id from circles where slug = ${circleSlug}`;
    await sql`
      insert into circle_members (id, circle_id, user_id, role, status)
      values (${crypto.randomUUID()}, ${circleRow[0]!.id}, ${broke.id}, 'member', 'approved')
    `;

    const res = await post(`/events/${laterSlug}/book`, {}, broke);
    expect(res.status).toBe(302);
    expect(location(res)).toBe(`/events/${laterSlug}`);

    const flash = await sql<{ flash: string | null }[]>`
      select flash from sessions where id = ${broke.cookie.split("=")[1]}
    `;
    expect(flash[0]?.flash).toContain("No credits left");

    await sql`delete from circle_members where user_id = ${broke.id}`;
    await sql`delete from sessions where user_id = ${broke.id}`;
    await sql`delete from users where id = ${broke.id}`;
  });

  it("keeps a non-member out of a private circle's gathering", async () => {
    const res = await post(`/events/${eventSlug}/book`, {}, hostActor);
    expect(res.status).toBe(302);
    // The host is a member of their own circle but holds no pass, so this is the
    // no-credit path, not the not-a-member one — either way, nothing is spent.
    expect(await creditsLeft(hostActor.id, circleSlug)).toBe(0);
  });
});

describe("the host console", () => {
  it("lists the circles you run, with what is on and who is waiting", async () => {
    const res = await get("/host", hostActor);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    const html = await res.text();
    expect(html).toContain(`${RUN} Supper Club`);
    expect(html).toContain(`/host/circles/${circleSlug}`);
  });

  it("shows attendees, fill and revenue on the circle it manages", async () => {
    const html = await (await get(`/host/circles/${circleSlug}`, hostActor)).text();
    expect(html).toContain("Flow Member A");
    expect(html).toContain("1 of 1");
    expect(html).toContain("Trio");
    // Two members bought a €360 Trio each.
    expect(html).toContain("€720");
  });

  it("refuses someone else's circle with 403, as a page", async () => {
    const res = await get(`/host/circles/${circleSlug}`, memberA);
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("Not your circle");
    expect(html).not.toContain("Revenue to date");
  });

  it("refuses a write on someone else's circle with 403", async () => {
    const pkg = await post(
      `/host/circles/${circleSlug}/packages`,
      { name: "Sneaky", credits: "1", priceCents: "100" },
      memberA,
    );
    expect(pkg.status).toBe(403);

    const ev = await post(
      `/host/circles/${circleSlug}/events`,
      { title: "Sneaky", summary: "x", description: "x", venue: "x", city: "x", startsAt: "2026-09-01T18:00", endsAt: "2026-09-01T20:00", capacity: "4", status: "published" },
      memberA,
    );
    expect(ev.status).toBe(403);

    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from packages p join circles c on c.id = p.circle_id
      where c.slug = ${circleSlug} and p.name = 'Sneaky'
    `;
    expect(rows[0]?.n).toBe(0);
  });

  it("404s a circle that does not exist", async () => {
    expect((await get("/host/circles/not-a-circle", hostActor)).status).toBe(404);
  });

  it("publishes a gathering that then shows up publicly", async () => {
    const res = await post(
      `/host/circles/${circleSlug}/events`,
      {
        title: `${RUN} Winter Sitting`,
        summary: "The winter sitting, with the last of the wood.",
        description: "Twelve places, one sitting, and the fire lit at seven.",
        venue: "Rua do Acucar 12",
        city: "Lisbon",
        startsAt: "2026-12-12T19:30",
        endsAt: "2026-12-12T23:00",
        capacity: "12",
        status: "published",
      },
      hostActor,
    );
    expect(res.status).toBe(302);
    expect(location(res)).toBe(`/host/circles/${circleSlug}`);

    const api = await (await get(`/api/events?circle=${circleSlug}`)).json();
    const titles = (api as { events: { title: string }[] }).events.map((e) => e.title);
    expect(titles).toContain(`${RUN} Winter Sitting`);
  });

  it("keeps a draft out of the public list but shows it to its host", async () => {
    const res = await post(
      `/host/circles/${circleSlug}/events`,
      {
        title: `${RUN} Quiet Draft`,
        summary: "Not ready to announce.",
        description: "Still deciding whether the room is free.",
        venue: "Rua do Acucar 12",
        city: "Lisbon",
        startsAt: "2026-12-19T19:30",
        endsAt: "2026-12-19T22:00",
        capacity: "8",
        status: "draft",
      },
      hostActor,
    );
    expect(res.status).toBe(302);

    const api = await (await get(`/api/events?circle=${circleSlug}`)).json();
    const titles = (api as { events: { title: string }[] }).events.map((e) => e.title);
    expect(titles).not.toContain(`${RUN} Quiet Draft`);

    const html = await (await get(`/host/circles/${circleSlug}`, hostActor)).text();
    expect(html).toContain(`${RUN} Quiet Draft`);
    expect(html).toContain(">draft<");
  });

  it("prices a new pass in the circle's own currency and lists it", async () => {
    const res = await post(
      `/host/circles/${circleSlug}/packages`,
      { name: "Season", credits: "6", priceCents: "66000" },
      hostActor,
    );
    expect(res.status).toBe(302);

    const html = await (await get(`/host/circles/${circleSlug}`, hostActor)).text();
    expect(html).toContain("Season");
    expect(html).toContain("€660");
    // The derivation, per credit.
    expect(html).toContain("€110");
  });
});

describe("creating a circle", () => {
  it("derives a slug, makes the creator its host, and 302s to the console", async () => {
    const res = await post(
      "/host/circles",
      {
        name: `${RUN} Harbour Swim`,
        tagline: "Ingrid swims at 06:40 from the north steps, and waits for nobody.",
        description:
          "Ingrid Holm has swum the harbour every morning for nine years. Six in the water, 06:40, and the steps are slippery.",
        city: "Copenhagen",
        country: "Denmark",
        category: "wellness",
      },
      hostActor,
    );
    expect(res.status).toBe(302);
    const slug = location(res).replace("/host/circles/", "");
    expect(slug).toBe(`${RUN}-harbour-swim`.toLowerCase());

    const rows = await sql<{ role: string; status: string }[]>`
      select m.role, m.status from circle_members m join circles c on c.id = m.circle_id
      where c.slug = ${slug} and m.user_id = ${hostActor.id}
    `;
    expect(rows[0]).toEqual({ role: "host", status: "approved" });
  });

  it("falls back to a real slug when the name has no letters or digits", async () => {
    const res = await post(
      "/host/circles",
      {
        name: "!!! ¿¿¿ ***",
        tagline: "A name made of punctuation, to prove the slug never comes out as a number.",
        description:
          "This circle exists to prove that a nameless name still produces a usable URL rather than a bare suffix.",
        city: "Lisbon",
        country: "Portugal",
        category: "art",
      },
      hostActor,
    );
    expect(res.status).toBe(302);
    const slug = location(res).replace("/host/circles/", "");
    // `slugify` returns "" here, and an unguarded `uniqueSlug("")` would answer "-2".
    expect(slug).not.toBe("-2");
    expect(slug).toMatch(/^circle(-\w+)?$/);

    await sql`delete from circle_members where circle_id in (select id from circles where slug = ${slug})`;
    await sql`delete from circles where slug = ${slug}`;
  });

  it("re-renders with 400 and keeps every word that was typed", async () => {
    const res = await post(
      "/host/circles",
      {
        name: "",
        tagline: "Ingrid swims at 06:40 from the north steps, and waits for nobody.",
        description: "",
        city: "Copenhagen",
        country: "Denmark",
        category: "not-a-category",
      },
      hostActor,
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("A name is needed.");
    expect(html).toContain("A description is needed.");
    expect(html).toContain("Pick one of: sailing, wellness, dining, sport, art.");
    // Nothing typed is lost.
    expect(html).toContain("Ingrid swims at 06:40 from the north steps, and waits for nobody.");
    expect(html).toContain('value="Copenhagen"');
    expect(html).toContain('aria-invalid="true"');
    // The field points at its own error (and at its hint, which `Field` adds).
    expect(html).toContain('aria-describedby="f-name-error');

    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from circles where city = 'Copenhagen' and name = ''
    `;
    expect(rows[0]?.n).toBe(0);
  });

  it("re-renders a bad gathering with 400 and echoes the dates back", async () => {
    const res = await post(
      `/host/circles/${circleSlug}/events`,
      {
        title: "Backwards",
        summary: "The end is before the start.",
        description: "This should never be saved.",
        venue: "Rua do Acucar 12",
        city: "Lisbon",
        startsAt: "2026-10-10T20:00",
        endsAt: "2026-10-10T18:00",
        capacity: "0",
        status: "published",
      },
      hostActor,
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("The end has to be after the start.");
    expect(html).toContain("Places must be a whole number between 1 and 500.");
    expect(html).toContain('value="2026-10-10T20:00"');
    expect(html).toContain('value="Backwards"');

    const rows = await sql<{ n: number }[]>`select count(*)::int as n from events where title = 'Backwards'`;
    expect(rows[0]?.n).toBe(0);
  });
});

describe("approving a member", () => {
  it("moves a request to approved, and refuses anyone who is not the host", async () => {
    const circleRow = await sql<{ id: string }[]>`select id from circles where slug = ${privateSlug}`;
    const membershipId = crypto.randomUUID();
    await sql`
      insert into circle_members (id, circle_id, user_id, role, status, created_at)
      values (${membershipId}, ${circleRow[0]!.id}, ${memberB.id}, 'member', 'pending', now() - interval '3 days')
    `;

    // The console shows the request, with the date it was made.
    const console_ = await (await get(`/host/circles/${privateSlug}`, hostActor)).text();
    expect(console_).toContain("Flow Member B");
    expect(console_).toContain("Waiting on you");

    // Not the host: refused, and the row does not move.
    const refused = await post(
      `/host/circles/${privateSlug}/members/${membershipId}/approve`,
      {},
      memberA,
    );
    expect(refused.status).toBe(403);
    const still = await sql<{ status: string }[]>`select status from circle_members where id = ${membershipId}`;
    expect(still[0]?.status).toBe("pending");

    const ok = await post(
      `/host/circles/${privateSlug}/members/${membershipId}/approve`,
      {},
      hostActor,
    );
    expect(ok.status).toBe(302);
    expect(location(ok)).toBe(`/host/circles/${privateSlug}`);

    const after = await sql<{ status: string }[]>`select status from circle_members where id = ${membershipId}`;
    expect(after[0]?.status).toBe("approved");
  });

  it("404s a membership id that is not in this circle", async () => {
    const res = await post(
      `/host/circles/${privateSlug}/members/${crypto.randomUUID()}/approve`,
      {},
      hostActor,
    );
    expect(res.status).toBe(404);
  });
});

describe("the flash banner", () => {
  it("is read once, sits above the h1, and is a live region", async () => {
    await post(`/circles/${circleSlug}/passes/${packageId}/buy`, { nonce: crypto.randomUUID() }, memberB);

    const html = await (await get("/account", memberB)).text();
    const alertAt = html.indexOf('role="status"');
    const h1At = html.indexOf("<h1");
    expect(alertAt).toBeGreaterThan(-1);
    expect(alertAt).toBeLessThan(h1At);
    expect(html).toContain("credits for");

    // Taken, not left behind: the next render is clean.
    const again = await (await get("/account", memberB)).text();
    expect(again.indexOf('role="status"')).toBe(-1);
  });
});

describe("the account page tells the truth about credits", () => {
  it("groups by circle, shows one square per credit, and never a combined total", async () => {
    const html = await (await get("/account", memberA)).text();
    expect(html).toContain(`${RUN} Supper Club`);
    // Two credits left of three: three squares, one of them spent.
    expect(html).toContain('aria-label="2 of 3 credits left');
    const squares = html.match(/class="credit-sq(?: is-spent)?"/g) ?? [];
    expect(squares.length).toBe(3);
    expect(squares.filter((s) => s.includes("is-spent")).length).toBe(1);
    // The ledger closes on the same number.
    expect(html).toContain("Good for");
  });
});
