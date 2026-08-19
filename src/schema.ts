/**
 * Your database tables live here.
 *
 * This is a Drizzle schema: each table is described once, in TypeScript, and
 * that description gives you both the SQL to create it and the types your
 * queries return. Change a column here and your editor tells you which queries
 * broke — that is the whole point of keeping it in one file.
 *
 * The shape below is 2CC (see `design/reference/spec.md`): communities run
 * events, members buy packages, a booking spends one ticket from a package.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SQL NAMES DO NOT MATCH THE TYPESCRIPT NAMES
 *
 * The product used to say circle, gathering, pass and credit. It now says
 * community, event, package and ticket — the owner's words — and every
 * TypeScript name here was renamed to match. **The SQL names were not.** So on
 * this page you will read, and this is deliberate:
 *
 *   export const communities   = pgTable("circles",        …)
 *   export const communityMembers = pgTable("circle_members", …)
 *   export const memberPackages   = pgTable("passes",        …)
 *   communityId: text("circle_id")
 *   tickets:     integer("credits")
 *   ticketsTotal: integer("credits_total")
 *   memberPackageId: text("pass_id")
 *
 * Drizzle maps a TypeScript name to a SQL name, so the code can read like the
 * product while the tables keep the names they were created with. Renaming the
 * tables would mean a migration against CockroachDB, whose tables here are
 * `schema_locked` and **reject every `ALTER TABLE`** — plus a regenerated
 * `src/bootstrap-sql.ts` and orphaned tables left behind in production. Real
 * risk, and nothing a user would ever see.
 *
 * So: if a name is inside a string in this file, it is a SQL name and it stays.
 * If it is a TypeScript identifier, it uses the product's vocabulary. The same
 * rule holds in raw `sql` fragments and in `scripts/seed.mjs` row literals,
 * whose keys are column names.
 * ---------------------------------------------------------------------------
 *
 * Conventions used throughout:
 *   - ids are `text` from `crypto.randomUUID()` — no database sequences.
 *   - timestamps are `timestamp with time zone`; UTC in, UTC out.
 *   - money is an integer count of cents. Never a float.
 *   - the small string unions (`role`, `status`, `category`) are plain `text`
 *     columns with a TypeScript enum attached, so widening the set later is a
 *     code change and not a database migration.
 *
 * After ANY change here, generate and apply a migration:
 *
 *   npm run db:generate     # writes the SQL into drizzle/
 *   npm run db:migrate      # applies it to your LOCAL database
 *
 * Commit the generated SQL. A schema nobody can reproduce is a schema that
 * breaks on the next machine.
 */
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** The five kinds of community the directory filters by (spec, screen 2). */
export const COMMUNITY_CATEGORIES = ["sailing", "wellness", "dining", "sport", "art"] as const;
export type CommunityCategory = (typeof COMMUNITY_CATEGORIES)[number];

/** A member either runs the community or belongs to it. */
export const MEMBER_ROLES = ["host", "member"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Joining a private community waits on the host; a public one is approved at once. */
export const MEMBERSHIP_STATUSES = ["pending", "approved", "declined"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** An event is invisible to members until it is published. */
export const EVENT_STATUSES = ["draft", "published", "cancelled"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Checkout is a mock (spec, non-goals), so an order only settles or reverses. */
export const ORDER_STATUSES = ["paid", "refunded"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Cancelling a booking returns the ticket rather than deleting the row. */
export const BOOKING_STATUSES = ["confirmed", "cancelled"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * A signed-in person. Sign-in is email + name only — no password, no magic
 * link (spec, non-goals) — so the email IS the identity and has to be unique.
 */
export const users = pgTable(
  "users",
  {
    // `text` ids from crypto.randomUUID() keep inserts simple and avoid
    // depending on the database to hand out numbers.
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    /** Where they are based. Shown on the host byline; optional. */
    city: text("city"),
    /** One line of standing, e.g. "Founder, Aster Capital". */
    headline: text("headline"),
    bio: text("bio"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Sign-in looks a user up by email on every request that creates a session,
  // so this is the hot path. Unique here doubles as the identity constraint.
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/**
 * One signed-in browser. The row id IS the opaque token stored in the cookie,
 * so a session is validated with a single primary-key lookup and revoked by
 * deleting the row.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * One pending message, written just before a 302 and read-and-cleared by
     * the page that renders it. It lives on the session rather than in the
     * query string because a query string survives a reload and re-announces a
     * result that already happened. Null means there is nothing to announce.
     */
    flash: text("flash"),
  },
  // Signing out everywhere means deleting every session for one user.
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

/**
 * A community — the community itself ("Cap Ferrat Sailing Society"). Everything
 * else in this schema hangs off one: its events, its packages, its members.
 */
export const communities = pgTable(
  "circles",
  {
    id: text("id").primaryKey(),
    /** The URL segment: `/communities/:slug`. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** The one-line hook under the name on a card. */
    tagline: text("tagline").notNull(),
    description: text("description").notNull(),
    city: text("city").notNull(),
    country: text("country").notNull(),
    category: text("category", { enum: COMMUNITY_CATEGORIES }).notNull(),
    hostUserId: text("host_user_id")
      .notNull()
      .references(() => users.id),
    /** True means joining needs the host's approval before it counts. */
    isPrivate: boolean("is_private").notNull().default(false),
    /**
     * The cover photograph, as a key under `design/assets/` — e.g.
     * `photos/cold-aspen/01.jpg`. Null falls back to the generated plate, so the
     * app works with or without photography.
     */
    coverKey: text("cover_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Every community page is reached by slug; the directory filters by category;
    // the host console lists "my communities".
    uniqueIndex("circles_slug_idx").on(t.slug),
    index("circles_category_idx").on(t.category),
    index("circles_host_user_id_idx").on(t.hostUserId),
  ],
);

export type Community = typeof communities.$inferSelect;
export type NewCommunity = typeof communities.$inferInsert;

/**
 * Who belongs to which community, and whether the host has said yes yet. The host
 * gets a row too (`role: "host"`), so member counts and access checks are one
 * query rather than two.
 */
export const communityMembers = pgTable(
  "circle_members",
  {
    id: text("id").primaryKey(),
    communityId: text("circle_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: MEMBER_ROLES }).notNull(),
    status: text("status", { enum: MEMBERSHIP_STATUSES }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One membership per person per community — the database refuses a duplicate
    // join request rather than trusting the handler to check first. Doubles as
    // the index the community page counts and lists members with.
    uniqueIndex("circle_members_circle_user_idx").on(t.communityId, t.userId),
    // "Communities I have joined", on /account.
    index("circle_members_user_id_idx").on(t.userId),
  ],
);

export type CommunityMember = typeof communityMembers.$inferSelect;
export type NewCommunityMember = typeof communityMembers.$inferInsert;

/**
 * An event: one community, one date, one venue. `capacity` is the ceiling;
 * places left is `capacity` minus confirmed bookings, counted at read time.
 */
export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    communityId: text("circle_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    /** The URL segment: `/events/:slug`. */
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    /** A sentence or two for the card. */
    summary: text("summary").notNull(),
    description: text("description").notNull(),
    venue: text("venue").notNull(),
    city: text("city").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    capacity: integer("capacity").notNull(),
    status: text("status", { enum: EVENT_STATUSES }).notNull().default("published"),
    /**
     * The cover photograph, as a key under `design/assets/` — e.g.
     * `photos/cold-aspen/03.jpg`. Null falls back to the generated plate, so the
     * app works with or without photography.
     */
    coverKey: text("cover_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The calendar is "published, in the future, soonest first" — that one
    // query reads three of these four.
    index("events_circle_id_idx").on(t.communityId),
    index("events_starts_at_idx").on(t.startsAt),
    uniqueIndex("events_slug_idx").on(t.slug),
    index("events_status_idx").on(t.status),
  ],
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

/**
 * What a community sells: Single (1 ticket), Trio (3) and Season (6). Priced per
 * community, so the same three names cost different amounts in Monaco and Aspen.
 * `active: false` retires a price without breaking the orders that used it.
 */
export const packages = pgTable(
  "packages",
  {
    id: text("id").primaryKey(),
    communityId: text("circle_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tickets: integer("credits").notNull(),
    /** Integer cents. `formatMoney` in `src/lib/format.ts` renders it. */
    priceCents: integer("price_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    active: boolean("active").notNull().default(true),
    /** Display order on the community page: Single 0, Trio 1, Season 2. */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("packages_circle_id_idx").on(t.communityId)],
);

export type Package = typeof packages.$inferSelect;
export type NewPackage = typeof packages.$inferInsert;

/**
 * The record of a mock checkout (spec, non-goals: no real payments). Kept
 * separate from the package it creates so the receipt survives the tickets being
 * spent, and so `reference` can be quoted back to a member.
 */
export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    communityId: text("circle_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id),
    /** Human-readable, quotable: `2CC-8F3K2M`. See `orderReference()`. */
    reference: text("reference").notNull(),
    /** Copied from the package, not joined — a later price change must not
     * rewrite what someone already paid. */
    tickets: integer("credits").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    status: text("status", { enum: ORDER_STATUSES }).notNull().default("paid"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("orders_reference_idx").on(t.reference),
    index("orders_user_id_idx").on(t.userId),
    index("orders_circle_id_idx").on(t.communityId),
  ],
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

/**
 * Prepaid tickets for ONE community. Booking an event spends one
 * (`ticketsUsed + 1`), cancelling hands it back. Tickets left is
 * `ticketsTotal - ticketsUsed`; never let that go negative.
 */
export const memberPackages = pgTable(
  "passes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    communityId: text("circle_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    ticketsTotal: integer("credits_total").notNull(),
    ticketsUsed: integer("credits_used").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // "Can this member book this event?" reads both columns at once.
  (t) => [index("passes_user_circle_idx").on(t.userId, t.communityId)],
);

export type MemberPackage = typeof memberPackages.$inferSelect;
export type NewMemberPackage = typeof memberPackages.$inferInsert;

/**
 * A place at an event, paid for out of a package. `code` is the ticket the
 * member is shown at `/account/tickets/:code`, so it is unique and looked up
 * on its own.
 */
export const bookings = pgTable(
  "bookings",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    memberPackageId: text("pass_id")
      .notNull()
      .references(() => memberPackages.id),
    /** `2CC-TKT-4QX9`. See `ticketCode()`. */
    code: text("code").notNull(),
    status: text("status", { enum: BOOKING_STATUSES }).notNull().default("confirmed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One place per member per event, enforced by the database rather than
    // by a check-then-insert that two fast clicks can race past.
    uniqueIndex("bookings_event_user_idx").on(t.eventId, t.userId),
    uniqueIndex("bookings_code_idx").on(t.code),
    // "My upcoming bookings" on /account.
    index("bookings_user_id_idx").on(t.userId),
    // "Who is coming" in the host console.
    index("bookings_event_id_idx").on(t.eventId),
  ],
);

export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;

/**
 * The gallery strip on a community page or an event page. One row is one frame
 * in the scroller, ordered by `sortOrder`.
 *
 * Exactly one of `communityId` / `eventId` is set on a row: a frame belongs either
 * to a community's archive or to one event, never to both and never to
 * neither. Both are nullable so the same table serves both scrollers, and both
 * cascade so deleting a community or an event takes its frames with it.
 *
 * `caption` is not decoration. There is no photography in this product, so the
 * caption carries the information a photograph would have carried — a place and
 * a time, written specifically ("The pump house, 06:30"), never a mood.
 *
 * `seed` is the string the plate generator hashes. Keeping it in the row rather
 * than deriving it from the caption means two frames can share a caption and
 * still draw differently, and that a frame's drawing never changes when someone
 * edits its words.
 */
export const photos = pgTable(
  "photos",
  {
    id: text("id").primaryKey(),
    /** Set on a community-archive frame; null on an event frame. */
    communityId: text("circle_id").references(() => communities.id, { onDelete: "cascade" }),
    /** Set on an event frame; null on a community-archive frame. */
    eventId: text("event_id").references(() => events.id, { onDelete: "cascade" }),
    caption: text("caption").notNull(),
    /** Drives the generated plate: guilloché parameters are hashed out of this. */
    seed: text("seed").notNull(),
    /**
     * THE UPGRADE PATH TO REAL PHOTOGRAPHY. Two states, one component:
     *
     *   null  -> the UI renders a generated plate from `seed`. This is what the
     *            whole seeded world uses today, because there is no photography
     *            and none can be obtained.
     *   set   -> the UI renders `<img src="/assets/…">` for this R2 key, served
     *            by the `/assets/*` route in `src/index.ts`.
     *
     * So dropping real photographs into `design/assets/` and writing their keys
     * into this column swaps the plates for pictures with NO code change — the
     * component branches on null, nothing else does. Keys live under the
     * reserved `assets/` prefix (AGENTS.md §5); never put a user upload here.
     */
    objectKey: text("object_key"),
    /** Position in the scroller, ascending. Ties fall back to `createdAt`. */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Both scrollers read "every frame for this parent, in order" — one index
    // each, because a community frame and an event frame are never fetched
    // together.
    index("photos_circle_id_idx").on(t.communityId),
    index("photos_event_id_idx").on(t.eventId),
  ],
);

export type Photo = typeof photos.$inferSelect;
export type NewPhoto = typeof photos.$inferInsert;
