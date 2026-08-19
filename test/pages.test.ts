/**
 * The public pages — `src/routes/pages.tsx` — driven through `app.request()`
 * against the REAL local Postgres, the same way `test/api.test.ts` does.
 *
 * These assert what a reader would get: the status code, the copy that the
 * contract fixes word for word, and the numbers, compared against what the
 * database actually holds. A page test that only checks for `200` would have
 * passed while every community showed 0 members.
 *
 * They need Postgres running and `npm run seed` applied. Where a test has to
 * write (sign in, join a community) it uses a throwaway address prefixed
 * `pagetest-`, and `afterAll` deletes those members again — the cascade takes
 * their sessions and memberships with them, so the seed is left as it was found.
 */
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { hasDatabase } from "./support/database";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/loop_dev";

/** The env a handler sees locally: no data-service binding, so `src/db.ts` dials Postgres. */
const env = { DATABASE_URL };

const sql = postgres(DATABASE_URL, { max: 1 });

/**
 * These suites compare rendered output against real rows, so they need a
 * migrated Postgres. CI has none and `deploy.yml` cannot be edited, so they skip
 * there rather than failing the deploy on missing infrastructure. See
 * `test/support/database.ts` — locally they all run, and they are the real gate.
 */
const suite = hasDatabase ? describe : describe.skip;
afterAll(async () => {
  await sql`delete from users where email like 'pagetest-%'`;
  await sql.end();
});

const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function get(path: string, cookie?: string): Promise<{ status: number; html: string; res: Response }> {
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

/** `2cc_session=…` out of a Set-Cookie, ready to send straight back. */
function sessionCookie(res: Response): string {
  const raw = res.headers.get("set-cookie");
  expect(raw, "no session cookie was set").toBeTruthy();
  return raw!.split(";")[0];
}

/** Sign a throwaway member in and hand back their cookie. */
async function signInAs(name: string): Promise<string> {
  const email = `pagetest-${name}-${Date.now()}@example.com`;
  const res = await post("/auth/login", { email, name });
  expect(res.status).toBe(302);
  return sessionCookie(res);
}

function countOf(html: string, needle: RegExp): number {
  return html.match(needle)?.length ?? 0;
}

/* ------------------------------------------------------------ every page */

const PAGES = [
  { path: "/", subject: "Communities and events worldwide" },
  { path: "/communities", subject: "Communities" },
  { path: "/events", subject: "Events" },
  { path: "/calendar", subject: "Calendar" },
  { path: "/join", subject: "Join" },
];

suite("every public page", () => {
  it("answers 200 with HTML", async () => {
    for (const page of PAGES) {
      const { status, res } = await get(page.path);
      expect(status, `GET ${page.path}`).toBe(200);
      expect(res.headers.get("content-type"), `content-type of ${page.path}`).toContain("text/html");
    }
  });

  it("is `private, no-cache` and never `no-store` — no-store kills bfcache", async () => {
    const paths = [...PAGES.map((p) => p.path), "/communities/the-cold-room", "/events/first-light-plunge"];
    for (const path of paths) {
      const { res } = await get(path);
      expect(res.headers.get("cache-control"), `cache-control of ${path}`).toBe("private, no-cache");
    }
  });

  it("has exactly one <h1>, and it is the subject", async () => {
    for (const page of PAGES) {
      const { html } = await get(page.path);
      expect(countOf(html, /<h1\b/g), `<h1> count on ${page.path}`).toBe(1);
    }
    const landing = await get("/");
    expect(landing.html).toContain("Every event here has a date");
    const communities = await get("/communities");
    expect(communities.html).toMatch(/<h1[^>]*>Communities<\/h1>/);
  });

  it("names the subject in the <title>", async () => {
    for (const page of PAGES) {
      const { html } = await get(page.path);
      expect(html, `<title> of ${page.path}`).toContain(`<title>${page.subject} · 2CC</title>`);
    }
  });
});

/* -------------------------------------------------------------- landing */

suite("GET /", () => {
  it("puts the next events above the communities", async () => {
    const { html } = await get("/");
    const events = html.indexOf("The next events");
    const communities = html.indexOf("The communities");
    expect(events, "the events section is missing").toBeGreaterThan(-1);
    expect(communities, "the communities section is missing").toBeGreaterThan(-1);
    expect(events).toBeLessThan(communities);
  });

  it("defines all four nouns in the subline", async () => {
    const { html } = await get("/");
    for (const noun of ["community is", "event is", "package buys", "ticket takes"]) {
      expect(html, `the subline never defines "${noun}"`).toContain(noun);
    }
  });

  it("lists the seeded communities, with the member counts the database holds", async () => {
    const { html } = await get("/");
    const rows = await sql<{ slug: string; name: string; members: number }[]>`
      select c.slug, c.name,
             (select count(*)::int from circle_members m
               where m.circle_id = c.id and m.status = 'approved') as members
      from circles c
    `;
    expect(rows.length, "no communities: run `npm run seed`").toBeGreaterThan(0);
    for (const row of rows) {
      expect(html, `${row.slug} is missing from the landing page`).toContain(`/communities/${row.slug}`);
      // "1 member", not "1 members" — the component pluralises and this
      // assertion did not, so it failed whenever a one-member community existed.
      const members = row.members === 1 ? "1 member" : `${row.members} members`;
      expect(html, `member count for ${row.slug}`).toContain(members);
    }
  });
});

/* -------------------------------------------------------------- communities */

suite("GET /communities", () => {
  it("filters by category and shows nothing from the others", async () => {
    const { status, html } = await get("/communities?category=sailing");
    expect(status).toBe(200);

    const rows = await sql<{ slug: string; category: string }[]>`select slug, category from circles`;
    const sailing = rows.filter((r) => r.category === "sailing");
    expect(sailing.length, "the seed has no sailing communities").toBeGreaterThan(0);
    for (const row of sailing) expect(html).toContain(`/communities/${row.slug}`);
    for (const row of rows.filter((r) => r.category !== "sailing")) {
      expect(html, `${row.slug} is not a sailing community`).not.toContain(`"/communities/${row.slug}"`);
    }
  });

  it("marks the active filter with aria-current, and is never a pill", async () => {
    const { html } = await get("/communities?category=wellness");
    expect(html).toContain('href="/communities?category=wellness" aria-current="page"');
    expect(html).toContain('class="filters"');
  });

  it("400s on a category that is not one of the five", async () => {
    const { status, html } = await get("/communities?category=banana");
    expect(status).toBe(400);
    // Styled page, not a stack trace (§8).
    expect(html).toContain("<title>Communities · 2CC</title>");
    expect(html).toContain("There is no &quot;banana&quot; category.");
  });

  it("treats an empty category as no filter rather than a 400", async () => {
    const { status } = await get("/communities?category=");
    expect(status).toBe(200);
  });
});

suite("GET /communities/:slug", () => {
  it("404s for a slug nothing answers to", async () => {
    const { status, html } = await get("/communities/not-a-real-community");
    expect(status).toBe(404);
    expect(html).toContain("No such community");
  });

  it("shows the story, the host, the packages, the gallery and the members", async () => {
    const { status, html } = await get("/communities/the-cold-room");
    expect(status).toBe(200);

    const [community] = await sql<{ description: string; name: string }[]>`
      select description, name from circles where slug = 'the-cold-room'
    `;
    expect(community, "the-cold-room is not seeded").toBeDefined();
    expect(html).toContain(community!.description);
    expect(html).toContain("Wes Calloway");

    // The three packages are one bordered table, never three pricing cards (§5).
    expect(html).toContain('class="package-table"');
    expect(html).not.toContain('class="package-grid"');

    // The gate greps for these three.
    expect(html).toContain("data-gallery");
    expect(html).toContain("data-members");
  });

  it("agrees with the database about how many members there are", async () => {
    const { html } = await get("/communities/the-cold-room");
    const [row] = await sql<{ members: number }[]>`
      select (select count(*)::int from circle_members m
               where m.circle_id = c.id and m.status = 'approved') as members
      from circles c where c.slug = 'the-cold-room'
    `;
    expect(html).toContain(`${row!.members} members`);
  });

  /**
   * Matched on names that are pending and NOT also approved. Two different
   * members can share a display name — the seed has one and an end-to-end run
   * created another — and a plain name match then fails on the approved one
   * while the page is behaving correctly.
   */
  it("never shows a pending member in public", async () => {
    const rows = await sql<{ name: string; status: string }[]>`
      select u.name, m.status from circle_members m
        join users u on u.id = m.user_id
        join circles c on c.id = m.circle_id
      where c.slug = 'nightform'
    `;
    const approved = new Set(rows.filter((r) => r.status === "approved").map((r) => r.name));
    const pendingOnly = rows
      .filter((r) => r.status === "pending" && !approved.has(r.name))
      .map((r) => r.name);
    expect(rows.some((r) => r.status === "pending"), "no pending request to check").toBe(true);

    const { html } = await get("/communities/nightform");
    const members = html.slice(html.indexOf("data-members"));
    for (const name of pendingOnly) {
      expect(members, `${name} is pending and must not be listed`).not.toContain(name);
    }
    for (const name of approved) {
      expect(members, `${name} is approved and must be listed`).toContain(name);
    }
    // And the count on the page is the approved count, not everyone who asked.
    expect(members).toContain(`${approved.size} members`);
  });

  it("gives a community with no dates a real empty state, not an apology", async () => {
    const { status, html } = await get("/communities/es-freus-passage");
    expect(status).toBe(200);
    expect(html).toContain("No events scheduled.");
    expect(html).not.toContain("Check back soon");
  });
});

/* ----------------------------------------------------------- events */

suite("GET /events", () => {
  it("is a ledger with month headers, soonest first", async () => {
    const { status, html } = await get("/events");
    expect(status).toBe(200);
    expect(html).toContain('class="ledger"');
    expect(html).toContain('class="ledger-month"');
    // A grid of cards is the shape §5 rejects for this screen.
    expect(html).not.toContain('class="grid grid--hair grid--bleed"');

    const rows = await sql<{ slug: string; starts_at: Date }[]>`
      select slug, starts_at from events where status = 'published' order by starts_at asc
    `;
    const listed = rows.filter((r) => html.includes(`/events/${r.slug}`));
    expect(listed.length, "no events listed: run `npm run seed`").toBeGreaterThan(0);
    const positions = listed.map((r) => html.indexOf(`/events/${r.slug}`));
    expect(positions, "the ledger is not in date order").toEqual([...positions].sort((a, b) => a - b));
  });

  it("keeps drafts off the public ledger", async () => {
    const { html } = await get("/events");
    const drafts = await sql<{ slug: string }[]>`select slug from events where status <> 'published'`;
    for (const draft of drafts) {
      expect(html, `draft ${draft.slug} must not be public`).not.toContain(`/events/${draft.slug}`);
    }
  });
});

suite("GET /events/:slug", () => {
  it("404s for a slug nothing answers to", async () => {
    const { status, html } = await get("/events/not-a-real-event");
    expect(status).toBe(404);
    expect(html).toContain("No such event");
  });

  it("404s for an event that is not published", async () => {
    const [draft] = await sql<{ slug: string }[]>`
      select slug from events where status <> 'published' limit 1
    `;
    expect(draft, "the seed has no draft to check").toBeDefined();
    const { status } = await get(`/events/${draft!.slug}`);
    expect(status).toBe(404);
  });

  it("prints places left as the database computes it", async () => {
    const [row] = await sql<{ slug: string; capacity: number; confirmed: number }[]>`
      select e.slug, e.capacity,
             (select count(*)::int from bookings b
               where b.event_id = e.id and b.status = 'confirmed') as confirmed
      from events e where e.slug = 'first-light-plunge'
    `;
    const left = Math.max(0, row!.capacity - row!.confirmed);
    const { html } = await get("/events/first-light-plunge");
    expect(html).toContain(`class="places-left"`);
    expect(html).toContain(`<dd><span class="places-left">${left}</span></dd>`);
    expect(html).toContain(`1 ticket · ${left} of ${row!.capacity} places left`);
    expect(html).toContain(`${row!.confirmed} of ${row!.capacity} going`);
  });

  /**
   * Measured in a browser: on the `dd` itself the number came out
   * `rgb(207,200,188)` — `--ivory-2` — because `.deflist dd` is one class plus
   * one type and out-specifies `.places-left`. On a `span` it measures
   * `rgb(174,148,99)`, which is `--brass`. This pins the shape that fix needs.
   */
  it("keeps the one large brass number on a span, where .deflist dd cannot repaint it", async () => {
    const { html } = await get("/events/first-light-plunge");
    expect(html).not.toMatch(/<dd class="places-left"/);
    expect(html).toMatch(/<dd><span class="places-left">\d+<\/span><\/dd>/);
  });

  it("carries the attendees section and the mobile action bar", async () => {
    const { html } = await get("/events/first-light-plunge");
    expect(html).toContain("data-attendees");
    expect(html).toContain("data-gallery");
    expect(html).toContain('class="actionbar"');
    expect(html).toContain('class="has-actionbar"');
  });
});

suite("the action area", () => {
  it("signed out: Sign in to reserve, and the join link comes back here", async () => {
    const { html } = await get("/events/first-light-plunge");
    expect(html).toContain("Sign in to reserve");
    expect(html).toContain("Email and name. No password.");
    expect(html).toContain("/join?next=%2Fevents%2Ffirst-light-plunge");
  });

  it("signed out: the count is shown but the names are not", async () => {
    const { html } = await get("/events/first-light-plunge");
    expect(html).toContain("Sign in to see who&#39;s going");
  });

  it("at capacity: a disabled Full, plus the next date from that community", async () => {
    const [full] = await sql<{ slug: string }[]>`
      select e.slug from events e
      where e.status = 'published'
        and e.capacity - (select count(*)::int from bookings b
                            where b.event_id = e.id and b.status = 'confirmed') <= 0
      limit 1
    `;
    expect(full, "the seed has no full event — §8 requires one").toBeDefined();
    const { html } = await get(`/events/${full!.slug}`);
    expect(html).toContain("Full");
    expect(html).toContain("Next from this community:");
    expect(html).toContain("disabled");
  });

  it("not a member of a public community: three packages, headed with the reason", async () => {
    const cookie = await signInAs("visitor");
    const { html } = await get("/events/first-light-plunge", cookie);
    expect(html).toContain("Reserve with a package");
    expect(html).toContain("Buying a package joins the community.");
    expect(countOf(html, /\/packages\/[^/]+\/checkout/g)).toBeGreaterThanOrEqual(3);
    // Every package button comes back to this event afterwards.
    expect(html).toContain("checkout?next=%2Fevents%2Ffirst-light-plunge");
  });

  it("not a member of a private community: ask the host, no packages", async () => {
    const cookie = await signInAs("outsider");
    const { html } = await get("/events/the-warehouse-hang", cookie);
    expect(html).toContain("Ask the host to join");
    expect(html).toContain("This community approves members by hand.");
  });

  it("pending: names the host and offers somewhere else to be", async () => {
    const cookie = await signInAs("waiting");
    const request = await post("/communities/nightform/join", { next: "/communities/nightform" }, cookie);
    expect(request.status).toBe(302);
    const { html } = await get("/events/the-warehouse-hang", cookie);
    expect(html).toContain("Your request is with");
    expect(html).toContain('href="/events"');
  });

  it("never prints the word ticket without a number beside it", async () => {
    const { html } = await get("/events/first-light-plunge");
    const action = html.slice(html.indexOf('class="action"'), html.indexOf("</section>"));
    const bare = action.match(/(^|[^\d]\s|>)tickets?\b/gi) ?? [];
    // "1 ticket ·" and "3 tickets" are fine; "your tickets" is not.
    const offenders = bare.filter((m) => !/\d/.test(m));
    expect(offenders, `bare "ticket": ${offenders.join(", ")}`).toEqual([]);
  });
});

/* -------------------------------------------------------------- calendar */

suite("GET /calendar", () => {
  it("defaults to this month and carries the param on prev and next", async () => {
    const { status, html } = await get("/calendar");
    expect(status).toBe(200);
    expect(html).toContain('class="cal-grid"');
    expect(countOf(html, /href="\/calendar\?month=\d{4}-\d{2}"/g)).toBe(2);
  });

  it("draws the month it is asked for", async () => {
    const { status, html } = await get("/calendar?month=2026-09");
    expect(status).toBe(200);
    expect(html).toContain("September 2026");
    expect(html).toContain('href="/calendar?month=2026-08"');
    expect(html).toContain('href="/calendar?month=2026-10"');
  });

  it("rolls the year over at both ends", async () => {
    const december = await get("/calendar?month=2026-12");
    expect(december.html).toContain('href="/calendar?month=2027-01"');
    const january = await get("/calendar?month=2026-01");
    expect(january.html).toContain('href="/calendar?month=2025-12"');
  });

  it("puts an event on the day it actually falls on", async () => {
    const [row] = await sql<{ slug: string; title: string; day: number }[]>`
      select slug, title, extract(day from starts_at at time zone 'UTC')::int as day
      from events
      where status = 'published'
        and starts_at >= timestamp '2026-09-01' and starts_at < timestamp '2026-10-01'
      limit 1
    `;
    expect(row, "the seed has nothing in September 2026").toBeDefined();
    const { html } = await get("/calendar?month=2026-09");
    expect(html).toContain(`/events/${row!.slug}`);
    const cell = html.slice(html.indexOf(`/events/${row!.slug}`) - 400, html.indexOf(`/events/${row!.slug}`));
    expect(cell, `day ${row!.day} is not the cell holding ${row!.slug}`).toContain(`>${row!.day}<`);
  });

  it("400s on a month that is not a month", async () => {
    expect((await get("/calendar?month=nonsense")).status).toBe(400);
    expect((await get("/calendar?month=2026-13")).status).toBe(400);
    expect((await get("/calendar?month=26-9")).status).toBe(400);
  });

  it("says what a month looks like rather than showing a stack trace", async () => {
    const { html } = await get("/calendar?month=nonsense");
    expect(html).toContain("is not a month. Months look like 2026-09.");
  });
});

/* ------------------------------------------------------------------ join */

suite("GET /join", () => {
  it("is a bare column with underline inputs and no card", async () => {
    const { html } = await get("/join");
    expect(html).toContain('class="column-420"');
    expect(html).toContain('class="invitation"');
    expect(html).not.toContain('class="card"');
  });

  it("carries ?next= into the form", async () => {
    const { html } = await get("/join?next=/events/first-light-plunge");
    expect(html).toContain('name="next" value="/events/first-light-plunge"');
  });

  it("refuses to carry an off-site next", async () => {
    const { html } = await get("/join?next=//evil.example/steal");
    expect(html).not.toContain("evil.example");
  });

  it("labels the invitation code honestly and offers the terms", async () => {
    const { html } = await get("/join");
    expect(html).toContain("Invitation code");
    // The brief requires the decorative field to be labelled honestly. Matched
    // as a property rather than one sentence, so a rewording of the hint does
    // not read as a regression.
    expect(html, "the invitation code is not labelled as decorative").toMatch(
      /not checked|nothing checks it/i,
    );
    expect(html).toContain("Membership terms");
    expect(html).toContain("What happens next");
  });
});

suite("POST /auth/login", () => {
  it("signs a new member in and 302s to next", async () => {
    const email = `pagetest-round-trip-${Date.now()}@example.com`;
    const res = await post("/auth/login", {
      email,
      name: "Round Trip",
      next: "/events/first-light-plunge",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/events/first-light-plunge");

    const cookie = sessionCookie(res);
    const { html } = await get("/", cookie);
    // The header greets them by first name once the session is live.
    expect(html).toContain("Round");
  });

  it("302s to /account when no next was given", async () => {
    const res = await post("/auth/login", {
      email: `pagetest-noneext-${Date.now()}@example.com`,
      name: "No Next",
    });
    expect(res.headers.get("location")).toBe("/account");
  });

  it("ignores an off-site next rather than redirecting to it", async () => {
    const res = await post("/auth/login", {
      email: `pagetest-offsite-${Date.now()}@example.com`,
      name: "Off Site",
      next: "//evil.example/steal",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/account");
  });

  it("400s on a missing email and gives back everything that was typed", async () => {
    const res = await post("/auth/login", {
      email: "",
      name: "Typed Already",
      code: "SEA-1904",
      next: "/communities/nightform",
    });
    expect(res.status).toBe(400);
    const html = await res.text();

    expect(html).toContain("An email address is required.");
    expect(html).toContain('value="Typed Already"');
    expect(html).toContain('value="SEA-1904"');
    expect(html).toContain('value="/communities/nightform"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="f-email-error"');
    expect(html).toContain('role="status"');
  });

  it("400s when a new member gives no name, and keeps the email", async () => {
    const email = `pagetest-nameless-${Date.now()}@example.com`;
    const res = await post("/auth/login", { email, name: "" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("A name is required the first time you sign in.");
    expect(html).toContain(`value="${email}"`);
  });

  it("lets a returning member back in without retyping their name", async () => {
    const email = `pagetest-returning-${Date.now()}@example.com`;
    expect((await post("/auth/login", { email, name: "Returning Member" })).status).toBe(302);
    const again = await post("/auth/login", { email });
    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toBe("/account");
  });

  it("400s on something that is not an address at all", async () => {
    const res = await post("/auth/login", { email: "not an address", name: "Nope" });
    expect(res.status).toBe(400);
  });
});

suite("POST /auth/logout", () => {
  it("302s to the landing page and drops the session", async () => {
    const cookie = await signInAs("leaver");
    const res = await post("/auth/logout", {}, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");

    const { html } = await get("/", cookie);
    expect(html).toContain(">Join</a>");
  });
});

suite("POST /communities/:slug/join", () => {
  it("sends a signed-out visitor to the join form, remembering where they were", async () => {
    const res = await post("/communities/the-cold-room/join", {});
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/join?next=%2Fcommunities%2Fthe-cold-room");
  });

  it("404s for a community that does not exist", async () => {
    const cookie = await signInAs("lost");
    const res = await post("/communities/not-a-real-community/join", {}, cookie);
    expect(res.status).toBe(404);
  });

  it("approves on a public community, and says so once", async () => {
    const cookie = await signInAs("joiner");
    const res = await post("/communities/es-freus-passage/join", {}, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/communities/es-freus-passage");

    const [row] = await sql<{ status: string }[]>`
      select m.status from circle_members m
        join circles c on c.id = m.circle_id
        join users u on u.id = m.user_id
      where c.slug = 'es-freus-passage' and u.email like 'pagetest-joiner-%'
    `;
    expect(row!.status).toBe("approved");

    // The flash is on the session: shown once, above the <h1>, then gone.
    const first = await get("/communities/es-freus-passage", cookie);
    expect(first.html).toContain('role="status"');
    expect(first.html).toContain("You are in Es Freus Passage.");
    expect(first.html.indexOf('role="status"')).toBeLessThan(first.html.indexOf("<h1"));
    expect(first.html).not.toContain("Dismiss");

    const second = await get("/communities/es-freus-passage", cookie);
    expect(second.html, "the flash announced itself twice").not.toContain('role="status"');
  });

  it("leaves a private community pending, and names the host", async () => {
    const cookie = await signInAs("asker");
    const res = await post("/communities/nightform/join", {}, cookie);
    expect(res.status).toBe(302);

    const [row] = await sql<{ status: string }[]>`
      select m.status from circle_members m
        join circles c on c.id = m.circle_id
        join users u on u.id = m.user_id
      where c.slug = 'nightform' and u.email like 'pagetest-asker-%'
    `;
    expect(row!.status).toBe("pending");

    const { html } = await get("/communities/nightform", cookie);
    expect(html).toContain("Your request is with");
  });

  it("honours next, and refuses an off-site one", async () => {
    const cookie = await signInAs("nexter");
    const good = await post(
      "/communities/es-freus-passage/join",
      { next: "/events/first-light-plunge" },
      cookie,
    );
    expect(good.headers.get("location")).toBe("/events/first-light-plunge");

    const bad = await post("/communities/the-cold-room/join", { next: "//evil.example" }, cookie);
    expect(bad.headers.get("location")).toBe("/communities/the-cold-room");
  });

  it("a second request adds nothing and says the request is already in", async () => {
    const cookie = await signInAs("twice");
    await post("/communities/nightform/join", {}, cookie);
    await get("/communities/nightform", cookie); // clears the first flash
    await post("/communities/nightform/join", {}, cookie);

    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from circle_members m
        join circles c on c.id = m.circle_id
        join users u on u.id = m.user_id
      where c.slug = 'nightform' and u.email like 'pagetest-twice-%'
    `;
    expect(rows[0]!.n, "a second request wrote a second row").toBe(1);

    const { html } = await get("/communities/nightform", cookie);
    expect(html).toContain("Your request is already with");
  });
});
