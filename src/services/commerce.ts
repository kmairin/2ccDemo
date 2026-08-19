/**
 * Money and places: what a community sells, buying it, spending a ticket on a
 * event, and handing the ticket back.
 *
 * The three mutations here each land as ONE `batch()` from `src/db.ts` — all of
 * it or none of it. `db.transaction()` throws on this platform (see that file),
 * and two separate awaits would leave a package charged for a booking that never
 * existed.
 *
 * Every mutation returns a tagged result rather than throwing, because every
 * refusal in this file is a thing to tell the member — "you have no tickets
 * left" is a banner, not a 500.
 */
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { purchaseReference } from "../auth";
import { batch, getDb, type DatabaseEnv } from "../db";
import { newId, orderReference, ticketCode } from "../lib/ids";
import { createLogger, type LoggerEnv } from "../logger";
import {
  bookings,
  communityMembers,
  communities,
  events,
  orders,
  packages,
  memberPackages,
} from "../schema";
import { boundLimit, confirmedBookingCount, placesLeft } from "./common";

/** Commerce writes and logs, so it needs both halves of the environment. */
export type CommerceEnv = DatabaseEnv & LoggerEnv;

/** One of the three packages a community sells. */
export interface PackageOffer {
  id: string;
  name: string;
  tickets: number;
  priceCents: number;
  currency: string;
}

/** A package a member holds, with the community it is good for. */
export interface MemberPackageSummary {
  id: string;
  communitySlug: string;
  communityName: string;
  ticketsTotal: number;
  ticketsUsed: number;
  ticketsLeft: number;
}

/** A place a member holds, or held. */
export interface BookingSummary {
  code: string;
  eventSlug: string;
  eventTitle: string;
  startsAt: string;
  status: (typeof bookings.$inferSelect)["status"];
  communitySlug: string;
  communityName: string;
}

/** A community this member runs, for `/host` and `/api/me`. */
export interface HostedCommunity {
  slug: string;
  name: string;
}

export type PurchaseResult =
  | {
      status: "created";
      orderId: string;
      reference: string;
      memberPackageId: string;
      tickets: number;
      amountCents: number;
      currency: string;
      /** True when this purchase also made them an approved member. */
      joinedCommunity: boolean;
    }
  | { status: "already_processed"; orderId: string; reference: string }
  | { status: "package_not_found" };

export type BookResult =
  | { status: "booked"; code: string; ticketsLeft: number }
  | { status: "already_booked"; code: string }
  | { status: "event_not_found" }
  | { status: "not_published" }
  | { status: "not_a_member" }
  | { status: "membership_pending" }
  | { status: "full" }
  | { status: "no_tickets" };

export type CancelResult =
  | { status: "cancelled"; code: string }
  | { status: "already_cancelled"; code: string }
  | { status: "not_found" }
  | { status: "forbidden" };

/** What a community sells, in the order the design puts the cards. Active only. */
export async function listPackages(
  env: DatabaseEnv,
  communityId: string,
  options: { limit?: number } = {},
): Promise<PackageOffer[]> {
  const db = getDb(env);
  const rows = await db
    .select({
      id: packages.id,
      name: packages.name,
      tickets: packages.tickets,
      priceCents: packages.priceCents,
      currency: packages.currency,
    })
    .from(packages)
    .where(and(eq(packages.communityId, communityId), eq(packages.active, true)))
    .orderBy(asc(packages.sortOrder), asc(packages.createdAt))
    .limit(boundLimit(options.limit));
  return rows.map((row) => ({
    ...row,
    tickets: Number(row.tickets),
    priceCents: Number(row.priceCents),
  }));
}

/** One package, checked against the community in the URL so the two cannot disagree. */
export async function getPackageForCommunity(
  env: DatabaseEnv,
  communityId: string,
  packageId: string,
): Promise<PackageOffer | null> {
  const db = getDb(env);
  const [row] = await db
    .select({
      id: packages.id,
      name: packages.name,
      tickets: packages.tickets,
      priceCents: packages.priceCents,
      currency: packages.currency,
    })
    .from(packages)
    .where(
      and(eq(packages.id, packageId), eq(packages.communityId, communityId), eq(packages.active, true)),
    )
    .limit(1);
  if (!row) return null;
  return { ...row, tickets: Number(row.tickets), priceCents: Number(row.priceCents) };
}

/**
 * Buy a package: an order, the package it creates, and — on a public community — the
 * approved membership, all in one `batch()`.
 *
 * **The nonce is spent into `orders.reference`.** `purchaseReference(nonce)`
 * derives the reference deterministically, and `orders_reference_idx` is unique,
 * so the first POST writes the burn record and a replay collides with it. That
 * is why a double-tap is a no-op that reports `already_processed` instead of a
 * second order: the database decides, not a check in the handler that two fast
 * taps can race past. Omit the nonce and you get a random reference and no
 * replay protection — only the checkout form should do that.
 */
export async function purchase(
  env: CommerceEnv,
  input: { userId: string; communityId: string; packageId: string; nonce?: string },
): Promise<PurchaseResult> {
  const db = getDb(env);
  const log = createLogger(env);

  const [community] = await db
    .select({ id: communities.id, isPrivate: communities.isPrivate })
    .from(communities)
    .where(eq(communities.id, input.communityId))
    .limit(1);
  if (!community) return { status: "package_not_found" };

  const offer = await getPackageForCommunity(env, input.communityId, input.packageId);
  if (!offer) return { status: "package_not_found" };

  const reference = input.nonce ? await purchaseReference(input.nonce) : orderReference();

  // Cheap path for the common replay: the order is already there, so nothing
  // needs to be attempted. The unique index below is what makes it correct.
  const replay = await findOrderByReference(env, reference);
  if (replay) return { status: "already_processed", orderId: replay.id, reference };

  const orderId = newId();
  const memberPackageId = newId();
  const joinCommunity = !community.isPrivate;

  // Typed as what `batch()` takes, so pushing a different table's insert below
  // does not widen the array into something it will not accept.
  const statements: { toSQL(): { sql: string; params: unknown[] } }[] = [
    db.insert(orders).values({
      id: orderId,
      userId: input.userId,
      communityId: input.communityId,
      packageId: offer.id,
      reference,
      tickets: offer.tickets,
      amountCents: offer.priceCents,
      currency: offer.currency,
      status: "paid",
    }),
    db.insert(memberPackages).values({
      id: memberPackageId,
      userId: input.userId,
      communityId: input.communityId,
      orderId,
      ticketsTotal: offer.tickets,
      ticketsUsed: 0,
    }),
  ];
  if (joinCommunity) {
    // "…and the member has none" is enforced by the unique index rather than by
    // a read first: a member who is already in keeps the row they have.
    statements.push(
      db
        .insert(communityMembers)
        .values({
          id: newId(),
          communityId: input.communityId,
          userId: input.userId,
          role: "member",
          status: "approved",
        })
        .onConflictDoNothing(),
    );
  }

  try {
    await batch(env, statements);
  } catch (err) {
    // The other tap got there first. Recognise it by the burn record rather
    // than by parsing a driver-specific error code.
    const existing = await findOrderByReference(env, reference);
    if (existing) {
      log.warn("purchase replayed", { reference });
      return { status: "already_processed", orderId: existing.id, reference };
    }
    throw err;
  }

  log.info("package purchased", { orderId, communityId: input.communityId });
  return {
    status: "created",
    orderId,
    reference,
    memberPackageId,
    tickets: offer.tickets,
    amountCents: offer.priceCents,
    currency: offer.currency,
    joinedCommunity: joinCommunity,
  };
}

async function findOrderByReference(
  env: DatabaseEnv,
  reference: string,
): Promise<{ id: string } | null> {
  const db = getDb(env);
  const [row] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.reference, reference))
    .limit(1);
  return row ?? null;
}

/**
 * Take a place at an event, spending one ticket.
 *
 * Booking needs an approved membership AND a package with a ticket left, and the
 * event must not be full. A member who is already booked gets their ticket
 * code back and spends nothing — the repeat is the same place, not a second one.
 */
export async function book(
  env: CommerceEnv,
  input: { userId: string; eventSlug: string },
): Promise<BookResult> {
  const db = getDb(env);
  const log = createLogger(env);

  const [event] = await db
    .select({
      id: events.id,
      communityId: events.communityId,
      capacity: events.capacity,
      status: events.status,
      confirmed: confirmedBookingCount(events.id),
    })
    .from(events)
    .where(eq(events.slug, input.eventSlug))
    .limit(1);
  if (!event) return { status: "event_not_found" };
  if (event.status !== "published") return { status: "not_published" };

  const [existing] = await db
    .select({ id: bookings.id, code: bookings.code, status: bookings.status })
    .from(bookings)
    .where(and(eq(bookings.eventId, event.id), eq(bookings.userId, input.userId)))
    .limit(1);
  // Already holding this place: hand the code back, spend nothing.
  if (existing?.status === "confirmed") return { status: "already_booked", code: existing.code };

  const [membership] = await db
    .select({ status: communityMembers.status })
    .from(communityMembers)
    .where(
      and(eq(communityMembers.communityId, event.communityId), eq(communityMembers.userId, input.userId)),
    )
    .limit(1);
  if (!membership) return { status: "not_a_member" };
  if (membership.status !== "approved") {
    return membership.status === "pending"
      ? { status: "membership_pending" }
      : { status: "not_a_member" };
  }

  if (placesLeft(event.capacity, event.confirmed) <= 0) return { status: "full" };

  const [held] = await db
    .select({
      id: memberPackages.id,
      ticketsTotal: memberPackages.ticketsTotal,
      ticketsUsed: memberPackages.ticketsUsed,
    })
    .from(memberPackages)
    .where(
      and(
        eq(memberPackages.userId, input.userId),
        eq(memberPackages.communityId, event.communityId),
        lt(memberPackages.ticketsUsed, memberPackages.ticketsTotal),
      ),
    )
    // Spend the oldest package first, so a member never strands tickets.
    .orderBy(asc(memberPackages.createdAt))
    .limit(1);
  if (!held) return { status: "no_tickets" };

  // `credits_used < credits_total` in the WHERE as well as in the read above:
  // the read decided, the write refuses to overspend even if it lost a race.
  const spendTicket = db
    .update(memberPackages)
    .set({ ticketsUsed: sql`${memberPackages.ticketsUsed} + 1` })
    .where(and(eq(memberPackages.id, held.id), lt(memberPackages.ticketsUsed, memberPackages.ticketsTotal)));

  if (existing) {
    // Re-booking a place they cancelled: the row and its code come back rather
    // than a second row, which the unique index would refuse anyway.
    await batch(env, [
      db
        .update(bookings)
        .set({ status: "confirmed", memberPackageId: held.id })
        .where(eq(bookings.id, existing.id)),
      spendTicket,
    ]);
    log.info("booking reinstated", { eventId: event.id });
    return {
      status: "booked",
      code: existing.code,
      ticketsLeft: held.ticketsTotal - held.ticketsUsed - 1,
    };
  }

  const code = await freeTicketCode(env);
  await batch(env, [
    db.insert(bookings).values({
      id: newId(),
      eventId: event.id,
      userId: input.userId,
      memberPackageId: held.id,
      code,
      status: "confirmed",
    }),
    spendTicket,
  ]);

  log.info("booking confirmed", { eventId: event.id });
  return { status: "booked", code, ticketsLeft: held.ticketsTotal - held.ticketsUsed - 1 };
}

/**
 * A ticket code nothing else is using. `ticketCode()` has 32^4 codes, so a
 * collision is rare — but "rare" during a demo is still a 500, and one indexed
 * lookup is cheaper than that.
 */
async function freeTicketCode(env: DatabaseEnv): Promise<string> {
  const db = getDb(env);
  const candidates = [ticketCode(), ticketCode(), ticketCode(), ticketCode(), ticketCode()];
  const taken = await db
    .select({ code: bookings.code })
    .from(bookings)
    .where(inArray(bookings.code, candidates))
    .limit(candidates.length);
  const used = new Set(taken.map((row) => row.code));
  const free = candidates.find((candidate) => !used.has(candidate));
  if (!free) throw new Error("freeTicketCode: five ticket codes collided");
  return free;
}

/* ----------------------------------------------------- one ticket, one step */

export type TicketResult =
  | {
      status: "ticketed";
      code: string;
      reference: string;
      amountCents: number;
      currency: string;
      /** True when buying the ticket also made them an approved member. */
      joinedCommunity: boolean;
    }
  | { status: "already_booked"; code: string }
  /** The same form submitted twice. `code` is the place the first submit made. */
  | { status: "already_processed"; reference: string; code: string | null }
  /** The community sells no 1-ticket package, so there is no single ticket to sell. */
  | { status: "no_single_package" }
  | { status: "event_not_found" }
  | { status: "not_published" }
  | { status: "not_a_member" }
  | { status: "membership_pending" }
  | { status: "full" }
  /** The last place went mid-purchase; the order was reversed and nothing stands. */
  | { status: "reversed" };

/**
 * Buy one place at one event, without the member having to think about
 * packages: it buys the community's 1-ticket package and spends that ticket on this
 * event, in one action.
 *
 * **Nothing here reimplements `purchase()` or `book()`** — each keeps its own
 * `batch()`, so the order-plus-package write and the booking-plus-ticket write are
 * each still all-or-nothing. What this adds is the guarantee *across* them:
 *
 *   1. Every refusal `book()` can produce is checked BEFORE any money moves,
 *      so the normal way to fail is to fail having bought nothing.
 *   2. The one refusal that survives that check is losing a race for the last
 *      place between the two writes. That is compensated: the order is marked
 *      `refunded` and the package it created is deleted, in one `batch()`. So a
 *      paid order with no booking is never left behind.
 *
 * The nonce is the same one-time nonce the checkout form uses — `purchase()`
 * spends it into `orders.reference`, which is uniquely indexed, so a double tap
 * collides in the database rather than buying twice.
 */
export async function purchaseTicket(
  env: CommerceEnv,
  input: { userId: string; eventSlug: string; nonce?: string },
): Promise<TicketResult> {
  const db = getDb(env);
  const log = createLogger(env);

  const [event] = await db
    .select({
      id: events.id,
      communityId: events.communityId,
      capacity: events.capacity,
      status: events.status,
      isPrivate: communities.isPrivate,
      confirmed: confirmedBookingCount(events.id),
    })
    .from(events)
    .innerJoin(communities, eq(communities.id, events.communityId))
    .where(eq(events.slug, input.eventSlug))
    .limit(1);
  if (!event) return { status: "event_not_found" };
  if (event.status !== "published") return { status: "not_published" };

  // Already holding the place: there is nothing to buy, and a replayed form
  // lands here rather than on a second order.
  const [existing] = await db
    .select({ code: bookings.code, status: bookings.status })
    .from(bookings)
    .where(and(eq(bookings.eventId, event.id), eq(bookings.userId, input.userId)))
    .limit(1);
  if (existing?.status === "confirmed") return { status: "already_booked", code: existing.code };

  // Buying joins an open community, so only an existing non-approved row can
  // refuse: `purchase()` inserts the membership with `onConflictDoNothing`, and
  // a pending row would survive it and then stop `book()`.
  const [membership] = await db
    .select({ status: communityMembers.status })
    .from(communityMembers)
    .where(and(eq(communityMembers.communityId, event.communityId), eq(communityMembers.userId, input.userId)))
    .limit(1);
  if (membership) {
    if (membership.status === "pending") return { status: "membership_pending" };
    if (membership.status === "declined") return { status: "not_a_member" };
  } else if (event.isPrivate) {
    return { status: "not_a_member" };
  }

  if (placesLeft(event.capacity, event.confirmed) <= 0) return { status: "full" };

  const single = (await listPackages(env, event.communityId)).find((offer) => offer.tickets === 1);
  if (!single) return { status: "no_single_package" };

  const bought = await purchase(env, {
    userId: input.userId,
    communityId: event.communityId,
    packageId: single.id,
    nonce: input.nonce,
  });
  if (bought.status === "package_not_found") return { status: "no_single_package" };
  if (bought.status === "already_processed") {
    const [made] = await db
      .select({ code: bookings.code })
      .from(bookings)
      .where(
        and(
          eq(bookings.eventId, event.id),
          eq(bookings.userId, input.userId),
          eq(bookings.status, "confirmed"),
        ),
      )
      .limit(1);
    return { status: "already_processed", reference: bought.reference, code: made?.code ?? null };
  }

  const booked = await book(env, { userId: input.userId, eventSlug: input.eventSlug });
  if (booked.status === "booked" || booked.status === "already_booked") {
    log.info("ticket bought", { orderId: bought.orderId, eventId: event.id });
    return {
      status: "ticketed",
      code: booked.code,
      reference: bought.reference,
      amountCents: bought.amountCents,
      currency: bought.currency,
      joinedCommunity: bought.joinedCommunity,
    };
  }

  // Compensation, not a retry: the ticket exists but the place does not, so the
  // order stops standing. One `batch()` — a refunded order still holding a live
  // package would be a ticket nobody paid for.
  await batch(env, [
    db.update(orders).set({ status: "refunded" }).where(eq(orders.id, bought.orderId)),
    db.delete(memberPackages).where(eq(memberPackages.id, bought.memberPackageId)),
  ]);
  log.warn("ticket reversed", { orderId: bought.orderId, reason: booked.status });
  return { status: "reversed" };
}

/**
 * Give the place back and return the ticket — one `batch()`, and `greatest(…,0)`
 * so a double cancel can never drive a package below zero tickets used.
 */
export async function cancel(
  env: CommerceEnv,
  input: { userId: string; code: string },
): Promise<CancelResult> {
  const db = getDb(env);
  const log = createLogger(env);

  const [booking] = await db
    .select({
      id: bookings.id,
      userId: bookings.userId,
      memberPackageId: bookings.memberPackageId,
      code: bookings.code,
      status: bookings.status,
    })
    .from(bookings)
    .where(eq(bookings.code, input.code))
    .limit(1);
  if (!booking) return { status: "not_found" };
  if (booking.userId !== input.userId) return { status: "forbidden" };
  if (booking.status === "cancelled") return { status: "already_cancelled", code: booking.code };

  await batch(env, [
    db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, booking.id)),
    db
      .update(memberPackages)
      .set({ ticketsUsed: sql`greatest(${memberPackages.ticketsUsed} - 1, 0)` })
      .where(eq(memberPackages.id, booking.memberPackageId)),
  ]);

  log.info("booking cancelled", { bookingId: booking.id });
  return { status: "cancelled", code: booking.code };
}

/** The packages a member holds, newest first. */
export async function listPackagesForUser(
  env: DatabaseEnv,
  userId: string,
  options: { limit?: number } = {},
): Promise<MemberPackageSummary[]> {
  const db = getDb(env);
  const rows = await db
    .select({
      id: memberPackages.id,
      communitySlug: communities.slug,
      communityName: communities.name,
      ticketsTotal: memberPackages.ticketsTotal,
      ticketsUsed: memberPackages.ticketsUsed,
    })
    .from(memberPackages)
    .innerJoin(communities, eq(communities.id, memberPackages.communityId))
    .where(eq(memberPackages.userId, userId))
    .orderBy(desc(memberPackages.createdAt))
    .limit(boundLimit(options.limit));

  return rows.map((row) => {
    const ticketsTotal = Number(row.ticketsTotal);
    const ticketsUsed = Number(row.ticketsUsed);
    return {
      id: row.id,
      communitySlug: row.communitySlug,
      communityName: row.communityName,
      ticketsTotal,
      ticketsUsed,
      ticketsLeft: Math.max(0, ticketsTotal - ticketsUsed),
    };
  });
}

/** A member's tickets, soonest event first. Cancelled ones are kept — it is their history. */
export async function listBookingsForUser(
  env: DatabaseEnv,
  userId: string,
  options: { limit?: number } = {},
): Promise<BookingSummary[]> {
  const db = getDb(env);
  const rows = await db
    .select({
      code: bookings.code,
      status: bookings.status,
      eventSlug: events.slug,
      eventTitle: events.title,
      startsAt: events.startsAt,
      communitySlug: communities.slug,
      communityName: communities.name,
    })
    .from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId))
    .innerJoin(communities, eq(communities.id, events.communityId))
    .where(eq(bookings.userId, userId))
    .orderBy(asc(events.startsAt))
    .limit(boundLimit(options.limit));

  return rows.map((row) => ({ ...row, startsAt: row.startsAt.toISOString() }));
}

/**
 * The communities this member runs, in creation order — the contract is explicit
 * that a newly created community appears last in `/api/me`.
 */
export async function listHostedCommunities(
  env: DatabaseEnv,
  userId: string,
  options: { limit?: number } = {},
): Promise<HostedCommunity[]> {
  const db = getDb(env);
  return db
    .select({ slug: communities.slug, name: communities.name })
    .from(communities)
    .where(eq(communities.hostUserId, userId))
    .orderBy(asc(communities.createdAt))
    .limit(boundLimit(options.limit));
}
