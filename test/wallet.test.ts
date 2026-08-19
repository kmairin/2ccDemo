/**
 * The demo money, and the demo sign-in — driven through the real routes against
 * the REAL local Postgres.
 *
 * Every assertion about money is **two readings with the action between them**,
 * taken from the database rather than from the page: the balance before and
 * after a top-up, the balance and the order count before and after a purchase,
 * and the balance before and after a replayed top-up. A wallet that renders
 * beautifully and adds the money twice is the failure mode this file exists for.
 *
 * Everything it creates it owns — a host, three throwaway members, and the
 * host's own public EUR community with its packages and one event — and
 * `afterAll` deletes all of it in dependency order, so the seeded demo world is
 * exactly as it was. Nothing seeded is read for a count or written to at all.
 *
 * **Every hook is guarded on `hasDatabase`, including `beforeAll` and
 * `afterAll`.** The deploy pipeline runs `npm test` on a runner with no
 * database and `deploy.yml` cannot be edited, so an unguarded hook here fails
 * the deploy rather than skipping. See `test/support/database.ts`.
 *
 * Needs Postgres running and `npm run seed` applied at least once.
 * Run with: `npx vitest run test/wallet.test.ts`.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { hasDatabase } from "./support/database";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/loop_dev";

/** The env a handler sees locally: no data-service binding, so `src/db.ts` dials Postgres. */
const env = { DATABASE_URL, LOG_LEVEL: "silent" };

const sql = postgres(DATABASE_URL, { max: 1 });

const suite = hasDatabase ? describe : describe.skip;

/** One run's marker, so a crashed run never collides with the next. */
const RUN = `wallettest-${Date.now().toString(36)}`;

/**
 * This suite creates its OWN community, packages and event rather than buying
 * from the seeded world.
 *
 * It used to use `the-cold-room`, and that made `profile.test.ts` fail: its
 * `bookableTarget()` picks the soonest open event on a public community, which
 * was the same event this file was booking a place at, so an attendee count it
 * read twice moved underneath it. Suites run in parallel — anything a suite
 * mutates, it has to own.
 */
let COMMUNITY = "";

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

async function get(path: string, actor?: Actor): Promise<Response> {
  return app.request(path, actor ? { headers: { cookie: actor.cookie } } : {}, env);
}

async function post(
  path: string,
  fields: Record<string, string>,
  actor?: Actor,
): Promise<Response> {
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(actor ? { cookie: actor.cookie } : {}),
      },
      body: new URLSearchParams(fields).toString(),
    },
    env,
  );
}

function location(res: Response): string {
  return res.headers.get("location") ?? "";
}

/* ---------------- the readings, taken from the database, never from a page */

async function balanceOf(userId: string): Promise<number> {
  const rows = await sql<{ cents: number }[]>`
    select coalesce(balance_cents, 0)::int as cents from wallets where user_id = ${userId}
  `;
  return rows[0]?.cents ?? 0;
}

async function currencyOf(userId: string): Promise<string | null> {
  const rows = await sql<{ currency: string }[]>`
    select currency from wallets where user_id = ${userId}
  `;
  return rows[0]?.currency ?? null;
}

async function movementCount(userId: string, kind?: string): Promise<number> {
  const rows = kind
    ? await sql<{ n: number }[]>`
        select count(*)::int as n from wallet_txns where user_id = ${userId} and kind = ${kind}
      `
    : await sql<{ n: number }[]>`
        select count(*)::int as n from wallet_txns where user_id = ${userId}
      `;
  return rows[0]?.n ?? 0;
}

async function orderCount(userId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from orders where user_id = ${userId}
  `;
  return rows[0]?.n ?? 0;
}

async function ticketsLeft(userId: string): Promise<number> {
  const rows = await sql<{ left: number }[]>`
    select coalesce(sum(credits_total - credits_used), 0)::int as left
    from passes where user_id = ${userId}
  `;
  return rows[0]?.left ?? 0;
}

/** The 1-ticket and 3-ticket packages the seeded community sells, with prices. */
async function packagesOf(slug: string): Promise<{ id: string; tickets: number; cents: number }[]> {
  return sql<{ id: string; tickets: number; cents: number }[]>`
    select p.id, p.credits::int as tickets, p.price_cents::int as cents
    from packages p join circles c on c.id = p.circle_id
    where c.slug = ${slug} and p.active order by p.sort_order
  `;
}

/** A published event of the community with a place still free. */
async function openEvent(slug: string): Promise<string> {
  const rows = await sql<{ slug: string }[]>`
    select e.slug from events e join circles c on c.id = e.circle_id
    where c.slug = ${slug} and e.status = 'published'
      and e.capacity > (select count(*) from bookings b where b.event_id = e.id and b.status = 'confirmed')
    order by e.starts_at limit 1
  `;
  const found = rows[0]?.slug;
  if (!found) throw new Error(`no open event on ${slug}`);
  return found;
}

let host: Actor;
let payer: Actor;
let broke: Actor;
let ticketer: Actor;
let single = { id: "", cents: 0 };
let trio = { id: "", cents: 0 };
let eventSlug = "";

/** `YYYY-MM-DDTHH:MM`, the shape `datetime-local` posts. */
function week(days: number, hour: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(hour, 40, 0, 0);
  return d.toISOString().slice(0, 16);
}

beforeAll(async () => {
  if (!hasDatabase) return; // no Postgres in CI — every suite below is skipped
  host = await makeActor("Wallet Host", "host");
  payer = await makeActor("Wallet Payer", "payer");
  broke = await makeActor("Wallet Broke", "broke");
  ticketer = await makeActor("Wallet Ticketer", "ticketer");

  // Monaco on purpose, and it is not an arbitrary choice.
  //
  //   - A city the seed ALREADY has, so the city index gains no row. A new city
  //     would appear and disappear inside another suite's two reads.
  //   - **Not Aspen.** `discovery.test.ts` reads `cities[0]` — the list is
  //     ordered by city, so that is Aspen — and compares two searches for it.
  //     A community of this suite's in Aspen made those two counts disagree.
  //   - Not Lisbon either: `flows.test.ts` builds its community there.
  //
  // Monaco prices in EUR (`currencyFor` in src/routes/host.tsx), so every
  // top-up below is in EUR too.
  const created = await post(
    "/host/communities",
    {
      name: `${RUN} Tender Club`,
      tagline: "Bruno runs the tenders out at seven on Saturdays, six aboard, no wake.",
      description:
        "Bruno Fabre keeps two wooden tenders on the quay and runs them out at seven every Saturday. Six aboard, three hours, and the engine stays off inside the harbour wall.",
      city: "Monaco",
      country: "Monaco",
      category: "sailing",
    },
    host,
  );
  expect(created.status).toBe(302);
  COMMUNITY = location(created).replace("/host/communities/", "");

  for (const offer of [
    { name: "Single", tickets: "1", priceCents: "9500" },
    { name: "Trio", tickets: "3", priceCents: "25500" },
  ]) {
    expect((await post(`/host/communities/${COMMUNITY}/packages`, offer, host)).status).toBe(302);
  }

  // Three weeks out, so this is never the soonest open event in the database —
  // `profile.test.ts` picks that one, and it must not pick this suite's.
  const made = await post(
    `/host/communities/${COMMUNITY}/events`,
    {
      title: `${RUN} Seven O'Clock Tender`,
      summary: "Three hours under sail, out past the wall and back before the heat.",
      description: "Bruno takes the tenders out at seven. Six aboard, three hours, no wake inside the wall.",
      venue: "Quai des Etats-Unis, berth 12",
      city: "Monaco",
      startsAt: week(21, 6),
      endsAt: week(21, 8),
      capacity: "12",
      status: "published",
    },
    host,
  );
  expect(made.status).toBe(302);

  const offers = await packagesOf(COMMUNITY);
  const one = offers.find((offer) => offer.tickets === 1);
  const three = offers.find((offer) => offer.tickets === 3);
  if (!one || !three) throw new Error(`${COMMUNITY} does not sell the packages this suite needs`);
  single = { id: one.id, cents: one.cents };
  trio = { id: three.id, cents: three.cents };
  eventSlug = await openEvent(COMMUNITY);
});

afterAll(async () => {
  if (!hasDatabase) {
    await sql.end();
    return;
  }
  const userIds = [host?.id, payer?.id, broke?.id, ticketer?.id].filter(Boolean) as string[];
  const owned = await sql<{ id: string }[]>`select id from circles where slug like ${RUN + "%"}`;
  const communityIds = owned.map((row) => row.id);

  // Dependency order by hand: the FKs from passes to orders and from bookings
  // to passes have no ON DELETE, so a cascade from `users` is not safe.
  if (communityIds.length > 0) {
    await sql`delete from bookings where event_id in (select id from events where circle_id = any(${communityIds}))`;
  }
  if (userIds.length > 0) {
    await sql`delete from bookings where user_id = any(${userIds})`;
    await sql`delete from passes where user_id = any(${userIds})`;
    await sql`delete from orders where user_id = any(${userIds})`;
    await sql`delete from wallet_txns where user_id = any(${userIds})`;
    await sql`delete from wallets where user_id = any(${userIds})`;
  }
  if (communityIds.length > 0) {
    await sql`delete from passes where circle_id = any(${communityIds})`;
    await sql`delete from orders where circle_id = any(${communityIds})`;
    await sql`delete from events where circle_id = any(${communityIds})`;
    await sql`delete from packages where circle_id = any(${communityIds})`;
    await sql`delete from circle_members where circle_id = any(${communityIds})`;
    await sql`delete from circles where id = any(${communityIds})`;
  }
  if (userIds.length > 0) {
    await sql`delete from circle_members where user_id = any(${userIds})`;
    await sql`delete from sessions where user_id = any(${userIds})`;
    await sql`delete from users where id = any(${userIds})`;
  }
  await sql.end();
});

/* ------------------------------------------------------------- topping up */

suite("topping up", () => {
  it("moves the balance by exactly the amount, and writes one movement", async () => {
    const before = await balanceOf(payer.id);
    const movementsBefore = await movementCount(payer.id);

    const res = await post(
      "/account/wallet/topup",
      { amount: "25000", currency: "EUR", nonce: crypto.randomUUID() },
      payer,
    );
    expect(res.status).toBe(302);
    expect(location(res)).toBe("/account/wallet");

    const after = await balanceOf(payer.id);
    const movementsAfter = await movementCount(payer.id);

    expect(before).toBe(0);
    expect(after).toBe(25_000);
    expect(after - before).toBe(25_000);
    expect(movementsAfter - movementsBefore).toBe(1);
    expect(await currencyOf(payer.id)).toBe("EUR");
  });

  it("a replayed top-up does not double the balance", async () => {
    const nonce = crypto.randomUUID();
    const before = await balanceOf(payer.id);

    const first = await post("/account/wallet/topup", { amount: "10000", currency: "EUR", nonce }, payer);
    const between = await balanceOf(payer.id);
    // The same rendered form, submitted again — the nonce is the same.
    const second = await post("/account/wallet/topup", { amount: "10000", currency: "EUR", nonce }, payer);
    const after = await balanceOf(payer.id);

    expect(first.status).toBe(302);
    expect(second.status).toBe(302);
    expect(between - before).toBe(10_000);
    expect(after).toBe(between);
    expect(await movementCount(payer.id, "topup")).toBe(2); // the first top-up plus this one
  });

  it("refuses an amount that is not one, without touching the balance", async () => {
    const before = await balanceOf(payer.id);
    const res = await post("/account/wallet/topup", { amount: "-5", currency: "EUR" }, payer);
    expect(res.status).toBe(400);
    expect(await balanceOf(payer.id)).toBe(before);
  });

  it("refuses a currency this demo does not price in", async () => {
    const before = await balanceOf(payer.id);
    const res = await post("/account/wallet/topup", { amount: "5000", currency: "XYZ" }, payer);
    expect(res.status).toBe(400);
    expect(await balanceOf(payer.id)).toBe(before);
  });

  it("will not mix currencies while there is money in the wallet", async () => {
    const before = await balanceOf(payer.id);
    const res = await post(
      "/account/wallet/topup",
      { amount: "500000", currency: "THB", nonce: crypto.randomUUID() },
      payer,
    );
    expect(res.status).toBe(302);
    expect(await balanceOf(payer.id)).toBe(before);
    expect(await currencyOf(payer.id)).toBe("EUR");
  });

  it("sends a signed-out visitor to /join", async () => {
    const res = await get("/account/wallet");
    expect(res.status).toBe(302);
    expect(location(res)).toBe("/join?next=%2Faccount%2Fwallet");
  });
});

/* ------------------------------------------------------ paying from balance */

suite("paying for a package from the balance", () => {
  it("debits the balance and creates the order in the same step", async () => {
    const balanceBefore = await balanceOf(payer.id);
    const ordersBefore = await orderCount(payer.id);
    const ticketsBefore = await ticketsLeft(payer.id);

    const res = await post(
      `/communities/${COMMUNITY}/packages/${trio.id}/buy`,
      { pay: "balance", nonce: crypto.randomUUID() },
      payer,
    );
    expect(res.status).toBe(302);

    const balanceAfter = await balanceOf(payer.id);
    const ordersAfter = await orderCount(payer.id);

    expect(balanceBefore).toBe(35_000);
    expect(balanceBefore - balanceAfter).toBe(trio.cents);
    expect(balanceAfter).toBe(35_000 - trio.cents);
    expect(ordersAfter - ordersBefore).toBe(1);
    expect((await ticketsLeft(payer.id)) - ticketsBefore).toBe(3);
    expect(await movementCount(payer.id, "spend")).toBe(1);
  });

  it("files the spend under the order's own reference", async () => {
    const rows = await sql<{ reference: string; note: string }[]>`
      select reference, note from wallet_txns where user_id = ${payer.id} and kind = 'spend'
    `;
    const orders = await sql<{ reference: string }[]>`
      select reference from orders where user_id = ${payer.id}
    `;
    expect(rows).toHaveLength(1);
    expect(orders.map((row) => row.reference)).toContain(rows[0]!.reference);
  });

  it("refuses when the balance is short, and buys nothing", async () => {
    const balanceBefore = await balanceOf(broke.id);
    const ordersBefore = await orderCount(broke.id);

    const res = await post(
      `/communities/${COMMUNITY}/packages/${trio.id}/buy`,
      { pay: "balance", nonce: crypto.randomUUID() },
      broke,
    );
    expect(res.status).toBe(302);
    expect(location(res)).toBe(`/communities/${COMMUNITY}/packages/${trio.id}/checkout`);

    expect(balanceBefore).toBe(0);
    expect(await balanceOf(broke.id)).toBe(0);
    expect(await orderCount(broke.id)).toBe(ordersBefore);
    expect(await movementCount(broke.id)).toBe(0);
  });

  it("still takes the card, and leaves the balance alone", async () => {
    const balanceBefore = await balanceOf(payer.id);
    const ordersBefore = await orderCount(payer.id);

    const res = await post(
      `/communities/${COMMUNITY}/packages/${single.id}/buy`,
      { pay: "card", nonce: crypto.randomUUID() },
      payer,
    );
    expect(res.status).toBe(302);
    expect(await balanceOf(payer.id)).toBe(balanceBefore);
    expect((await orderCount(payer.id)) - ordersBefore).toBe(1);
  });
});

suite("buying one ticket from the balance", () => {
  it("debits the balance, records the order and books the place", async () => {
    const topped = await post(
      "/account/wallet/topup",
      { amount: "25000", currency: "EUR", nonce: crypto.randomUUID() },
      ticketer,
    );
    expect(topped.status).toBe(302);

    const balanceBefore = await balanceOf(ticketer.id);
    const ordersBefore = await orderCount(ticketer.id);

    const res = await post(
      `/events/${eventSlug}/ticket`,
      { pay: "balance", nonce: crypto.randomUUID() },
      ticketer,
    );
    expect(res.status).toBe(302);
    expect(location(res)).toMatch(/^\/account\/tickets\/2CC-TKT-/);

    const balanceAfter = await balanceOf(ticketer.id);
    expect(balanceBefore).toBe(25_000);
    expect(balanceBefore - balanceAfter).toBe(single.cents);
    expect((await orderCount(ticketer.id)) - ordersBefore).toBe(1);
    expect(await movementCount(ticketer.id, "spend")).toBe(1);
  });

  it("refuses a ticket the balance cannot cover, and buys nothing", async () => {
    const balanceBefore = await balanceOf(broke.id);
    const ordersBefore = await orderCount(broke.id);

    const res = await post(
      `/events/${eventSlug}/ticket`,
      { pay: "balance", nonce: crypto.randomUUID() },
      broke,
    );
    expect(res.status).toBe(302);
    expect(location(res)).toBe(`/events/${eventSlug}`);
    expect(await balanceOf(broke.id)).toBe(balanceBefore);
    expect(await orderCount(broke.id)).toBe(ordersBefore);
  });
});

/* ------------------------------------------------------------- the surfaces */

suite("the wallet page", () => {
  it("shows the balance, the presets and every movement", async () => {
    const res = await get("/account/wallet", payer);
    expect(res.status).toBe(200);
    const html = await res.text();

    const cents = await balanceOf(payer.id);
    expect(html).toContain(`data-balance-cents="${cents}"`);
    expect(html).toContain("€250");
    expect(html).toContain('data-movement="topup"');
    expect(html).toContain('data-movement="spend"');
    expect(html).toContain('name="amount" value="25000"');
  });

  it("marks the preset that covers what the checkout needs", async () => {
    const res = await get(`/account/wallet?need=${trio.cents}&currency=EUR`, broke);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`data-need="${trio.cents}"`);
    // Trio is $255 and the balance is $0, so the smallest preset that covers
    // the shortfall is $500 — and that is the one rendered as the primary.
    expect(trio.cents).toBeGreaterThan(25_000);
    expect(html).toContain('class="btn btn--primary" type="submit" name="amount" value="50000"');
    expect(html).toContain('class="btn btn--ghost" type="submit" name="amount" value="25000"');
  });

  it("is linked from the account page, with the balance on the link", async () => {
    const res = await get("/account", payer);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/account/wallet"');
    expect(html).toContain("Your balance");
  });
});

suite("the balance in the header", () => {
  it("is filled into every signed-in page", async () => {
    const html = await (await get("/communities", payer)).text();
    expect(html).toContain('class="hdr-balance"');
    expect(html).toContain('href="/account/wallet"');
    // Never the empty slot the middleware was supposed to replace.
    expect(html).not.toContain("data-balance-slot");
  });

  it("is absent for a signed-out visitor", async () => {
    const html = await (await get("/communities")).text();
    // The class name is in the stylesheet on every page; what must not be here
    // is an element wearing it, or the slot that would have become one.
    expect(html).not.toContain('class="hdr-balance"');
    expect(html).not.toContain("data-balance-slot");
    expect(html).not.toContain("2cc.account',");
  });

  it("mirrors the account into localStorage on a signed-in page", async () => {
    const html = await (await get("/account", payer)).text();
    expect(html).toContain("localStorage.setItem('2cc.account'");
    expect(html).toContain(payer.email);
    expect(html).toContain("initials");
    expect(html).not.toContain("data-account-slot");
  });
});

suite("the checkout offers two ways to pay", () => {
  it("offers the balance when it covers the price", async () => {
    const html = await (await get(`/communities/${COMMUNITY}/packages/${single.id}/checkout`, payer)).text();
    expect(html).toContain("Pay from balance");
    expect(html).toContain('name="pay" value="balance"');
    expect(html).toContain('name="pay" value="card"');
    expect(html).toContain("DEMO — no card is charged");
  });

  it("says so and links to the top-up when it does not", async () => {
    const html = await (await get(`/communities/${COMMUNITY}/packages/${trio.id}/checkout`, broke)).text();
    expect(html).toContain("short of this package");
    expect(html).toContain(`/account/wallet?need=${trio.cents}&amp;currency=EUR`);
    expect(html).not.toContain('name="pay" value="balance"');
  });

  it("never renders an enabled card input", async () => {
    const html = await (await get(`/communities/${COMMUNITY}/packages/${trio.id}/checkout`, payer)).text();
    expect(html).not.toContain('name="cardNumber"');
    expect(html).toMatch(/<fieldset class="checkout-card" disabled/);
  });
});

/* ------------------------------------------------------- the demo sign-in */

suite("the demo Google sign-in", () => {
  it("leads /join with Continue with Google", async () => {
    const res = await get("/join");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Continue with Google");
    expect(html).toContain('href="/join/google"');
    // The email and name fallback stays.
    expect(html).toContain('name="email"');
    expect(html).toContain('name="name"');
  });

  it("offers an account chooser that says Demo and asks for no password", async () => {
    const res = await get("/join/google");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Demo");
    expect(html).toContain("Alexandra Voss");
    expect(html).toContain("Rafael Ortiz");
    expect(html).toContain("member@2cc.club");
    expect(html).toContain("Use a different account");
    // The hard line: nothing on this page can collect a credential.
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('name="password"');
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain("accounts.google.com");
  });

  it("carries ?next through the chooser", async () => {
    const html = await (await get("/join/google?next=%2Faccount%2Fwallet")).text();
    expect(html).toContain('name="next" value="/account/wallet"');
  });

  it("signs a demo account straight in, with a real session", async () => {
    const email = `${RUN}-google@2cc.club`;
    const res = await post("/auth/google", { email, name: "Google Demo", next: "/account/wallet" });
    expect(res.status).toBe(302);
    expect(location(res)).toBe("/account/wallet");

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("2cc_session=");

    const rows = await sql<{ id: string }[]>`select id from users where email = ${email}`;
    expect(rows).toHaveLength(1);

    // Clean up this one here: it is created by the route, not by makeActor.
    await sql`delete from sessions where user_id = ${rows[0]!.id}`;
    await sql`delete from users where id = ${rows[0]!.id}`;
  });

  it("rejects a request with no account on it", async () => {
    const res = await post("/auth/google", { email: "", name: "" });
    expect(res.status).toBe(400);
  });
});
