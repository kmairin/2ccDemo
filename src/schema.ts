/**
 * Your database tables live here.
 *
 * This is a Drizzle schema: each table is described once, in TypeScript, and
 * that description gives you both the SQL to create it and the types your
 * queries return. Change a column here and your editor tells you which queries
 * broke — that is the whole point of keeping it in one file.
 *
 * The shape below is 2CC (see `design/reference/spec.md`): circles run
 * gatherings, members buy passes, a booking spends one credit from a pass.
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

/** The five kinds of circle the directory filters by (spec, screen 2). */
export const CIRCLE_CATEGORIES = ["sailing", "wellness", "dining", "sport", "art"] as const;
export type CircleCategory = (typeof CIRCLE_CATEGORIES)[number];

/** A member either runs the circle or belongs to it. */
export const MEMBER_ROLES = ["host", "member"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Joining a private circle waits on the host; a public one is approved at once. */
export const MEMBERSHIP_STATUSES = ["pending", "approved", "declined"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** A gathering is invisible to members until it is published. */
export const EVENT_STATUSES = ["draft", "published", "cancelled"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Checkout is a mock (spec, non-goals), so an order only settles or reverses. */
export const ORDER_STATUSES = ["paid", "refunded"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Cancelling a booking returns the credit rather than deleting the row. */
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
 * A circle — the community itself ("Cap Ferrat Sailing Society"). Everything
 * else in this schema hangs off one: its gatherings, its passes, its members.
 */
export const circles = pgTable(
  "circles",
  {
    id: text("id").primaryKey(),
    /** The URL segment: `/circles/:slug`. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** The one-line hook under the name on a card. */
    tagline: text("tagline").notNull(),
    description: text("description").notNull(),
    city: text("city").notNull(),
    country: text("country").notNull(),
    category: text("category", { enum: CIRCLE_CATEGORIES }).notNull(),
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
    // Every circle page is reached by slug; the directory filters by category;
    // the host console lists "my circles".
    uniqueIndex("circles_slug_idx").on(t.slug),
    index("circles_category_idx").on(t.category),
    index("circles_host_user_id_idx").on(t.hostUserId),
  ],
);

export type Circle = typeof circles.$inferSelect;
export type NewCircle = typeof circles.$inferInsert;

/**
 * Who belongs to which circle, and whether the host has said yes yet. The host
 * gets a row too (`role: "host"`), so member counts and access checks are one
 * query rather than two.
 */
export const circleMembers = pgTable(
  "circle_members",
  {
    id: text("id").primaryKey(),
    circleId: text("circle_id")
      .notNull()
      .references(() => circles.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: MEMBER_ROLES }).notNull(),
    status: text("status", { enum: MEMBERSHIP_STATUSES }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One membership per person per circle — the database refuses a duplicate
    // join request rather than trusting the handler to check first. Doubles as
    // the index the circle page counts and lists members with.
    uniqueIndex("circle_members_circle_user_idx").on(t.circleId, t.userId),
    // "Circles I have joined", on /account.
    index("circle_members_user_id_idx").on(t.userId),
  ],
);

export type CircleMember = typeof circleMembers.$inferSelect;
export type NewCircleMember = typeof circleMembers.$inferInsert;

/**
 * A gathering: one circle, one date, one venue. `capacity` is the ceiling;
 * places left is `capacity` minus confirmed bookings, counted at read time.
 */
export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    circleId: text("circle_id")
      .notNull()
      .references(() => circles.id, { onDelete: "cascade" }),
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
    index("events_circle_id_idx").on(t.circleId),
    index("events_starts_at_idx").on(t.startsAt),
    uniqueIndex("events_slug_idx").on(t.slug),
    index("events_status_idx").on(t.status),
  ],
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

/**
 * What a circle sells: Single (1 credit), Trio (3) and Season (6). Priced per
 * circle, so the same three names cost different amounts in Monaco and Aspen.
 * `active: false` retires a price without breaking the orders that used it.
 */
export const packages = pgTable(
  "packages",
  {
    id: text("id").primaryKey(),
    circleId: text("circle_id")
      .notNull()
      .references(() => circles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    credits: integer("credits").notNull(),
    /** Integer cents. `formatMoney` in `src/lib/format.ts` renders it. */
    priceCents: integer("price_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    active: boolean("active").notNull().default(true),
    /** Display order on the circle page: Single 0, Trio 1, Season 2. */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("packages_circle_id_idx").on(t.circleId)],
);

export type Package = typeof packages.$inferSelect;
export type NewPackage = typeof packages.$inferInsert;

/**
 * The record of a mock checkout (spec, non-goals: no real payments). Kept
 * separate from the pass it creates so the receipt survives the credits being
 * spent, and so `reference` can be quoted back to a member.
 */
export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    circleId: text("circle_id")
      .notNull()
      .references(() => circles.id, { onDelete: "cascade" }),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id),
    /** Human-readable, quotable: `2CC-8F3K2M`. See `orderReference()`. */
    reference: text("reference").notNull(),
    /** Copied from the package, not joined — a later price change must not
     * rewrite what someone already paid. */
    credits: integer("credits").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    status: text("status", { enum: ORDER_STATUSES }).notNull().default("paid"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("orders_reference_idx").on(t.reference),
    index("orders_user_id_idx").on(t.userId),
    index("orders_circle_id_idx").on(t.circleId),
  ],
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

/**
 * Prepaid credits for ONE circle. Booking a gathering spends one
 * (`creditsUsed + 1`), cancelling hands it back. Credits left is
 * `creditsTotal - creditsUsed`; never let that go negative.
 */
export const passes = pgTable(
  "passes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    circleId: text("circle_id")
      .notNull()
      .references(() => circles.id, { onDelete: "cascade" }),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    creditsTotal: integer("credits_total").notNull(),
    creditsUsed: integer("credits_used").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // "Can this member book this gathering?" reads both columns at once.
  (t) => [index("passes_user_circle_idx").on(t.userId, t.circleId)],
);

export type Pass = typeof passes.$inferSelect;
export type NewPass = typeof passes.$inferInsert;

/**
 * A place at a gathering, paid for out of a pass. `code` is the ticket the
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
    passId: text("pass_id")
      .notNull()
      .references(() => passes.id),
    /** `2CC-TKT-4QX9`. See `ticketCode()`. */
    code: text("code").notNull(),
    status: text("status", { enum: BOOKING_STATUSES }).notNull().default("confirmed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One place per member per gathering, enforced by the database rather than
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
 * The gallery strip on a circle page or a gathering page. One row is one frame
 * in the scroller, ordered by `sortOrder`.
 *
 * Exactly one of `circleId` / `eventId` is set on a row: a frame belongs either
 * to a circle's archive or to one gathering, never to both and never to
 * neither. Both are nullable so the same table serves both scrollers, and both
 * cascade so deleting a circle or a gathering takes its frames with it.
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
    /** Set on a circle-archive frame; null on a gathering frame. */
    circleId: text("circle_id").references(() => circles.id, { onDelete: "cascade" }),
    /** Set on a gathering frame; null on a circle-archive frame. */
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
    // each, because a circle frame and a gathering frame are never fetched
    // together.
    index("photos_circle_id_idx").on(t.circleId),
    index("photos_event_id_idx").on(t.eventId),
  ],
);

export type Photo = typeof photos.$inferSelect;
export type NewPhoto = typeof photos.$inferInsert;
