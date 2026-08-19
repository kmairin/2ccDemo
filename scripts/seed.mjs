#!/usr/bin/env node
/**
 * Fill the LOCAL database with a believable 2CC world.
 *
 *   npm run seed
 *
 * Plain Node, not TypeScript, and it talks to Postgres directly rather than
 * through `src/db.ts` — that file builds a client from a Worker's `env`, which
 * does not exist out here.
 *
 * Two properties this script guarantees:
 *
 *   - **Idempotent.** It deletes every app row first, in foreign-key order,
 *     then inserts. Run it ten times and the counts do not move. It never
 *     DROPs anything: the table shape belongs to `drizzle/`, not to the seed.
 *   - **Stable keys.** Ids, order references and ticket codes are derived from
 *     a hash of what they name, not from randomness, so `/communities/nightform`
 *     and `/account/tickets/2CC-TKT-...` still resolve after a reseed. Only
 *     the dates move, because the events have to stay in the future.
 *
 * It is also self-checking. The block of assertions at the bottom of
 * `buildRows()` refuses to write a world that would make a page lie: a package
 * whose tickets do not match its bookings, an event over capacity, an
 * attendee who is not an approved member, a date in the past, a price ladder
 * that does not fall. Read those assertions as the specification of what
 * "staged correctly" means here.
 *
 * Copy in this file follows `design/reference/design-decisions.md` §6 — every
 * community description names a person and what they do, gives a cadence, gives a
 * physical detail, and states one constraint. The assertions check sentence
 * length; the banned-word list is checked by grep, not by code.
 *
 * The whole thing runs inside one transaction, so a failure half way leaves
 * the previous world intact rather than an empty database.
 */
import { createHash } from "node:crypto";
import postgres from "postgres";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/loop_dev";

/** Namespace for the derived ids below — changing it reshuffles every key. */
const NS = "2cc.club/seed/v1";

/** Same alphabet as `src/lib/ids.ts`: no I, O, 0 or 1. */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** A stable UUID for `key` — a name-based (v5-shaped) id, so reseeds keep URLs alive. */
function uid(key) {
  const bytes = createHash("sha1").update(`${NS}:${key}`).digest().subarray(0, 16);
  const b = Buffer.from(bytes);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A stable human-readable code for `key`, `length` characters of the alphabet. */
function code(key, length) {
  const digest = createHash("sha256").update(`${NS}:code:${key}`).digest();
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[digest[i] % ALPHABET.length];
  return out;
}

/** A stable non-negative integer for `key`. Used for dates, never for copy. */
function hashInt(key) {
  return createHash("sha256").update(`${NS}:n:${key}`).digest().readUInt32BE(0);
}

/**
 * Ticket codes are four characters, so 116 of them have a real chance of
 * colliding. Salt the key and try again until the code is free — still
 * deterministic, because the order the seed asks in never changes.
 */
function distinctCode(taken, key, length, format) {
  for (let salt = 0; ; salt++) {
    const candidate = format(code(salt === 0 ? key : `${key}#${salt}`, length));
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

const NOW = new Date();
const DAY_MS = 86_400_000;

/** `n` days before the run, for plausible "joined a while ago" timestamps. */
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY_MS);

/** A UTC wall-clock instant `days` from today. Every event is built with this. */
function at(days, hour, minute) {
  return new Date(
    Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate() + days, hour, minute, 0, 0),
  );
}

/**
 * Days from today to the coming Saturday, never fewer than two — so the
 * "this weekend" event is genuinely this weekend and never collides with
 * the "tomorrow" one.
 */
const WEEKEND = (() => {
  const d = (6 - NOW.getUTCDay() + 7) % 7;
  return d < 2 ? d + 7 : d;
})();

/** Three months out, give or take. The far end of the calendar. */
const FAR = 92;

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

const USERS = [
  {
    key: "rafael",
    email: "host@2cc.club",
    name: "Rafael Ortiz",
    city: "Monaco",
    headline: "Skipper, twenty-two Atlantic crossings",
    bio: "Keeps other people's wooden boats alive for a living and sails them harder than their owners do. Two communities, both under sail.",
    joined: 780,
  },
  {
    key: "alexandra",
    email: "member@2cc.club",
    name: "Alexandra Voss",
    city: "Zürich",
    headline: "Founder, Aster Capital",
    bio: "Splits the year between Zürich, Lisbon and the coast. Joined for the boats and stayed for the table in Bica.",
    joined: 410,
  },
  {
    key: "wes",
    email: "wes.calloway@2cc.club",
    name: "Wes Calloway",
    city: "Aspen",
    headline: "Aspen Mountain ski patrol, 1998 to 2016",
    bio: "Eighteen winters reading avalanche terrain, then a decade of teaching people to breathe in cold water. Cuts the ice himself.",
    joined: 700,
  },
  {
    key: "sebastiao",
    email: "sebastiao.duarte@2cc.club",
    name: "Sebastião Duarte",
    city: "Lisbon",
    headline: "Chef-patron, Casa Duarte",
    bio: "Cooks over wood only, buys at Ribeira every morning, and refuses to write a menu before eleven.",
    joined: 760,
  },
  {
    key: "latifa",
    email: "latifa.almarri@2cc.club",
    name: "Latifa Al Marri",
    city: "Dubai",
    headline: "UAE national padel squad, 2019 to 2022",
    bio: "Left the squad to run a family logistics business and kept the 05:40 alarm. Still the best hands on the court.",
    joined: 610,
  },
  {
    key: "ploy",
    email: "ploy.wisetsri@2cc.club",
    name: "Ploy Wisetsri",
    city: "Bangkok",
    headline: "Curator, Talat Noi warehouse shows",
    bio: "Puts on four shows a year in rooms that were something else last month. Knows every studio staircase in the district.",
    joined: 520,
  },
  {
    key: "ines",
    email: "ines.marchetti@2cc.club",
    name: "Ines Marchetti",
    city: "Milan",
    headline: "Creative director, Studio Marchetti",
    bio: "Type, furniture, and one restaurant she refuses to name. Eats early and leaves late.",
    joined: 300,
  },
  {
    key: "priya",
    email: "priya.rajan@2cc.club",
    name: "Priya Rajan",
    city: "Singapore",
    headline: "Portfolio manager, Meridian Family Office",
    bio: "Nine cities a year, one rule: arrive a day early and do something with strangers.",
    joined: 260,
  },
  {
    key: "nadia",
    email: "nadia.haddad@2cc.club",
    name: "Nadia Haddad",
    city: "Dubai",
    headline: "Managing partner, Levant Ventures",
    bio: "On court before the first call of the day. Believes any meeting worth having can be had at 05:40.",
    joined: 520,
  },
  {
    key: "tobias",
    email: "tobias.lindqvist@2cc.club",
    name: "Tobias Lindqvist",
    city: "Stockholm",
    headline: "Founder, Northbound Recovery",
    bio: "Builds cold plunge rooms for gyms in four countries and tests every one of them himself.",
    joined: 480,
  },
  {
    key: "margaux",
    email: "margaux.fontaine@2cc.club",
    name: "Margaux Fontaine",
    city: "Paris",
    headline: "Gallerist, Fontaine Projects",
    bio: "Shows work in half-finished houses and salt sheds. Opens at dusk, closes when the last person leaves.",
    joined: 355,
  },
  {
    key: "henrik",
    email: "henrik.sorensen@2cc.club",
    name: "Henrik Sørensen",
    city: "Copenhagen",
    headline: "Naval architect, Sørensen & Kvist",
    bio: "Draws hulls for a living and can tell you what is wrong with yours from the pontoon.",
    joined: 640,
  },
  {
    key: "aiko",
    email: "aiko.tanaka@2cc.club",
    name: "Aiko Tanaka",
    city: "Tokyo",
    headline: "Potter, Mashiko kiln",
    bio: "Fires with wood four times a year and spends the rest of it deciding what deserves the kiln.",
    joined: 220,
  },
  {
    key: "marcus",
    email: "marcus.osei@2cc.club",
    name: "Marcus Osei",
    city: "London",
    headline: "Structural engineer, Osei Partners",
    bio: "Bridges and roofs. Books the earliest flight and the earliest court wherever he lands.",
    joined: 590,
  },
  {
    key: "clara",
    email: "clara.buhler@2cc.club",
    name: "Clara Bühler",
    city: "Zürich",
    headline: "Radiologist, Klinik Hirslanden",
    bio: "Reads scans all week and wants no screens at all on a Saturday morning.",
    joined: 330,
  },
  {
    key: "youssef",
    email: "youssef.barakat@2cc.club",
    name: "Youssef Barakat",
    city: "Dubai",
    headline: "Head of trading, Gulf Metals",
    bio: "At a desk by seven, so anything worth doing has to happen before it.",
    joined: 275,
  },
  {
    key: "sofia",
    email: "sofia.almeida@2cc.club",
    name: "Sofia Almeida",
    city: "Lisbon",
    headline: "Wine buyer, Adega Almeida",
    bio: "Drives the Douro eleven times a year and brings back things she cannot legally sell yet.",
    joined: 505,
  },
  {
    key: "ravi",
    email: "ravi.menon@2cc.club",
    name: "Ravi Menon",
    city: "Bangkok",
    headline: "Hotelier, Menon Riverside",
    bio: "Thirty-one rooms on the river and a standing rule that staff eat what the guests eat.",
    joined: 445,
  },
  {
    key: "elena",
    email: "elena.novak@2cc.club",
    name: "Elena Novak",
    city: "Vienna",
    headline: "Cellist, Wiener Symphoniker",
    bio: "Tours seven months a year and treats a padel court as the only reliable form of rest.",
    joined: 195,
  },
  {
    key: "duncan",
    email: "duncan.reid@2cc.club",
    name: "Duncan Reid",
    city: "Edinburgh",
    headline: "Distiller, Reid & Sons",
    bio: "Third generation, still fills casks by hand on a Tuesday. Cold water is the family cure for everything.",
    joined: 620,
  },
  {
    key: "camila",
    email: "camila.ruiz@2cc.club",
    name: "Camila Ruiz",
    city: "Madrid",
    headline: "Sports physician, Clínica Ruiz",
    bio: "Patches up sailors and padel players, then takes the same risks herself at the weekend.",
    joined: 380,
  },
  {
    key: "kanya",
    email: "kanya.thongchai@2cc.club",
    name: "Kanya Thongchai",
    city: "Bangkok",
    headline: "Architect, Thongchai Studio",
    bio: "Converts warehouses and shophouses, which is how she met every artist in Talat Noi.",
    joined: 165,
  },
  {
    key: "fiona",
    email: "fiona.brady@2cc.club",
    name: "Fiona Brady",
    city: "Dublin",
    headline: "Producer, Brady Films",
    bio: "Makes documentaries about people who do difficult things outdoors, and then tries them.",
    joined: 240,
  },
];

const userId = (key) => uid(`user:${key}`);

// ---------------------------------------------------------------------------
// Communities
//
// Six communities, all five categories, one host each, and the host's name matches
// the place. Every description does the four things §6 asks for: a named person
// and their work, a cadence, something physical, and one constraint.
// ---------------------------------------------------------------------------

const COMMUNITIES = [
  {
    key: "cap-ferrat",
    slug: "cap-ferrat-sailing-society",
    name: "Cap Ferrat Sailing Society",
    tagline: "Old boats, short crossings, and lunch that runs long.",
    description:
      "Rafael Ortiz keeps nine wooden hulls on the pontoons at Port Hercule and skippers most of them himself. " +
      "Two crossings a month from March to October, always back on the mooring before the evening breeze. " +
      "Twelve places to a boat, and nobody takes the helm until they have crewed two outings.",
    city: "Monaco",
    country: "Monaco",
    category: "sailing",
    host: "rafael",
    isPrivate: false,
    founded: 620,
    currency: "EUR",
    // Single / Trio / Season. Per ticket: 135 → 120 → 110. Season is €660, and
    // six Singles would be €810, so nobody can read the Season as a bulk unit.
    prices: [13500, 36000, 66000],
  },
  {
    key: "es-freus",
    slug: "es-freus-passage",
    name: "Es Freus Passage",
    tagline: "Ibiza to Formentera under sail, back before the ferries.",
    description:
      "Rafael Ortiz sails a 1978 Swan across Es Freus, a boat he rebuilt over four winters. " +
      "Saturdays from May to September, out of Marina Botafoch at 08:20, back by mid-afternoon. " +
      "Eight crew, the engine goes off once we clear the channel, and no swimming before Illetes.",
    city: "Ibiza",
    country: "Spain",
    category: "sailing",
    host: "rafael",
    isPrivate: false,
    founded: 300,
    currency: "EUR",
    // Per ticket: 165 → 150 → 138. Six Singles is €990 against a €828 Season.
    prices: [16500, 45000, 82800],
  },
  {
    key: "cold-room",
    slug: "the-cold-room",
    name: "The Cold Room",
    tagline: "Ice cut by hand at six, then a stove to come back to.",
    description:
      "Wes Calloway cuts the ice at Hallam Lake by hand, six in the morning, before anyone arrives. " +
      "Two rounds in the water and twenty minutes of breathwork, Tuesdays and Saturdays all winter. " +
      "Fourteen places, no watches on the deck, and nobody says their own numbers out loud.",
    city: "Aspen",
    country: "United States",
    category: "wellness",
    host: "wes",
    isPrivate: false,
    founded: 455,
    currency: "USD",
    // Per ticket: 95 → 85 → 78. Six Singles is $570 against a $468 Season.
    prices: [9500, 25500, 46800],
  },
  {
    key: "bica-table",
    slug: "the-bica-table",
    name: "The Bica Table",
    tagline: "One fire, one seating, eight chairs behind the funicular.",
    description:
      "Sebastião Duarte cooks over oak in a room behind the Bica funicular, eight chairs, one seating. " +
      "He buys at the Ribeira market the same morning, so the menu is written around eleven. " +
      "Two dinners a month, doors at 20:10, and Sebastião stops seating anyone after 20:25.",
    city: "Lisbon",
    country: "Portugal",
    category: "dining",
    host: "sebastiao",
    isPrivate: false,
    founded: 690,
    currency: "EUR",
    // Per ticket: 120 → 110 → 102. Six Singles is €720 against a €612 Season.
    prices: [12000, 33000, 61200],
  },
  {
    key: "sunrise-court",
    slug: "the-sunrise-court",
    name: "The Sunrise Court",
    tagline: "Padel at 05:40, drawn pairings, breakfast by eight.",
    description:
      "Latifa Al Marri books four courts at the Jumeirah club from first light, three mornings a week. " +
      "Pairings are drawn at the net, matches run to eleven, and everyone rotates twice before breakfast. " +
      "Sixteen players a session, and you lose your standing place after missing two mornings running.",
    city: "Dubai",
    country: "United Arab Emirates",
    category: "sport",
    host: "latifa",
    isPrivate: false,
    founded: 500,
    currency: "AED",
    // Per ticket: 240 → 220 → 204. Six Singles is 1,440 against a 1,224 Season.
    prices: [24000, 66000, 122400],
  },
  {
    key: "nightform",
    slug: "nightform",
    name: "Nightform",
    tagline: "Studio visits after dark, before the work is shown.",
    description:
      "Ploy Wisetsri takes ten people into a working studio in Talat Noi, always after sundown. " +
      "One visit a month; the artist talks for as long as they want, then everybody eats. " +
      "Nothing is photographed and nothing is priced on the night, and Ploy approves every member herself.",
    city: "Bangkok",
    country: "Thailand",
    category: "art",
    host: "ploy",
    isPrivate: true,
    founded: 280,
    currency: "THB",
    // Per ticket: 3,800 → 3,500 → 3,200. Six Singles is 22,800 against 19,200.
    prices: [380000, 1050000, 1920000],
  },
];

// The `circle:` prefix is a hash input, not a name anyone reads. Renaming it
// would move every seeded UUID for no gain — see the note in src/schema.ts.
const communityId = (key) => uid(`circle:${key}`);

/** Single / Trio / Season, in that display order, priced per community. */
const PACKAGE_TIERS = [
  { name: "Single", tickets: 1, sortOrder: 0 },
  { name: "Trio", tickets: 3, sortOrder: 1 },
  { name: "Season", tickets: 6, sortOrder: 2 },
];

const packageId = (communityKey, name) => uid(`package:${communityKey}:${name}`);

// ---------------------------------------------------------------------------
// Events
//
// Every one of them is in the future, because the day offsets are counted from
// the moment the seed runs. One is tomorrow, one is this coming Saturday, one
// is three months out, and the rest are spread over four calendar months so the
// calendar has somewhere to go in both directions. No start sits on the hour and
// no two durations are copied from each other.
//
// `attendees` are the confirmed bookings. Each name must be an approved member
// of the community and each one spends a ticket from a package, both checked below.
// ---------------------------------------------------------------------------

const EVENTS = [
  // --- Cap Ferrat Sailing Society: six events, five of them published ---
  {
    key: "cf-shakedown",
    community: "cap-ferrat",
    slug: "shakedown-sail-to-villefranche",
    title: "Shakedown Sail to Villefranche",
    summary: "Three boats out of Port Hercule, two hours under sail, then lunch at anchor.",
    description:
      "We slip lines at twenty past nine and work the coast west under sail wherever the wind allows. " +
      "Boats raft up in the bay off Villefranche and lunch is served on deck at one. " +
      "Bring a jacket; it is ten degrees colder off Cap Ferrat than on the terrace.",
    venue: "Port Hercule, Quai des États-Unis",
    city: "Monaco",
    day: 3,
    start: [9, 20],
    endDay: 3,
    end: [14, 5],
    capacity: 12,
    status: "published",
    attendees: ["alexandra", "ines", "henrik", "clara", "duncan", "marcus", "sofia", "aiko", "priya"],
  },
  {
    key: "cf-night-crossing",
    community: "cap-ferrat",
    slug: "night-crossing-to-saint-tropez",
    title: "Night Crossing to Saint-Tropez",
    summary: "Fifty-eight miles west overnight, two watches, and breakfast at anchor off Pampelonne.",
    description:
      "Lines off at ten past nine and the engine stays cold unless the wind dies completely. " +
      "Two watches of five, four hours on and four off, with no coastline in the middle. " +
      "Everyone sleeps on the train home, not on the boat, so plan the morning accordingly.",
    venue: "Port Hercule, Pontoon C",
    city: "Monaco",
    day: 17,
    start: [21, 10],
    endDay: 18,
    end: [8, 35],
    capacity: 10,
    status: "published",
    attendees: ["henrik", "marcus", "duncan", "camila", "elena", "priya"],
  },
  {
    key: "cf-regatta",
    community: "cap-ferrat",
    slug: "regatta-saturday-and-the-lunch-after",
    title: "Regatta Saturday, and the Lunch After",
    summary: "A pursuit race round the Tête de Chien mark, then a table held from two.",
    description:
      "The slowest hull starts first, so the finish is genuinely in doubt until the last mark. " +
      "Crew places go to any member who has already sailed two outings with the society. " +
      "Lunch at the club afterwards is the real event and runs until people stop eating.",
    venue: "Société Nautique de Monaco",
    city: "Monaco",
    day: WEEKEND,
    start: [10, 50],
    endDay: WEEKEND,
    end: [17, 20],
    capacity: 24,
    status: "published",
    attendees: [
      "ines",
      "margaux",
      "camila",
      "henrik",
      "clara",
      "elena",
      "duncan",
      "fiona",
      "marcus",
      "sofia",
      "sebastiao",
    ],
  },
  {
    key: "cf-bonifacio",
    community: "cap-ferrat",
    slug: "the-bonifacio-run",
    title: "The Bonifacio Run",
    summary: "Two days across to Corsica and back, sleeping aboard in the Bouches de Bonifacio.",
    description:
      "Ninety miles south with the boat properly loaded, which is a different kind of sailing. " +
      "We anchor under the cliffs at Bonifacio, eat ashore once, and start back at dawn. " +
      "Eight berths only, and the crossing is called off if the forecast shows twenty-five knots.",
    venue: "Port Hercule, Pontoon C",
    city: "Monaco",
    day: 44,
    start: [6, 50],
    endDay: 45,
    end: [19, 40],
    capacity: 8,
    status: "published",
    attendees: ["henrik", "marcus", "duncan", "camila", "priya"],
  },
  {
    key: "cf-lay-up",
    community: "cap-ferrat",
    slug: "lay-up-day-and-the-long-lunch",
    title: "Lay-Up Day, and the Long Lunch",
    summary: "Winter covers on nine hulls in a morning, then the last table of the year.",
    description:
      "Everything comes off the boats: sails, cushions, electronics, and the brass that Rafael polishes himself. " +
      "Members who turn up for the work get the seats at the table that follows. " +
      "Wear something you do not mind ruining, because the antifouling gets on everyone.",
    venue: "Chantier Naval, Cap d'Ail",
    city: "Cap-d'Ail",
    day: FAR,
    start: [11, 40],
    endDay: FAR,
    end: [16, 10],
    capacity: 20,
    status: "published",
    attendees: ["ines", "sofia", "fiona", "clara"],
  },
  {
    key: "cf-antibes",
    community: "cap-ferrat",
    slug: "spring-delivery-to-antibes",
    title: "Spring Delivery to Antibes",
    summary: "Taking two boats down to Antibes for the spring rigging, and crew are wanted.",
    description:
      "A working delivery rather than a day out, with the sails coming off at the far end. " +
      "Six places, and the date moves with the yard, so it is not confirmed yet.",
    venue: "Port Hercule, Pontoon C",
    city: "Monaco",
    day: 61,
    start: [8, 45],
    endDay: 61,
    end: [15, 55],
    capacity: 6,
    status: "draft",
    attendees: [],
  },

  // --- Es Freus Passage: two events, both still drafts, so this community ---
  // --- has nothing upcoming and the empty state is a real page, not a theory ---
  {
    key: "ef-first-crossing",
    community: "es-freus",
    slug: "first-crossing-of-the-season",
    title: "First Crossing of the Season",
    summary: "The season opens with the run down to Illetes, weather permitting and not before.",
    description:
      "Rafael wants the boat in the water three weeks before this, and it is not yet. " +
      "Eight crew across Es Freus at slack water, lunch on the sand, home by six. " +
      "The date holds only if the yard finishes the rudder bearing, so treat it as provisional.",
    venue: "Marina Botafoch, Pontoon 4",
    city: "Ibiza",
    day: 40,
    start: [8, 20],
    endDay: 40,
    end: [17, 35],
    capacity: 8,
    status: "draft",
    attendees: [],
  },
  {
    key: "ef-formentera",
    community: "es-freus",
    slug: "formentera-overnight",
    title: "Formentera Overnight",
    summary: "Across in the afternoon, a night on the hook at Espalmador, back after breakfast.",
    description:
      "Six berths, one anchorage, and no tender ashore after dark because the reserve forbids it. " +
      "Dates are pencilled while Rafael checks the moorings, so nothing is published for members yet.",
    venue: "Marina Botafoch, Pontoon 4",
    city: "Ibiza",
    day: 74,
    start: [16, 35],
    endDay: 75,
    end: [12, 20],
    capacity: 6,
    status: "draft",
    attendees: [],
  },

  // --- The Cold Room: five events, four published. The first is tomorrow ---
  {
    key: "cr-first-light",
    community: "cold-room",
    slug: "first-light-plunge",
    title: "First Light Plunge",
    summary: "Breathwork on the deck, two rounds in the lake, then the stove in the hut.",
    description:
      "Wes cuts the ice at six, so the water is open by the time anyone arrives. " +
      "Twenty minutes of breathing, two rounds with a long warm gap, and nobody counts out loud. " +
      "Newcomers do one round only and are talked through every part of it beforehand.",
    venue: "Hallam Lake, north shore",
    city: "Aspen",
    day: 1,
    start: [6, 40],
    endDay: 1,
    end: [8, 5],
    capacity: 14,
    status: "published",
    attendees: ["tobias", "priya", "marcus", "clara", "duncan", "elena"],
  },
  {
    key: "cr-heat-first",
    community: "cold-room",
    slug: "heat-first-cold-last",
    title: "Heat First, Cold Last",
    summary: "Ninety minutes of sauna, three rounds, and the cold water saved for the end.",
    description:
      "The session runs backwards, which most people find harder and almost everyone finds better. " +
      "Three rounds of heat in the Castle Creek bunkhouse, then out to the lake at dusk. " +
      "It is done almost entirely without talking, so eat lightly and leave the phone behind.",
    venue: "The Bunkhouse, Castle Creek",
    city: "Aspen",
    day: 10,
    start: [17, 20],
    endDay: 10,
    end: [19, 35],
    capacity: 18,
    status: "published",
    attendees: ["tobias", "priya", "marcus", "clara", "duncan", "elena", "fiona"],
  },
  {
    key: "cr-long-saturday",
    community: "cold-room",
    slug: "the-long-saturday-at-maroon-creek",
    title: "The Long Saturday at Maroon Creek",
    summary: "Six hours outdoors: two rounds in the lake, a walk to the second bench, and lunch.",
    description:
      "The one event of the season where nobody is expected anywhere else afterwards. " +
      "Two rounds in the water either side of a long walk, then heat in the lodge. " +
      "Numbers stop at twenty because the lodge stove cannot dry more towels than that.",
    venue: "Maroon Creek Lodge",
    city: "Aspen",
    day: 29,
    start: [8, 10],
    endDay: 29,
    end: [15, 45],
    capacity: 20,
    status: "published",
    attendees: ["tobias", "priya", "clara", "duncan", "fiona"],
  },
  {
    key: "cr-ice-cutting",
    community: "cold-room",
    slug: "ice-cutting-at-six",
    title: "Ice Cutting at Six",
    summary: "Wes teaches the saw, the chain and the order of cuts, then everyone gets in.",
    description:
      "Twelve people, one ice saw each, and the north shore opened by hand before sunrise. " +
      "It is cold work before the cold work, and it takes about ninety minutes. " +
      "Anyone who has not done a standard session first is turned away at the gate.",
    venue: "Hallam Lake, north shore",
    city: "Aspen",
    day: 55,
    start: [6, 20],
    endDay: 55,
    end: [9, 15],
    capacity: 12,
    status: "published",
    attendees: ["tobias", "marcus", "duncan", "elena"],
  },
  {
    key: "cr-spring-melt",
    community: "cold-room",
    slug: "spring-melt-session",
    title: "Spring Melt Session",
    summary: "The last session before the lake warms past the point of being worth it.",
    description:
      "Wes will not set a date until the ice goes out, which is never the same week. " +
      "Sixteen places when it is called, and members hear about it four days ahead.",
    venue: "Hallam Lake, north shore",
    city: "Aspen",
    day: 86,
    start: [7, 5],
    endDay: 86,
    end: [9, 40],
    capacity: 16,
    status: "draft",
    attendees: [],
  },

  // --- The Bica Table: four published. The first one is sold out ---
  {
    key: "bt-fire-table",
    community: "bica-table",
    slug: "fire-table-xi-the-alentejo-pig",
    title: "Fire Table XI: The Alentejo Pig",
    summary: "One black-footed pig from Barrancos, on the oak from three, served from eight.",
    description:
      "Everything else on the table came off the Ribeira stalls this morning and stays a surprise. " +
      "Eight chairs, one seating, and the door is closed to latecomers at twenty-five past. " +
      "Wine is Alentejano and poured without anyone being asked what they would like.",
    venue: "Casa Duarte, Rua da Bica",
    city: "Lisbon",
    day: 8,
    start: [20, 10],
    endDay: 8,
    end: [23, 40],
    capacity: 8,
    status: "published",
    attendees: ["sofia", "ines", "margaux", "henrik", "aiko", "clara", "duncan", "camila"],
  },
  {
    key: "bt-market-walk",
    community: "bica-table",
    slug: "market-walk-then-breakfast",
    title: "Market Walk, Then Breakfast",
    summary: "Ninety minutes through Campo de Ourique with Sebastião, then breakfast from what we carried out.",
    description:
      "Which fish came in this morning, which came in yesterday, and why he buys the small ones. " +
      "He will also show you how the stallholders are talked out of what they keep behind. " +
      "Twelve people, cash only, and the walk leaves at twenty-five past seven whoever is missing.",
    venue: "Mercado de Campo de Ourique",
    city: "Lisbon",
    day: 21,
    start: [7, 25],
    endDay: 21,
    end: [10, 50],
    capacity: 12,
    status: "published",
    attendees: ["sofia", "ines", "henrik", "aiko", "clara", "camila", "rafael"],
  },
  {
    key: "bt-douro",
    community: "bica-table",
    slug: "the-douro-table",
    title: "The Douro Table",
    summary: "The table leaves Lisbon for one night, on a terrace above the river at Vale Meão.",
    description:
      "Ten people, one long table, and dinner cooked in the quinta's own bread oven. " +
      "We taste from barrel before eating, which is the wrong order and the better one. " +
      "Members arrange their own way up; the morning train to Pocinho is the good answer.",
    venue: "Quinta do Vale Meão",
    city: "Vila Nova de Foz Côa",
    day: 47,
    start: [19, 35],
    endDay: 47,
    end: [23, 25],
    capacity: 10,
    status: "published",
    attendees: ["sofia", "margaux", "henrik", "duncan", "camila", "rafael"],
  },
  {
    key: "bt-sardine",
    community: "bica-table",
    slug: "sardine-season-one-night",
    title: "Sardine Season, One Night",
    summary: "The grill goes out into the street for one night, when the fish are fat enough.",
    description:
      "Fourteen people, bread, sardines and nothing else on the table until the fish run out. " +
      "Sebastião cooks in the doorway and the neighbours bring chairs down, which is the point. " +
      "The night is called four days ahead, because the fish decide and the market confirms.",
    venue: "Rua da Bica, outside the house",
    city: "Lisbon",
    day: 79,
    start: [20, 25],
    endDay: 79,
    end: [23, 55],
    capacity: 14,
    status: "published",
    attendees: ["sofia", "ines", "aiko", "clara", "duncan"],
  },

  // --- The Sunrise Court: three published. The first has one place left ---
  {
    key: "sc-doubles",
    community: "sunrise-court",
    slug: "0540-doubles",
    title: "05:40 Doubles",
    summary: "Two courts, drawn pairings, matches to eleven, and breakfast at the club by eight.",
    description:
      "The standing morning session, played seriously and without anybody being difficult about a line call. " +
      "Pairings are drawn at the net rather than chosen, so the whole community plays together. " +
      "Eight players, and the gate at Jumeirah is locked at twenty to six exactly.",
    venue: "Jumeirah Padel Club, Court 3",
    city: "Dubai",
    day: 2,
    start: [5, 40],
    endDay: 2,
    end: [7, 25],
    capacity: 8,
    status: "published",
    attendees: ["nadia", "youssef", "priya", "marcus", "ravi", "elena", "duncan"],
  },
  {
    key: "sc-desert-ladder",
    community: "sunrise-court",
    slug: "the-desert-ladder",
    title: "The Desert Ladder",
    summary: "Six courts on open sand at Al Marmoom, a full ladder, and shade tents by nine.",
    description:
      "Everyone enters and everyone plays at least four matches, whatever the draw does to them. " +
      "The ladder is redrawn after every round, so the seeding sorts itself out by the end. " +
      "It finishes before the heat arrives, which means the last ball is struck by ten.",
    venue: "Al Marmoom Courts",
    city: "Dubai",
    day: 33,
    start: [6, 15],
    endDay: 33,
    end: [10, 20],
    capacity: 24,
    status: "published",
    attendees: ["nadia", "youssef", "priya", "marcus", "ravi", "elena", "duncan", "tobias"],
  },
  {
    key: "sc-night-courts",
    community: "sunrise-court",
    slug: "night-courts-al-quoz",
    title: "Night Courts, Al Quoz",
    summary: "The one evening session of the season, under lights, for people who cannot do mornings.",
    description:
      "Three courts in the warehouse district, played at the same standard and with the same draw. " +
      "Twelve places, and they go first to members who have missed a morning through work.",
    venue: "Al Quoz Courts, Warehouse 12",
    city: "Dubai",
    day: 66,
    start: [20, 40],
    endDay: 66,
    end: [22, 55],
    capacity: 12,
    status: "published",
    attendees: ["nadia", "youssef", "ravi", "tobias", "marcus"],
  },

  // --- Nightform: three published, and the community is private ---
  {
    key: "nf-talat-noi",
    community: "nightform",
    slug: "studio-visit-talat-noi",
    title: "Studio Visit: Talat Noi",
    summary: "Ten people up three flights to a working studio, and work nobody outside has seen.",
    description:
      "The artist has spent two years on this and it has not left the building yet. " +
      "She will talk for as long as she wants to, and then we eat on the street. " +
      "Nothing is photographed, nothing is priced, and phones stay in the bag by the door.",
    venue: "Soi Wanit 2, third floor",
    city: "Bangkok",
    day: 12,
    start: [19, 25],
    endDay: 12,
    end: [22, 10],
    capacity: 10,
    status: "published",
    attendees: ["ravi", "kanya", "aiko", "priya", "ines"],
  },
  {
    key: "nf-warehouse-hang",
    community: "nightform",
    slug: "the-warehouse-hang",
    title: "The Warehouse Hang",
    summary: "One night a year the community hangs work of its own, off Charoen Krung.",
    description:
      "Members bring one piece each, made or bought or borrowed, and we hang the lot together. " +
      "No labels and no attributions until eleven, at which point everybody argues about who made what. " +
      "Twenty-four places because the room takes it, and Ploy still approves every single name.",
    venue: "Warehouse 30, Charoen Krung",
    city: "Bangkok",
    day: 38,
    start: [18, 50],
    endDay: 38,
    end: [23, 15],
    capacity: 24,
    status: "published",
    attendees: ["ravi", "kanya", "margaux", "ines"],
  },
  {
    key: "nf-kiln-night",
    community: "nightform",
    slug: "kiln-night-in-nonthaburi",
    title: "Kiln Night in Nonthaburi",
    summary: "A wood kiln opened after four days upriver, with everything still too hot to hold.",
    description:
      "We take the boat up at half five and the kiln is unbricked while we watch. " +
      "Twelve people, and nobody touches a pot until the potter says the temperature is safe.",
    venue: "Ban Bang Rak Noi kiln",
    city: "Nonthaburi",
    day: 70,
    start: [17, 35],
    endDay: 70,
    end: [21, 50],
    capacity: 12,
    status: "published",
    attendees: ["ravi", "kanya", "aiko", "priya"],
  },
];

const eventId = (key) => uid(`event:${key}`);

// ---------------------------------------------------------------------------
// Memberships
//
// The host row is added automatically for each community, so these are everybody
// else. Approved counts land on 15, 5, 9, 11, 9 and 7 — none of them a round
// number, and each one is exactly what the community page will count.
// ---------------------------------------------------------------------------

const MEMBERSHIPS = {
  "cap-ferrat": {
    approved: [
      "alexandra",
      "ines",
      "margaux",
      "camila",
      "henrik",
      "clara",
      "elena",
      "duncan",
      "fiona",
      "marcus",
      "sofia",
      "sebastiao",
      "aiko",
      "priya",
    ],
    pending: [],
  },
  "es-freus": {
    approved: ["margaux", "camila", "sofia", "marcus"],
    pending: [],
  },
  "cold-room": {
    approved: ["tobias", "priya", "alexandra", "marcus", "clara", "duncan", "fiona", "elena"],
    pending: [],
  },
  "bica-table": {
    approved: [
      "sofia",
      "alexandra",
      "ines",
      "margaux",
      "henrik",
      "aiko",
      "clara",
      "duncan",
      "camila",
      "rafael",
    ],
    pending: [],
  },
  "sunrise-court": {
    approved: ["nadia", "youssef", "priya", "marcus", "ravi", "elena", "duncan", "tobias"],
    pending: [],
  },
  // The private one. Four requests are sitting with Ploy, and one of them is
  // the demo member's, so the "your request is with the host" state is walkable.
  nightform: {
    approved: ["ravi", "kanya", "aiko", "priya", "ines", "margaux"],
    pending: ["alexandra", "nadia", "elena", "fiona"],
  },
};

/**
 * Packages bought with tickets still on them. Everything else is derived from the
 * bookings, so these are the rows that create the states a booking cannot: a
 * member holding tickets, and a member holding a ticket for an event that is
 * already full.
 */
const SPARE_TICKETS = [
  // Alexandra keeps two tickets on Cap Ferrat after the shakedown sail.
  { user: "alexandra", community: "cap-ferrat", tier: "Trio" },
  // And one unspent ticket at the Bica Table, whose next dinner is sold out.
  { user: "alexandra", community: "bica-table", tier: "Single" },
];

// ---------------------------------------------------------------------------
// Photographs — of which there are none
//
// There is no photography for this product and none can be obtained, so every
// row below has `object_key = null` and the page draws a generated plate from
// `seed`. The caption is doing the work the picture would have done, which is
// why each one names a place or a time and belongs to exactly one community.
//
// Dropping real files into `design/assets/` and writing their keys into
// `object_key` swaps plates for pictures with no code change (see the column
// comment in `src/schema.ts`).
// ---------------------------------------------------------------------------


// --- real photographs -------------------------------------------------------
//
// Files live at design/assets/photos/<group>/NN.jpg and are synced to storage by
// the deploy pipeline. Setting `object_key` makes the UI render an <img> instead
// of a generated plate — the swap the schema was built for.
//
// One group per community, six files each, reused across that community's events.
// A sailing club's evenings all look like sailing, so reuse reads as consistency
// rather than as a shortage.
const PHOTO_GROUP = {
  "cap-ferrat": "sailing-monaco",
  "es-freus": "sailing-ibiza",
  "cold-room": "cold-aspen",
  "bica-table": "dining-lisbon",
  "sunrise-court": "padel-dubai",
  "nightform": "art-bangkok",
};
const PHOTOS_PER_GROUP = 6;

/** `photos/cold-aspen/03.jpg` — the key the /assets/* route serves. */
function photoKey(communityKey, index) {
  const group = PHOTO_GROUP[communityKey];
  if (!group) throw new Error(`no photo group for community "${communityKey}"`);
  const n = (((index % PHOTOS_PER_GROUP) + PHOTOS_PER_GROUP) % PHOTOS_PER_GROUP) + 1;
  return `photos/${group}/${String(n).padStart(2, "0")}.jpg`;
}

const COMMUNITY_PHOTOS = {
  "cap-ferrat": [
    "Pontoon C at Port Hercule, 07:15",
    "Nine hulls with the winter covers off",
    "The committee line under the Tête de Chien",
    "Rafael's tool roll, opened on the coachroof",
    "Anchorage off Villefranche at midday",
    "The long table at the Société Nautique",
  ],
  "es-freus": [
    "Marina Botafoch, Pontoon 4, 08:20",
    "Es Freus at slack water",
    "The 1978 Swan, four winters of work",
    "Illetes seen from the mooring",
    "Sail bags stacked in the Botafoch locker",
  ],
  "cold-room": [
    "Hallam Lake north shore, cut by hand",
    "Wes at six with the saw and the chain",
    "The deck before anyone else arrives",
    "Stove lit in the warming hut",
    "Towels on the rail at 07:40",
    "Thermometer in the cut: two degrees",
    "Boots in the snow outside the hut",
  ],
  "bica-table": [
    "The room behind the Bica funicular",
    "Oak split for the evening fire",
    "Ribeira market at eleven, menu decided",
    "Eight chairs, one seating",
  ],
  "sunrise-court": [
    "Court 3 at Jumeirah, 05:40",
    "The draw sheet clipped to the net post",
    "First light over the back fence",
    "Breakfast laid out at the club, 07:40",
    "Sand courts at Al Marmoom",
  ],
  nightform: [
    "Talat Noi after sundown",
    "Three flights up, Soi Wanit 2",
    "Ploy's approval list, written by hand",
    "Warehouse doors on Charoen Krung",
    "Work that has not left the building",
    "Supper on the street afterwards",
    "The wood kiln at Ban Bang Rak Noi",
    "Ten chairs and no labels",
  ],
};

const EVENT_PHOTOS = {
  "cf-shakedown": [
    "Lines off at 09:20",
    "Villefranche bay from the spreaders",
    "Three boats rafted up for lunch",
    "The jacket everybody forgets",
  ],
  "cf-night-crossing": [
    "Pontoon C at nine in the evening",
    "First watch, no coastline",
    "Breakfast at anchor off Pampelonne",
  ],
  "cf-regatta": [
    "The pursuit start, slowest hull first",
    "Rounding the Tête de Chien mark",
    "Handicaps chalked on the board",
    "Two o'clock, the table held",
    "Kit bags on the club steps",
  ],
  "cf-bonifacio": [
    "Ninety miles south, loaded properly",
    "Cliffs at Bonifacio from the anchorage",
    "Dinner ashore, once",
    "Dawn start for the return",
  ],
  "cf-lay-up": [
    "Covers going on at Cap d'Ail",
    "Sails down, cushions out",
    "Antifouling on everybody's hands",
  ],
  "cf-antibes": [
    "Two boats waiting to be delivered",
    "The yard at Antibes",
    "Rig coming down at the far end",
  ],
  "ef-first-crossing": [
    "Botafoch before the season opens",
    "The rudder bearing, still at the yard",
    "Illetes sand, empty in May",
  ],
  "ef-formentera": [
    "Espalmador anchorage at dusk",
    "Six berths made up",
    "No tender ashore after dark",
  ],
  "cr-first-light": [
    "Ice cut at six, water open",
    "Breathwork on the deck, 06:40",
    "Two rounds, one long warm gap",
    "The stove going in the hut",
  ],
  "cr-heat-first": [
    "The bunkhouse at Castle Creek",
    "Three rounds of heat",
    "Out to the lake at dusk",
    "Nobody talking",
  ],
  "cr-long-saturday": [
    "Maroon Creek Lodge at eight",
    "The walk to the second bench",
    "Lunch at the lodge table",
    "Second round of the day",
    "Twenty towels, one stove",
  ],
  "cr-ice-cutting": [
    "Twelve saws laid out at 06:20",
    "The order of the cuts",
    "North shore opened before sunrise",
  ],
  "cr-spring-melt": [
    "The lake when the ice goes out",
    "Four days' notice, if it comes",
    "Sixteen places, once it is called",
  ],
  "bt-fire-table": [
    "The pig on the oak from three",
    "Ribeira stalls this morning",
    "Door closed at 20:25",
    "Eight chairs set",
    "Alentejano poured without asking",
  ],
  "bt-market-walk": [
    "Campo de Ourique at 07:25",
    "Which fish came in this morning",
    "The small ones, always",
    "Breakfast at the back of the hall",
  ],
  "bt-douro": [
    "The terrace above the river at Vale Meão",
    "Tasting from barrel first",
    "The quinta's bread oven",
    "Morning train to Pocinho",
  ],
  "bt-sardine": [
    "The grill out in Rua da Bica",
    "Bread, sardines, nothing else",
    "Neighbours bringing chairs down",
    "Called four days ahead",
  ],
  "sc-doubles": [
    "Court 3 at twenty to six",
    "The draw at the net",
    "Matches to eleven",
    "Breakfast at the club by eight",
  ],
  "sc-desert-ladder": [
    "Six courts on open sand",
    "The ladder redrawn after every round",
    "Shade tents up by nine",
    "Al Marmoom at 06:15",
    "Last ball struck by ten",
  ],
  "sc-night-courts": [
    "Warehouse 12 under lights",
    "Three courts, the same draw",
    "Twenty to nine in Al Quoz",
  ],
  "nf-talat-noi": [
    "Three flights up, no lift",
    "Two years of work, unseen",
    "Phones in the bag by the door",
    "Street supper afterwards",
  ],
  "nf-warehouse-hang": [
    "Warehouse 30 off Charoen Krung",
    "One piece each, made or borrowed",
    "No labels until eleven",
    "Hanging the lot together",
    "Twenty-four names, all approved",
  ],
  "nf-kiln-night": [
    "The boat upriver at half five",
    "The kiln unbricked while we watch",
    "Still too hot to hold",
  ],
};

// ---------------------------------------------------------------------------
// Build the rows
// ---------------------------------------------------------------------------

/** Split a description into sentences so the §6 length rule can be checked. */
function sentencesOf(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const wordsIn = (sentence) => sentence.split(/\s+/).filter(Boolean).length;

function buildRows() {
  const userByKey = new Map(USERS.map((u) => [u.key, u]));
  const communityByKey = new Map(COMMUNITIES.map((c) => [c.key, c]));
  const tierByName = new Map(PACKAGE_TIERS.map((t) => [t.name, t]));
  const problems = [];

  // --- users ---------------------------------------------------------------

  const users = USERS.map((u) => ({
    id: userId(u.key),
    email: u.email,
    name: u.name,
    city: u.city,
    headline: u.headline,
    bio: u.bio,
    created_at: daysAgo(u.joined),
  }));

  // --- communities and their prices -------------------------------------------

  const communities = COMMUNITIES.map((c) => ({
    id: communityId(c.key),
    slug: c.slug,
    name: c.name,
    tagline: c.tagline,
    description: c.description,
    city: c.city,
    country: c.country,
    category: c.category,
    host_user_id: userId(c.host),
    is_private: c.isPrivate,
    // The first frame of this community's photo group is its cover.
    cover_key: photoKey(c.key, 0),
    created_at: daysAgo(c.founded),
  }));

  const packages = COMMUNITIES.flatMap((c) =>
    PACKAGE_TIERS.map((tier) => ({
      id: packageId(c.key, tier.name),
      circle_id: communityId(c.key),
      name: tier.name,
      // SQL column, unchanged by the rename — see src/schema.ts.
      credits: tier.tickets,
      price_cents: c.prices[tier.sortOrder],
      currency: c.currency,
      active: true,
      sort_order: tier.sortOrder,
      created_at: daysAgo(c.founded),
    })),
  );

  // --- memberships ---------------------------------------------------------

  /** Nobody joins a community before it existed, or before they did. */
  function joinedDaysAgo(communityKey, userKey) {
    const ceiling = Math.min(communityByKey.get(communityKey).founded, userByKey.get(userKey).joined);
    const span = Math.max(1, ceiling - 4);
    return 2 + (hashInt(`joined:${communityKey}:${userKey}`) % span);
  }

  const approvedPairs = new Set();
  const communityMembers = [];

  for (const c of COMMUNITIES) {
    communityMembers.push({
      id: uid(`membership:${c.key}:${c.host}`),
      circle_id: communityId(c.key),
      user_id: userId(c.host),
      role: "host",
      status: "approved",
      created_at: daysAgo(c.founded),
    });
    approvedPairs.add(`${c.key}:${c.host}`);

    const roster = MEMBERSHIPS[c.key] ?? { approved: [], pending: [] };
    for (const key of roster.approved) {
      communityMembers.push({
        id: uid(`membership:${c.key}:${key}`),
        circle_id: communityId(c.key),
        user_id: userId(key),
        role: "member",
        status: "approved",
        created_at: daysAgo(joinedDaysAgo(c.key, key)),
      });
      approvedPairs.add(`${c.key}:${key}`);
    }
    for (const key of roster.pending) {
      communityMembers.push({
        id: uid(`membership:${c.key}:${key}`),
        circle_id: communityId(c.key),
        user_id: userId(key),
        role: "member",
        status: "pending",
        // A request that has been sitting for a fortnight or less.
        created_at: daysAgo(2 + (hashInt(`pending:${c.key}:${key}`) % 12)),
      });
    }
  }

  // --- events ----------------------------------------------------------

  const events = EVENTS.map((e) => ({
    // Borrowed from the community's group. Indexed by POSITION within the community,
    // not by hash: hashing collided and Cap Ferrat's six events shared only
    // three covers, which reads as a bug in a card grid.
    cover_key: photoKey(e.community, 1 + EVENTS.filter((x) => x.community === e.community).findIndex((x) => x.key === e.key)),
    id: eventId(e.key),
    circle_id: communityId(e.community),
    slug: e.slug,
    title: e.title,
    summary: e.summary,
    description: e.description,
    venue: e.venue,
    city: e.city,
    starts_at: at(e.day, e.start[0], e.start[1]),
    ends_at: at(e.endDay, e.end[0], e.end[1]),
    capacity: e.capacity,
    status: e.status,
    created_at: daysAgo(20 + (hashInt(`published:${e.key}`) % 60)),
  }));

  // --- photographs, of which there are none --------------------------------

  /** Which community an event belongs to, so it can borrow that community's photos. */
  const eventCommunityKey = (key) => {
    const found = EVENTS.find((e) => e.key === key);
    if (!found) throw new Error(`unknown event "${key}"`);
    return found.community;
  };

  const photos = [];
  for (const [communityKey, captions] of Object.entries(COMMUNITY_PHOTOS)) {
    captions.forEach((caption, i) => {
      photos.push({
        id: uid(`photo:circle:${communityKey}:${i}`),
        circle_id: communityId(communityKey),
        event_id: null,
        caption,
        seed: `${communityKey}-${String(i + 1).padStart(2, "0")}`,
        object_key: photoKey(communityKey, i),
        sort_order: i,
        created_at: daysAgo(30 + i),
      });
    });
  }
  for (const [eventKey, captions] of Object.entries(EVENT_PHOTOS)) {
    captions.forEach((caption, i) => {
      photos.push({
        id: uid(`photo:event:${eventKey}:${i}`),
        circle_id: null,
        event_id: eventId(eventKey),
        caption,
        seed: `${eventKey}-${String(i + 1).padStart(2, "0")}`,
        object_key: photoKey(eventCommunityKey(eventKey), hashInt(`photo:${eventKey}`) + i),
        sort_order: i,
        created_at: daysAgo(15 + i),
      });
    });
  }

  // --- packages derived from the bookings that spend them --------------------
  //
  // Count what each member booked in each community first, then buy them a package
  // big enough to cover it. That way `credits_used` cannot drift away from the
  // bookings: it IS the number of bookings.

  const bookingsByPair = new Map();
  for (const e of EVENTS) {
    for (const key of e.attendees) {
      const pair = `${e.community}:${key}`;
      if (!bookingsByPair.has(pair)) bookingsByPair.set(pair, []);
      bookingsByPair.get(pair).push(e);
    }
  }

  const spareByPair = new Map(SPARE_TICKETS.map((s) => [`${s.community}:${s.user}`, s.tier]));

  /** Smallest tier that covers `n`, bumped a size for roughly a third of buyers. */
  function tierFor(pair, n) {
    const named = spareByPair.get(pair);
    if (named) return tierByName.get(named);
    const generous = hashInt(`tier:${pair}`) % 3 === 0;
    if (n <= 1) return tierByName.get(generous ? "Trio" : "Single");
    if (n <= 3) return tierByName.get(generous ? "Season" : "Trio");
    return tierByName.get("Season");
  }

  const pairs = new Set([...bookingsByPair.keys(), ...spareByPair.keys()]);
  const orders = [];
  const memberPackages = [];
  const memberPackageIdByPair = new Map();
  const references = new Set();

  for (const pair of [...pairs].sort()) {
    const [communityKey, userKey] = pair.split(":");
    const community = communityByKey.get(communityKey);
    const booked = bookingsByPair.get(pair) ?? [];
    const tier = tierFor(pair, booked.length);
    const joined = joinedDaysAgo(communityKey, userKey);
    const bought = 1 + (hashInt(`bought:${pair}`) % Math.max(1, joined - 2));

    orders.push({
      id: uid(`order:${pair}`),
      user_id: userId(userKey),
      circle_id: communityId(communityKey),
      package_id: packageId(communityKey, tier.name),
      reference: distinctCode(references, `order:${pair}`, 6, (c) => `2CC-${c}`),
      // SQL column, unchanged by the rename — see src/schema.ts.
      credits: tier.tickets,
      amount_cents: community.prices[tier.sortOrder],
      currency: community.currency,
      status: "paid",
      created_at: daysAgo(bought),
    });
    memberPackages.push({
      id: uid(`pass:${pair}`),
      user_id: userId(userKey),
      circle_id: communityId(communityKey),
      order_id: uid(`order:${pair}`),
      credits_total: tier.tickets,
      credits_used: booked.length,
      created_at: daysAgo(bought),
    });
    memberPackageIdByPair.set(pair, { id: uid(`pass:${pair}`), bought, tier });
  }

  // --- bookings ------------------------------------------------------------

  const bookings = [];
  const ticketCodes = new Set();
  for (const e of EVENTS) {
    for (const key of e.attendees) {
      const pair = `${e.community}:${key}`;
      const held = memberPackageIdByPair.get(pair);
      bookings.push({
        id: uid(`booking:${e.key}:${key}`),
        event_id: eventId(e.key),
        user_id: userId(key),
        pass_id: held.id,
        code: distinctCode(ticketCodes, `booking:${e.key}:${key}`, 4, (c) => `2CC-TKT-${c}`),
        status: "confirmed",
        created_at: daysAgo(1 + (hashInt(`booked:${e.key}:${key}`) % Math.max(1, held.bought))),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Refuse to write a world that would make a page lie
  // -------------------------------------------------------------------------

  // §6: two to four sentences, twelve to twenty words each.
  for (const c of COMMUNITIES) {
    const parts = sentencesOf(c.description);
    if (parts.length < 2 || parts.length > 4) {
      problems.push(`${c.key}: description has ${parts.length} sentences, wanted 2 to 4`);
    }
    parts.forEach((s, i) => {
      const n = wordsIn(s);
      if (n < 12 || n > 20) problems.push(`${c.key}: sentence ${i + 1} is ${n} words — "${s}"`);
    });
    if (!c.description.includes(userByKey.get(c.host).name.split(" ")[0])) {
      problems.push(`${c.key}: the description never names its host`);
    }
  }
  for (const e of EVENTS) {
    for (const [i, s] of sentencesOf(e.description).entries()) {
      const n = wordsIn(s);
      if (n < 12 || n > 20) problems.push(`${e.key}: sentence ${i + 1} is ${n} words — "${s}"`);
    }
    const n = wordsIn(e.summary);
    if (n < 12 || n > 20) problems.push(`${e.key}: summary is ${n} words`);
  }

  // Prices: the ladder falls per ticket, and a Season is never six Singles.
  for (const c of COMMUNITIES) {
    const perTicket = PACKAGE_TIERS.map((t) => c.prices[t.sortOrder] / t.tickets);
    if (!(perTicket[0] > perTicket[1] && perTicket[1] > perTicket[2])) {
      problems.push(`${c.key}: price per ticket does not fall across the three packages`);
    }
    if (c.prices[2] === c.prices[0] * 6) problems.push(`${c.key}: the Season is exactly six Singles`);
    for (const p of c.prices) {
      if (p % 100 !== 0) problems.push(`${c.key}: ${p} cents will not print without a decimal point`);
    }
  }

  // Events: in the future, never on the hour, never over capacity, and
  // every attendee an approved member.
  for (const e of EVENTS) {
    const starts = at(e.day, e.start[0], e.start[1]);
    const ends = at(e.endDay, e.end[0], e.end[1]);
    if (starts <= NOW) problems.push(`${e.key}: starts in the past`);
    if (ends <= starts) problems.push(`${e.key}: ends before it starts`);
    if (e.start[1] === 0) problems.push(`${e.key}: starts on the hour`);
    if (e.attendees.length > e.capacity) problems.push(`${e.key}: more attendees than places`);
    if (e.status !== "published" && e.attendees.length > 0) {
      problems.push(`${e.key}: an unpublished event cannot have attendees`);
    }
    for (const key of e.attendees) {
      if (!approvedPairs.has(`${e.community}:${key}`)) {
        problems.push(`${e.key}: ${key} is booked but is not an approved member`);
      }
    }
    if (new Set(e.attendees).size !== e.attendees.length) {
      problems.push(`${e.key}: the same member is booked twice`);
    }
  }

  // Packages: tickets left is never negative, and used always equals the bookings.
  for (const p of memberPackages) {
    if (p.credits_used > p.credits_total) {
      problems.push(`package ${p.id}: ${p.credits_used} tickets spent out of ${p.credits_total}`);
    }
  }

  // The four staged states §8 asks for, each of them exactly one.
  const full = EVENTS.filter((e) => e.status === "published" && e.attendees.length === e.capacity);
  const oneLeft = EVENTS.filter(
    (e) => e.status === "published" && e.capacity - e.attendees.length === 1,
  );
  const empty = COMMUNITIES.filter(
    (c) => !EVENTS.some((e) => e.community === c.key && e.status === "published"),
  );
  const privateWithPending = COMMUNITIES.filter(
    (c) => c.isPrivate && (MEMBERSHIPS[c.key]?.pending.length ?? 0) > 0,
  );
  if (full.length !== 1) problems.push(`wanted exactly one sold-out event, found ${full.length}`);
  if (oneLeft.length !== 1) {
    problems.push(`wanted exactly one event with a single place, found ${oneLeft.length}`);
  }
  if (empty.length !== 1) {
    problems.push(`wanted exactly one community with nothing upcoming, found ${empty.length}`);
  }
  if (privateWithPending.length !== 1) {
    problems.push(`wanted exactly one private community with requests, found ${privateWithPending.length}`);
  }

  // Event counts, and the dates §8 names.
  for (const c of COMMUNITIES) {
    const n = EVENTS.filter((e) => e.community === c.key).length;
    if (n < 2 || n > 6) problems.push(`${c.key}: has ${n} events, wanted between 2 and 6`);
  }
  if (!EVENTS.some((e) => e.day === 1)) problems.push("nothing is happening tomorrow");
  if (!EVENTS.some((e) => e.day === WEEKEND)) problems.push("nothing is happening this weekend");
  if (!EVENTS.some((e) => e.day >= 85)) problems.push("nothing is three months out");
  const months = new Set(
    EVENTS.filter((e) => e.status === "published").map((e) => {
      const d = at(e.day, e.start[0], e.start[1]);
      return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    }),
  );
  if (months.size < 3) problems.push(`published events only span ${months.size} months`);

  // Photographs: four to eight a community, three to five an event, and each
  // row hangs off exactly one parent.
  for (const c of COMMUNITIES) {
    const n = (COMMUNITY_PHOTOS[c.key] ?? []).length;
    if (n < 4 || n > 8) problems.push(`${c.key}: has ${n} frames, wanted between 4 and 8`);
  }
  for (const e of EVENTS) {
    const n = (EVENT_PHOTOS[e.key] ?? []).length;
    if (n < 3 || n > 5) problems.push(`${e.key}: has ${n} frames, wanted between 3 and 5`);
  }
  for (const p of photos) {
    if (Boolean(p.circle_id) === Boolean(p.event_id)) {
      problems.push(`photo ${p.id}: belongs to both a community and an event, or to neither`);
    }
  }
  const captions = photos.map((p) => p.caption);
  if (new Set(captions).size !== captions.length) problems.push("two frames share a caption");

  // The demo accounts have to keep working.
  for (const email of ["member@2cc.club", "host@2cc.club"]) {
    if (!USERS.some((u) => u.email === email)) problems.push(`the ${email} demo account is missing`);
  }

  if (problems.length > 0) {
    throw new Error(`the seeded world is inconsistent:\n  - ${problems.join("\n  - ")}`);
  }

  return {
    users,
    communities,
    packages,
    communityMembers,
    events,
    photos,
    orders,
    memberPackages,
    bookings,
  };
}

// ---------------------------------------------------------------------------
// Write it
// ---------------------------------------------------------------------------

async function main() {
  const rows = buildRows();
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

  try {
    await sql.begin(async (tx) => {
      // Children first: every one of these is a foreign key away from the next.
      // The two wallet tables have no seeded rows on purpose -- the demo starts
      // every member on a zero balance, so the top-up is a step you can watch.
      // They are still cleared, or a reseed would leave money belonging to
      // users that no longer exist.
      await tx`delete from wallet_txns`;
      await tx`delete from wallets`;
      await tx`delete from bookings`;
      await tx`delete from passes`;
      await tx`delete from orders`;
      await tx`delete from packages`;
      await tx`delete from photos`;
      await tx`delete from events`;
      await tx`delete from circle_members`;
      await tx`delete from sessions`;
      await tx`delete from circles`;
      await tx`delete from users`;

      await tx`insert into users ${tx(rows.users)}`;
      await tx`insert into circles ${tx(rows.communities)}`;
      await tx`insert into circle_members ${tx(rows.communityMembers)}`;
      await tx`insert into packages ${tx(rows.packages)}`;
      await tx`insert into events ${tx(rows.events)}`;
      await tx`insert into photos ${tx(rows.photos)}`;
      await tx`insert into orders ${tx(rows.orders)}`;
      await tx`insert into passes ${tx(rows.memberPackages)}`;
      await tx`insert into bookings ${tx(rows.bookings)}`;
    });

    const counts = await sql`
      select 'users' as "table", count(*)::int as "rows" from users
      union all select 'sessions', count(*)::int from sessions
      union all select 'circles', count(*)::int from circles
      union all select 'circle_members', count(*)::int from circle_members
      union all select 'events', count(*)::int from events
      union all select 'photos', count(*)::int from photos
      union all select 'packages', count(*)::int from packages
      union all select 'orders', count(*)::int from orders
      union all select 'passes', count(*)::int from passes
      union all select 'bookings', count(*)::int from bookings
      union all select 'wallets', count(*)::int from wallets
      union all select 'wallet_txns', count(*)::int from wallet_txns
    `;

    console.log("Seeded 2CC:");
    for (const row of counts) console.log(`  ${String(row.table).padEnd(15)} ${row.rows}`);
    console.log("\nSign in as member@2cc.club (Alexandra Voss) or host@2cc.club (Rafael Ortiz).");
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nSeed failed: ${message}`);
  if (/relation .* does not exist/i.test(message)) {
    console.error("The tables are missing. Run `npm run db:migrate` first.");
  }
  process.exit(1);
});
