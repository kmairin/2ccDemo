/**
 * Money and places: what a circle sells, buying it, spending a credit on a
 * gathering, and handing the credit back.
 *
 * The three mutations here each land as ONE `batch()` from `src/db.ts` — all of
 * it or none of it. `db.transaction()` throws on this platform (see that file),
 * and two separate awaits would leave a pass charged for a booking that never
 * existed.
 *
 * Every mutation returns a tagged result rather than throwing, because every
 * refusal in this file is a thing to tell the member — "you have no credits
 * left" is a banner, not a 500.
 */
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { purchaseReference } from "../auth";
import { batch, getDb, type DatabaseEnv } from "../db";
import { newId, orderReference, ticketCode } from "../lib/ids";
import { createLogger, type LoggerEnv } from "../logger";
import {
  bookings,
  circleMembers,
  circles,
  events,
  orders,
  packages,
  passes,
} from "../schema";
import { boundLimit, confirmedBookingCount, placesLeft } from "./common";

/** Commerce writes and logs, so it needs both halves of the environment. */
export type CommerceEnv = DatabaseEnv & LoggerEnv;

/** One of the three passes a circle sells. */
export interface PackageOffer {
  id: string;
  name: string;
  credits: number;
  priceCents: number;
  currency: string;
}

/** A pass a member holds, with the circle it is good for. */
export interface PassSummary {
  id: string;
  circleSlug: string;
  circleName: string;
  creditsTotal: number;
  creditsUsed: number;
  creditsLeft: number;
}

/** A place a member holds, or held. */
export interface BookingSummary {
  code: string;
  eventSlug: string;
  eventTitle: string;
  startsAt: string;
  status: (typeof bookings.$inferSelect)["status"];
  circleSlug: string;
  circleName: string;
}

/** A circle this member runs, for `/host` and `/api/me`. */
export interface HostedCircle {
  slug: string;
  name: string;
}

export type PurchaseResult =
  | {
      status: "created";
      orderId: string;
      reference: string;
      passId: string;
      credits: number;
      amountCents: number;
      currency: string;
      /** True when this purchase also made them an approved member. */
      joinedCircle: boolean;
    }
  | { status: "already_processed"; orderId: string; reference: string }
  | { status: "package_not_found" };

export type BookResult =
  | { status: "booked"; code: string; creditsLeft: number }
  | { status: "already_booked"; code: string }
  | { status: "event_not_found" }
  | { status: "not_published" }
  | { status: "not_a_member" }
  | { status: "membership_pending" }
  | { status: "full" }
  | { status: "no_credits" };

export type CancelResult =
  | { status: "cancelled"; code: string }
  | { status: "already_cancelled"; code: string }
  | { status: "not_found" }
  | { status: "forbidden" };

/** What a circle sells, in the order the design puts the cards. Active only. */
export async function listPackages(
  env: DatabaseEnv,
  circleId: string,
  options: { limit?: number } = {},
): Promise<PackageOffer[]> {
  const db = getDb(env);
  const rows = await db
    .select({
      id: packages.id,
      name: packages.name,
      credits: packages.credits,
      priceCents: packages.priceCents,
      currency: packages.currency,
    })
    .from(packages)
    .where(and(eq(packages.circleId, circleId), eq(packages.active, true)))
    .orderBy(asc(packages.sortOrder), asc(packages.createdAt))
    .limit(boundLimit(options.limit));
  return rows.map((row) => ({
    ...row,
    credits: Number(row.credits),
    priceCents: Number(row.priceCents),
  }));
}

/** One package, checked against the circle in the URL so the two cannot disagree. */
export async function getPackageForCircle(
  env: DatabaseEnv,
  circleId: string,
  packageId: string,
): Promise<PackageOffer | null> {
  const db = getDb(env);
  const [row] = await db
    .select({
      id: packages.id,
      name: packages.name,
      credits: packages.credits,
      priceCents: packages.priceCents,
      currency: packages.currency,
    })
    .from(packages)
    .where(
      and(eq(packages.id, packageId), eq(packages.circleId, circleId), eq(packages.active, true)),
    )
    .limit(1);
  if (!row) return null;
  return { ...row, credits: Number(row.credits), priceCents: Number(row.priceCents) };
}

/**
 * Buy a pass: an order, the pass it creates, and — on a public circle — the
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
  input: { userId: string; circleId: string; packageId: string; nonce?: string },
): Promise<PurchaseResult> {
  const db = getDb(env);
  const log = createLogger(env);

  const [circle] = await db
    .select({ id: circles.id, isPrivate: circles.isPrivate })
    .from(circles)
    .where(eq(circles.id, input.circleId))
    .limit(1);
  if (!circle) return { status: "package_not_found" };

  const offer = await getPackageForCircle(env, input.circleId, input.packageId);
  if (!offer) return { status: "package_not_found" };

  const reference = input.nonce ? await purchaseReference(input.nonce) : orderReference();

  // Cheap path for the common replay: the order is already there, so nothing
  // needs to be attempted. The unique index below is what makes it correct.
  const replay = await findOrderByReference(env, reference);
  if (replay) return { status: "already_processed", orderId: replay.id, reference };

  const orderId = newId();
  const passId = newId();
  const joinCircle = !circle.isPrivate;

  // Typed as what `batch()` takes, so pushing a different table's insert below
  // does not widen the array into something it will not accept.
  const statements: { toSQL(): { sql: string; params: unknown[] } }[] = [
    db.insert(orders).values({
      id: orderId,
      userId: input.userId,
      circleId: input.circleId,
      packageId: offer.id,
      reference,
      credits: offer.credits,
      amountCents: offer.priceCents,
      currency: offer.currency,
      status: "paid",
    }),
    db.insert(passes).values({
      id: passId,
      userId: input.userId,
      circleId: input.circleId,
      orderId,
      creditsTotal: offer.credits,
      creditsUsed: 0,
    }),
  ];
  if (joinCircle) {
    // "…and the member has none" is enforced by the unique index rather than by
    // a read first: a member who is already in keeps the row they have.
    statements.push(
      db
        .insert(circleMembers)
        .values({
          id: newId(),
          circleId: input.circleId,
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

  log.info("pass purchased", { orderId, circleId: input.circleId });
  return {
    status: "created",
    orderId,
    reference,
    passId,
    credits: offer.credits,
    amountCents: offer.priceCents,
    currency: offer.currency,
    joinedCircle: joinCircle,
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
 * Take a place at a gathering, spending one credit.
 *
 * Booking needs an approved membership AND a pass with a credit left, and the
 * gathering must not be full. A member who is already booked gets their ticket
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
      circleId: events.circleId,
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
    .select({ status: circleMembers.status })
    .from(circleMembers)
    .where(
      and(eq(circleMembers.circleId, event.circleId), eq(circleMembers.userId, input.userId)),
    )
    .limit(1);
  if (!membership) return { status: "not_a_member" };
  if (membership.status !== "approved") {
    return membership.status === "pending"
      ? { status: "membership_pending" }
      : { status: "not_a_member" };
  }

  if (placesLeft(event.capacity, event.confirmed) <= 0) return { status: "full" };

  const [pass] = await db
    .select({
      id: passes.id,
      creditsTotal: passes.creditsTotal,
      creditsUsed: passes.creditsUsed,
    })
    .from(passes)
    .where(
      and(
        eq(passes.userId, input.userId),
        eq(passes.circleId, event.circleId),
        lt(passes.creditsUsed, passes.creditsTotal),
      ),
    )
    // Spend the oldest pass first, so a member never strands credits.
    .orderBy(asc(passes.createdAt))
    .limit(1);
  if (!pass) return { status: "no_credits" };

  // `credits_used < credits_total` in the WHERE as well as in the read above:
  // the read decided, the write refuses to overspend even if it lost a race.
  const spendCredit = db
    .update(passes)
    .set({ creditsUsed: sql`${passes.creditsUsed} + 1` })
    .where(and(eq(passes.id, pass.id), lt(passes.creditsUsed, passes.creditsTotal)));

  if (existing) {
    // Re-booking a place they cancelled: the row and its code come back rather
    // than a second row, which the unique index would refuse anyway.
    await batch(env, [
      db
        .update(bookings)
        .set({ status: "confirmed", passId: pass.id })
        .where(eq(bookings.id, existing.id)),
      spendCredit,
    ]);
    log.info("booking reinstated", { eventId: event.id });
    return {
      status: "booked",
      code: existing.code,
      creditsLeft: pass.creditsTotal - pass.creditsUsed - 1,
    };
  }

  const code = await freeTicketCode(env);
  await batch(env, [
    db.insert(bookings).values({
      id: newId(),
      eventId: event.id,
      userId: input.userId,
      passId: pass.id,
      code,
      status: "confirmed",
    }),
    spendCredit,
  ]);

  log.info("booking confirmed", { eventId: event.id });
  return { status: "booked", code, creditsLeft: pass.creditsTotal - pass.creditsUsed - 1 };
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

/**
 * Give the place back and return the credit — one `batch()`, and `greatest(…,0)`
 * so a double cancel can never drive a pass below zero credits used.
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
      passId: bookings.passId,
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
      .update(passes)
      .set({ creditsUsed: sql`greatest(${passes.creditsUsed} - 1, 0)` })
      .where(eq(passes.id, booking.passId)),
  ]);

  log.info("booking cancelled", { bookingId: booking.id });
  return { status: "cancelled", code: booking.code };
}

/** The passes a member holds, newest first. */
export async function listPassesForUser(
  env: DatabaseEnv,
  userId: string,
  options: { limit?: number } = {},
): Promise<PassSummary[]> {
  const db = getDb(env);
  const rows = await db
    .select({
      id: passes.id,
      circleSlug: circles.slug,
      circleName: circles.name,
      creditsTotal: passes.creditsTotal,
      creditsUsed: passes.creditsUsed,
    })
    .from(passes)
    .innerJoin(circles, eq(circles.id, passes.circleId))
    .where(eq(passes.userId, userId))
    .orderBy(desc(passes.createdAt))
    .limit(boundLimit(options.limit));

  return rows.map((row) => {
    const creditsTotal = Number(row.creditsTotal);
    const creditsUsed = Number(row.creditsUsed);
    return {
      id: row.id,
      circleSlug: row.circleSlug,
      circleName: row.circleName,
      creditsTotal,
      creditsUsed,
      creditsLeft: Math.max(0, creditsTotal - creditsUsed),
    };
  });
}

/** A member's tickets, soonest gathering first. Cancelled ones are kept — it is their history. */
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
      circleSlug: circles.slug,
      circleName: circles.name,
    })
    .from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId))
    .innerJoin(circles, eq(circles.id, events.circleId))
    .where(eq(bookings.userId, userId))
    .orderBy(asc(events.startsAt))
    .limit(boundLimit(options.limit));

  return rows.map((row) => ({ ...row, startsAt: row.startsAt.toISOString() }));
}

/**
 * The circles this member runs, in creation order — the contract is explicit
 * that a newly created circle appears last in `/api/me`.
 */
export async function listHostedCircles(
  env: DatabaseEnv,
  userId: string,
  options: { limit?: number } = {},
): Promise<HostedCircle[]> {
  const db = getDb(env);
  return db
    .select({ slug: circles.slug, name: circles.name })
    .from(circles)
    .where(eq(circles.hostUserId, userId))
    .orderBy(asc(circles.createdAt))
    .limit(boundLimit(options.limit));
}
