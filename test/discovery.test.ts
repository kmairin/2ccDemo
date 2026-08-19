/**
 * Discovery — search, and browsing by country and city.
 *
 * The product is for people who travel, so "what is on in Bangkok" has to be a
 * question the app can answer. These tests drive the real routes against the
 * REAL local Postgres and compare what a reader gets against what the database
 * actually holds, the same way `test/api.test.ts` and `test/pages.test.ts` do.
 *
 * Two things are asserted over and over, because they are the two ways this
 * feature can be wrong while looking right:
 *
 *   1. **The filter actually filters.** Every count is read twice — the whole
 *      list, then the filtered one — and compared against the same number
 *      counted in SQL. A filter that quietly does nothing renders a perfectly
 *      good page.
 *   2. **Nothing about geography is hardcoded.** Every country and city the
 *      database holds has to appear, and the assertions are built from the
 *      rows rather than from a list written here, so a seventh country added
 *      tomorrow is covered by the test that exists today.
 *
 * They need Postgres running and `npm run seed` applied. Read-only throughout:
 * nothing here writes, so there is nothing to clean up.
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

const suite = hasDatabase ? describe : describe.skip;
afterAll(() => sql.end());

async function get(path: string): Promise<{ status: number; html: string }> {
  const res = await app.request(path, {}, env);
  return { status: res.status, html: await res.text() };
}

interface SearchBody {
  query: string;
  communities: { slug: string; city: string; country: string }[];
  events: { slug: string; city: string }[];
  countries: { country: string; communityCount: number; eventCount: number }[];
  cities: { city: string; country: string; communityCount: number; eventCount: number }[];
}

async function json<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await app.request(path, {}, env);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/** How many of a thing the page drew. The two markers the components emit. */
const CARD = '<article class="card">';
const LEDGER_ROW = 'class="ledger-row';

function countOf(html: string, marker: string): number {
  return html.split(marker).length - 1;
}

/**
 * The loops below render one page per country or per city, and the first
 * request in the process also pays for `ensureSchema`. Measured once at 5.0s
 * against vitest's 5s default, so these get their own ceiling rather than
 * failing the suite on a cold start.
 */
const SLOW = 20_000;

/* ---------------------------------------------------------------- the data */

/**
 * The places the seed actually holds, read **inside** each test rather than
 * once at module load.
 *
 * That is not fussiness. `test/bootstrap.test.ts` drops and rebuilds this same
 * database to prove the deployed bootstrap resumes, and vitest runs files in
 * parallel — so a snapshot taken at import time can describe a world that no
 * longer exists by the time an assertion reads it. Measured: a city held 10
 * events when this file loaded and 3 when the page was rendered. Every
 * expectation below is still built from the rows and never from a list of
 * city names typed in here, which is the same rule the routes follow.
 */

interface Place {
  city: string;
  country: string;
  n: number;
}

/** Cities with a community based in them, and how many. */
function communityCities(): Promise<Place[]> {
  return sql<Place[]>`
    select city, country, count(*)::int as n from circles group by city, country order by city
  `;
}

/**
 * Cities with a published event still to come, and how many.
 *
 * The join to `communities` is load-bearing, not decoration. This local database
 * has **no foreign key from `events` to `communities`** (the bootstrap in
 * `src/ensure-schema.ts` creates the table without one), so deleting a community
 * orphans its events instead of cascading them: measured, 7 rows left over
 * from earlier end-to-end runs. Every read path in the app inner-joins the
 * community, so a count that does not is counting rows no page will ever show —
 * and it said 10 where the page correctly drew 3.
 */
function eventCities(): Promise<{ city: string; n: number }[]> {
  return sql<{ city: string; n: number }[]>`
    select e.city, count(*)::int as n
    from events e join circles c on c.id = e.circle_id
    where e.status = 'published' and e.starts_at >= now()
    group by e.city order by e.city
  `;
}

interface Country {
  country: string;
  communities: number;
  events: number;
}

/** Countries, with their communities and their upcoming events. */
function allCountries(): Promise<Country[]> {
  return sql<Country[]>`
    select c.country,
           count(distinct c.id)::int as communities,
           count(distinct e.id) filter (
             where e.status = 'published' and e.starts_at >= now()
           )::int as events
    from circles c
    left join events e on e.circle_id = c.id
    group by c.country order by c.country
  `;
}

/**
 * Hono JSX escapes text the way HTML requires, so an assertion about copy
 * containing a quote or an apostrophe has to look for the escaped form.
 */
/** The three numerals one country's row on `/countries` prints. */
function indexCounts(html: string, country: string): number[] {
  const block = html.split(`/countries/${encodeURIComponent(country)}"`)[1] ?? "";
  return [...block.slice(0, 900).matchAll(/<dd class="num">(\d+)<\/dd>/g)].map((m) => Number(m[1]));
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ------------------------------------------------------- browse by country */

suite("GET /countries", () => {
  it("lists every country the database holds, and nothing invented", async () => {
    const countries = await allCountries();
    const { status, html } = await get("/countries");
    expect(status).toBe(200);
    expect(countries.length, "no communities: run `npm run seed`").toBeGreaterThan(0);
    for (const row of countries) {
      expect(html, `${row.country} is missing from the country index`).toContain(row.country);
      expect(html, `${row.country} has no link`).toContain(
        `/countries/${encodeURIComponent(row.country)}`,
      );
    }
  });

  it("counts the communities in each country the way the database does", async () => {
    /**
     * Read twice before failing.
     *
     * `test/flows.test.ts` creates and deletes communities while this runs — vitest
     * runs files in parallel — so a single disagreement between the page and
     * the database is evidence of a write in between, not of a miscount.
     * Measured: Portugal rendered 2 and SQL said 1, and the two agreed on the
     * re-read a moment later. A real miscount survives the second reading,
     * which is what is asserted; this is a tolerance for a moving fixture, not
     * a retry until green.
     */
    const read = async (): Promise<{ html: string; rows: Country[] }> => {
      const { html } = await get("/countries");
      return { html, rows: await allCountries() };
    };
    const agree = (html: string, rows: Country[]): boolean =>
      rows.every((row) => {
        const counts = indexCounts(html, row.country);
        return counts[0] === row.communities && counts[2] === row.events;
      });

    let seen = await read();
    if (!agree(seen.html, seen.rows)) seen = await read();

    for (const row of seen.rows) {
      const counts = indexCounts(seen.html, row.country);
      expect(counts[0], `community count for ${row.country}`).toBe(row.communities);
      expect(counts[1], `city count for ${row.country}`).toBeGreaterThan(0);
      expect(counts[2], `upcoming event count for ${row.country}`).toBe(row.events);
    }
  });
});

suite("GET /countries/:country", () => {
  it("shows what is on in that country, and only that country", async () => {
    const countries = await allCountries();
    for (const row of countries) {
      const { status, html } = await get(`/countries/${encodeURIComponent(row.country)}`);
      expect(status, `${row.country} should be a page`).toBe(200);
      expect(html).toContain(esc(`What is on in ${row.country}`));

      const mine = await sql<{ slug: string }[]>`
        select slug from circles where country = ${row.country}
      `;
      for (const community of mine) {
        expect(html, `${community.slug} missing from ${row.country}`).toContain(
          `/communities/${community.slug}`,
        );
      }
      const theirs = await sql<{ slug: string }[]>`
        select slug from circles where country <> ${row.country}
      `;
      for (const community of theirs) {
        expect(html, `${community.slug} leaked onto ${row.country}`).not.toContain(
          `/communities/${community.slug}"`,
        );
      }
    }
  }, SLOW);

  it("is case-insensitive, because a URL is typed by hand", async () => {
    const countries = await allCountries();
    const one = countries[0].country;
    const { status } = await get(`/countries/${encodeURIComponent(one.toLowerCase())}`);
    expect(status).toBe(200);
  });

  it("404s a country with nothing in it, as a styled page", async () => {
    const { status, html } = await get("/countries/Narnia");
    expect(status).toBe(404);
    expect(html).toContain("No such country");
    // A dead end is not an answer: the 404 offers a way on.
    expect(html).toContain('href="/communities"');
    expect(html).toContain('href="/events"');
  });
});

/* ---------------------------------------------------------- browse by city */

suite("GET /cities/:city", () => {
  it("answers what is on in each city the seed holds", async () => {
    const cities = await communityCities();
    for (const row of cities) {
      const { status, html } = await get(`/cities/${encodeURIComponent(row.city)}`);
      expect(status, `${row.city} should be a page`).toBe(200);
      expect(html).toContain(esc(`What is on in ${row.city}`));
      // Its country is the level above, and it has to be reachable.
      expect(html).toContain(`/countries/${encodeURIComponent(row.country)}`);

      const based = await sql<{ slug: string }[]>`
        select slug from circles where lower(city) = lower(${row.city})
      `;
      expect(countOf(html, CARD), `communities based in ${row.city}`).toBe(based.length);
    }
  }, SLOW);

  it("lists a city's upcoming dates and no more than that", async () => {
    const dates = await eventCities();
    for (const row of dates) {
      const { html } = await get(`/cities/${encodeURIComponent(row.city)}`);
      expect(countOf(html, LEDGER_ROW), `dates in ${row.city}`).toBe(row.n);
    }
  }, SLOW);

  it("exists for a city that only has an event, not a community", async () => {
    const [cities, dates] = await Promise.all([communityCities(), eventCities()]);
    const orphan = dates.find(
      (e) => !cities.some((c) => c.city.toLowerCase() === e.city.toLowerCase()),
    );
    // The seed has one (a Monaco community sailing out of Cap-d'Ail); if it ever
    // stops having one, this is worth knowing rather than skipping silently.
    expect(orphan, "seed no longer has an event in a city with no community").toBeDefined();
    if (!orphan) return;
    const { status, html } = await get(`/cities/${encodeURIComponent(orphan.city)}`);
    expect(status).toBe(200);
    expect(html).toContain(esc(`No community is based in ${orphan.city}.`));
    expect(countOf(html, LEDGER_ROW)).toBe(orphan.n);
  });

  it("is case-insensitive", async () => {
    const cities = await communityCities();
    const one = cities[0].city;
    const { status } = await get(`/cities/${encodeURIComponent(one.toUpperCase())}`);
    expect(status).toBe(200);
  });

  it("404s a city with nothing in it", async () => {
    const { status, html } = await get("/cities/Atlantis");
    expect(status).toBe(404);
    expect(html).toContain("No such city");
  });
});

/* ------------------------------------------------- the filters on the lists */

suite("GET /communities?city= and ?country=", () => {
  it("filters to one city — counted before and after", async () => {
    const before = await get("/communities");
    const cities = await communityCities();
    const all = countOf(before.html, CARD);
    expect(all, "no communities: run `npm run seed`").toBeGreaterThan(1);

    for (const row of cities) {
      const after = await get(`/communities?city=${encodeURIComponent(row.city)}`);
      expect(after.status).toBe(200);
      expect(countOf(after.html, CARD), `communities in ${row.city}`).toBe(row.n);
      expect(row.n, `${row.city} should be a proper subset`).toBeLessThan(all);
    }
  }, SLOW);

  it("filters to one country", async () => {
    const countries = await allCountries();
    for (const row of countries) {
      const { html } = await get(`/communities?country=${encodeURIComponent(row.country)}`);
      expect(countOf(html, CARD), `communities in ${row.country}`).toBe(row.communities);
    }
  }, SLOW);

  it("composes with ?category=", async () => {
    const [row] = await sql<{ country: string; category: string; n: number }[]>`
      select country, category, count(*)::int as n
      from circles group by country, category order by n desc limit 1
    `;
    const { status, html } = await get(
      `/communities?country=${encodeURIComponent(row.country)}&category=${row.category}`,
    );
    expect(status).toBe(200);
    expect(countOf(html, CARD)).toBe(row.n);

    // The other way round: a category that country does not have is empty, not
    // an error, and the two filters are both still live in the row.
    const [missing] = await sql<{ category: string }[]>`
      select unnest(array['sailing','wellness','dining','sport','art']) as category
      except select category from circles where country = ${row.country}
      limit 1
    `;
    if (missing) {
      const other = await get(
        `/communities?country=${encodeURIComponent(row.country)}&category=${missing.category}`,
      );
      expect(other.status).toBe(200);
      expect(countOf(other.html, CARD)).toBe(0);
    }
  });

  it("shows an empty state with a way out for a city nothing answers to", async () => {
    const { status, html } = await get("/communities?city=Atlantis");
    // Not a 404: an unknown place is an empty result, not a broken URL.
    expect(status).toBe(200);
    expect(html).toContain(esc("No communities in Atlantis yet."));
    expect(html).toContain('href="/countries"');
  });

  it("carries a city row built from the data, with counts that match it", async () => {
    const cities = await communityCities();
    const { html } = await get("/communities");
    for (const row of cities) {
      expect(html, `${row.city} is missing from the city row`).toContain(
        `/communities?city=${encodeURIComponent(row.city).replace(/%20/g, "+")}`,
      );
    }
    // The row is the hairline filter style, never pills (§5).
    expect(html).toContain('<nav class="filters" aria-label="City">');
  });

  it("puts a search field in the page body", async () => {
    const { html } = await get("/communities");
    expect(html).toContain('action="/search"');
    expect(html).toContain('name="q"');
  });
});

suite("GET /events?city= and ?country=", () => {
  it("filters to one city — counted before and after", async () => {
    const before = await get("/events");
    const dates = await eventCities();
    const all = countOf(before.html, LEDGER_ROW);
    expect(all, "no events: run `npm run seed`").toBeGreaterThan(1);

    for (const row of dates) {
      const after = await get(`/events?city=${encodeURIComponent(row.city)}`);
      expect(after.status).toBe(200);
      expect(countOf(after.html, LEDGER_ROW), `events in ${row.city}`).toBe(row.n);
      expect(row.n).toBeLessThan(all);
    }
  }, SLOW);

  it("filters to one country, counting the community's country and not the venue's", async () => {
    const countries = await allCountries();
    for (const row of countries) {
      const { html } = await get(`/events?country=${encodeURIComponent(row.country)}`);
      expect(countOf(html, LEDGER_ROW), `events in ${row.country}`).toBe(row.events);
    }
  }, SLOW);

  it("shows an empty state, not a 404, for a city with no dates", async () => {
    const { status, html } = await get("/events?city=Atlantis");
    expect(status).toBe(200);
    expect(html).toContain(esc("No events in Atlantis yet."));
    expect(html).toContain('href="/countries"');
  });

  it("puts a search field and a city row in the page body", async () => {
    const { html } = await get("/events");
    expect(html).toContain('action="/search"');
    expect(html).toContain('<nav class="filters" aria-label="City">');
  });
});

/* ---------------------------------------------------------------- search */

suite("GET /search", () => {
  it("prompts rather than erroring when there is no query", async () => {
    for (const path of ["/search", "/search?q="]) {
      const { status, html } = await get(path);
      expect(status, path).toBe(200);
      expect(html).toContain('name="q"');
      expect(html).toContain("What are you looking for");
    }
  });

  it("refuses a query longer than 100 characters with a 400", async () => {
    const long = "a".repeat(101);
    const { status } = await get(`/search?q=${long}`);
    expect(status).toBe(400);

    // 100 exactly is fine — the boundary is a boundary, not a fence.
    const edge = await get(`/search?q=${"a".repeat(100)}`);
    expect(edge.status).toBe(200);
  });

  it("finds a community by its name", async () => {
    const [community] = await sql<{ slug: string; name: string }[]>`
      select slug, name from circles order by created_at limit 1
    `;
    const { status, html } = await get(`/search?q=${encodeURIComponent(community.name)}`);
    expect(status).toBe(200);
    expect(html).toContain(`/communities/${community.slug}`);
  });

  it("finds a community by a word in its description, not just its name", async () => {
    const [community] = await sql<{ slug: string; description: string }[]>`
      select slug, description from circles order by created_at limit 1
    `;
    // A word long enough not to appear in the name or the chrome.
    const word = community.description.match(/[A-Za-z]{8,}/)?.[0];
    expect(word, "no long word in the seeded description to search for").toBeTruthy();
    if (word === undefined) return;
    const { html } = await get(`/search?q=${encodeURIComponent(word)}`);
    expect(html).toContain(`/communities/${community.slug}`);
  });

  it("groups a city search into communities, events, countries and cities", async () => {
    const [cities, dates] = await Promise.all([communityCities(), eventCities()]);
    const city = dates.find((c) => c.n > 0)?.city ?? cities[0].city;
    const { status, html } = await get(`/search?q=${encodeURIComponent(city)}`);
    expect(status).toBe(200);
    for (const group of ["Communities", "Events", "Countries", "Cities"]) {
      expect(html, `the ${group} group is missing`).toContain(group);
    }
    expect(html).toContain(`/cities/${encodeURIComponent(city)}`);
  });

  it("counts each group, and the count matches the rows under it", async () => {
    const cities = await communityCities();
    const city = cities[0].city;
    const { html } = await get(`/search?q=${encodeURIComponent(city)}`);
    const inCity = await sql<{ n: number }[]>`
      select count(*)::int as n from circles where lower(city) = lower(${city})
    `;
    // Community group heading carries the number, and the cards agree with it.
    expect(html).toMatch(new RegExp(`>${inCity[0].n} (community|communities)<`));
    expect(countOf(html, CARD)).toBe(inCity[0].n);
  });

  it("says what was searched and offers both ways out when nothing matches", async () => {
    const { status, html } = await get("/search?q=zzzznothinghere");
    expect(status).toBe(200);
    expect(html).toContain(esc('Nothing matches "zzzznothinghere".'));
    expect(html).toContain("Browse all communities");
    expect(html).toContain(esc("See what's on"));
  });

  it("treats a LIKE wildcard as a literal, so it cannot match everything", async () => {
    for (const wildcard of ["%", "_"]) {
      const { status, html } = await get(`/search?q=${encodeURIComponent(wildcard)}`);
      expect(status).toBe(200);
      expect(countOf(html, CARD), `"${wildcard}" matched communities`).toBe(0);
      expect(countOf(html, LEDGER_ROW), `"${wildcard}" matched events`).toBe(0);
    }
  });

  it("is case-insensitive", async () => {
    const cities = await communityCities();
    const city = cities[0].city;
    const lower = await get(`/search?q=${encodeURIComponent(city.toLowerCase())}`);
    const upper = await get(`/search?q=${encodeURIComponent(city.toUpperCase())}`);
    expect(countOf(lower.html, CARD)).toBe(countOf(upper.html, CARD));
    expect(countOf(lower.html, CARD)).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------- JSON */

suite("GET /api/communities with a place filter", () => {
  it("filters by city and by country", async () => {
    const [cities, countries] = await Promise.all([communityCities(), allCountries()]);
    const all = await json<{ communities: { slug: string }[] }>("/api/communities");
    for (const row of cities) {
      const one = await json<{ communities: { city: string }[] }>(
        `/api/communities?city=${encodeURIComponent(row.city)}`,
      );
      expect(one.status).toBe(200);
      expect(one.body.communities.length).toBe(row.n);
      expect(one.body.communities.length).toBeLessThan(all.body.communities.length);
      for (const community of one.body.communities) {
        expect(community.city.toLowerCase()).toBe(row.city.toLowerCase());
      }
    }
    for (const row of countries) {
      const one = await json<{ communities: { country: string }[] }>(
        `/api/communities?country=${encodeURIComponent(row.country)}`,
      );
      expect(one.body.communities.length).toBe(row.communities);
    }
  }, SLOW);

  it("returns an empty list, not a 404, for a place nothing answers to", async () => {
    const { status, body } = await json<{ communities: unknown[] }>("/api/communities?city=Atlantis");
    expect(status).toBe(200);
    expect(body.communities).toEqual([]);
  });
});

suite("GET /api/events with a place filter", () => {
  it("filters by city", async () => {
    const dates = await eventCities();
    for (const row of dates) {
      const { status, body } = await json<{ events: { city: string }[] }>(
        `/api/events?city=${encodeURIComponent(row.city)}`,
      );
      expect(status).toBe(200);
      for (const event of body.events) {
        expect(event.city.toLowerCase()).toBe(row.city.toLowerCase());
      }
      const published = await sql<{ n: number }[]>`
        select count(*)::int as n
        from events e join circles c on c.id = e.circle_id
        where e.status = 'published' and lower(e.city) = lower(${row.city})
      `;
      // The JSON list is not narrowed to upcoming — the contract says
      // "published only" and nothing more — so it is compared to that.
      expect(body.events.length, `published in ${row.city}`).toBe(published[0].n);
    }
  }, SLOW);

  it("filters by the country of the community that runs it", async () => {
    const countries = await allCountries();
    for (const row of countries) {
      const { body } = await json<{ events: { slug: string }[] }>(
        `/api/events?country=${encodeURIComponent(row.country)}`,
      );
      const expected = await sql<{ n: number }[]>`
        select count(*)::int as n from events e
        join circles c on c.id = e.circle_id
        where e.status = 'published' and c.country = ${row.country}
      `;
      expect(body.events.length, `events in ${row.country}`).toBe(expected[0].n);
    }
  }, SLOW);
});

suite("GET /api/search", () => {
  it("returns the four groups under the contracted keys", async () => {
    const cities = await communityCities();
    const city = cities[0].city;
    const { status, body } = await json<SearchBody>(`/api/search?q=${encodeURIComponent(city)}`);
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([
      "cities",
      "communities",
      "countries",
      "events",
      "query",
    ]);
    expect(body.query).toBe(city);
    expect(body.communities.length).toBeGreaterThan(0);
    expect(body.cities.map((c) => c.city.toLowerCase())).toContain(city.toLowerCase());
  });

  it("answers an empty query with empty groups rather than a 400", async () => {
    const { status, body } = await json<SearchBody>("/api/search?q=");
    expect(status).toBe(200);
    expect(body).toEqual({
      query: "",
      communities: [],
      events: [],
      countries: [],
      cities: [],
    });
  });

  it("400s a query over 100 characters, and a bad limit", async () => {
    const long = await json<{ error: string }>(`/api/search?q=${"a".repeat(101)}`);
    expect(long.status).toBe(400);
    expect(long.body.error).toContain("100");

    const bad = await json<{ error: string }>("/api/search?q=a&limit=999");
    expect(bad.status).toBe(400);
  });

  it("finds a country by name", async () => {
    const countries = await allCountries();
    const country = countries[0].country;
    const { body } = await json<SearchBody>(`/api/search?q=${encodeURIComponent(country)}`);
    expect(body.countries.map((c) => c.country)).toContain(country);
  });
});
