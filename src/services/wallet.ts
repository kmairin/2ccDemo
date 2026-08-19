/**
 * The demo balance: what a member holds, topping it up, and spending it.
 *
 * Nothing here charges anything. A top-up is one click and no card, and a spend
 * is a debit against a number this app made up — the checkout says so in as many
 * words. What is real is the arithmetic: integer cents, one currency, and every
 * movement written to `wallet_txns` so the balance can always be explained.
 *
 * Two rules hold everywhere in this file, and both are enforced by the database
 * rather than by a check in a handler that two fast taps can race past:
 *
 *   1. **A balance never goes negative.** The debit is a relative
 *      `balance_cents - amount` with no guard of its own; `wallets_balance_nonneg`
 *      (see `src/schema.ts`) aborts the whole `batch()` if it would go under. So
 *      an overspend cannot leave a paid order behind — the order is in that same
 *      batch.
 *   2. **A movement lands once.** `wallet_txns.reference` is uniquely indexed and
 *      every movement derives its reference deterministically, so a replay
 *      collides instead of moving money twice.
 *
 * `spendStatements` and `refundStatements` return statements rather than running
 * them, because a spend belongs in the *caller's* `batch()` — the one that also
 * writes the order. A debited balance and an unpaid order must not be able to
 * come apart, and two awaits is exactly how they would.
 */
import { desc, eq, sql } from "drizzle-orm";
import { purchaseReference } from "../auth";
import { batch, getDb, type DatabaseEnv } from "../db";
import { newId } from "../lib/ids";
import { createLogger, type LoggerEnv } from "../logger";
import { wallets, walletTxns, type WalletTxnKind } from "../schema";
import { boundLimit } from "./common";

/** The wallet writes and logs, so it needs both halves of the environment. */
export type WalletEnv = DatabaseEnv & LoggerEnv;

/** What a member holds. `balanceCents` is integer cents in `currency`, never a total across currencies. */
export interface WalletSummary {
  balanceCents: number;
  currency: string;
  /** False when the member has never topped up — the row does not exist yet. */
  exists: boolean;
}

/** One line of the history on `/account/wallet`. */
export interface WalletMovement {
  id: string;
  kind: WalletTxnKind;
  amountCents: number;
  currency: string;
  reference: string;
  note: string;
  createdAt: Date;
}

/**
 * The currency a wallet takes when it is created, and the one the presets are
 * denominated in until the member is sent to top up from a checkout priced in
 * something else.
 */
export const DEFAULT_WALLET_CURRENCY = "USD";

/**
 * The currencies this demo prices in — the seeded communities sell in all four,
 * and a top-up link from a checkout carries one of them. Anything else is
 * refused at the route boundary rather than written to a row.
 */
export const WALLET_CURRENCIES = ["USD", "EUR", "AED", "THB"] as const;

/**
 * Top-up presets, in integer cents.
 *
 * 50 / 100 / 250 / 500 in the member's currency is the shape the design asks
 * for, and it is right for USD and EUR. It is not right for AED or THB: a
 * single ticket at The Sunrise Court is AED 240 and one at Nightform is
 * THB 3,800, so a 500-of-anything top-up would buy nothing there. The ladder is
 * therefore scaled per currency to the same *purchasing* steps, which is what
 * the presets are actually for.
 */
const TOPUP_PRESETS: Record<string, readonly number[]> = {
  USD: [5_000, 10_000, 25_000, 50_000],
  EUR: [5_000, 10_000, 25_000, 50_000],
  AED: [20_000, 50_000, 100_000, 200_000],
  THB: [200_000, 500_000, 1_000_000, 2_000_000],
};

/** A hundred million cents. A demo balance past this is a typo or a fuzzer, not a member. */
export const MAX_TOPUP_CENTS = 100_000_000;

/** The four preset amounts for a currency, smallest first. */
export function topUpPresets(currency: string): number[] {
  return [...(TOPUP_PRESETS[currency] ?? TOPUP_PRESETS[DEFAULT_WALLET_CURRENCY]!)];
}

/** True when `currency` is one this demo prices in. Checked before anything is written. */
export function isWalletCurrency(currency: string): boolean {
  return (WALLET_CURRENCIES as readonly string[]).includes(currency);
}

/**
 * What this member holds. A member who has never topped up has no row, which
 * reads as zero in their default currency rather than as an error — the page
 * shows a balance either way.
 */
export async function getWallet(
  env: DatabaseEnv,
  userId: string,
  fallbackCurrency = DEFAULT_WALLET_CURRENCY,
): Promise<WalletSummary> {
  const db = getDb(env);
  const [row] = await db
    .select({ balanceCents: wallets.balanceCents, currency: wallets.currency })
    .from(wallets)
    .where(eq(wallets.userId, userId))
    .limit(1);
  if (!row) return { balanceCents: 0, currency: fallbackCurrency, exists: false };
  return { balanceCents: Number(row.balanceCents), currency: row.currency, exists: true };
}

/** The movements behind the balance, newest first. */
export async function listMovements(
  env: DatabaseEnv,
  userId: string,
  options: { limit?: number } = {},
): Promise<WalletMovement[]> {
  const db = getDb(env);
  const rows = await db
    .select({
      id: walletTxns.id,
      kind: walletTxns.kind,
      amountCents: walletTxns.amountCents,
      currency: walletTxns.currency,
      reference: walletTxns.reference,
      note: walletTxns.note,
      createdAt: walletTxns.createdAt,
    })
    .from(walletTxns)
    .where(eq(walletTxns.userId, userId))
    .orderBy(desc(walletTxns.createdAt))
    .limit(boundLimit(options.limit));
  return rows.map((row) => ({ ...row, amountCents: Number(row.amountCents) }));
}

/* --------------------------------------------------------------- topping up */

export type TopUpResult =
  | { status: "topped_up"; balanceCents: number; amountCents: number; currency: string; reference: string }
  /** The same button submitted twice. The first one stands and nothing was added. */
  | { status: "already_processed"; reference: string; balanceCents: number; currency: string }
  /** There is money in the wallet already, in a different currency. */
  | { status: "currency_mismatch"; balanceCents: number; currency: string }
  | { status: "invalid_amount" };

/**
 * Add money to the balance and write the `topup` that explains it — one click,
 * no card.
 *
 * The nonce is the one-time nonce the purchase flow already uses. It is spent
 * into `wallet_txns.reference` by `purchaseReference()`, exactly as `purchase()`
 * spends it into `orders.reference`, so a double tap collides on the unique
 * index and the balance moves once. Omit it and the top-up gets a random
 * reference and no replay protection — only a hand-written request should do
 * that.
 *
 * A wallet holds one currency. It re-denominates only while the balance is
 * exactly zero, which is what lets a member who has spent down in EUR top up in
 * THB for the Bangkok community; with money still in it, a different currency is
 * refused rather than silently converted at a rate this app would have to invent.
 */
export async function topUp(
  env: WalletEnv,
  input: { userId: string; amountCents: number; currency: string; nonce?: string; note?: string },
): Promise<TopUpResult> {
  const db = getDb(env);
  const log = createLogger(env);

  if (
    !Number.isSafeInteger(input.amountCents) ||
    input.amountCents <= 0 ||
    input.amountCents > MAX_TOPUP_CENTS ||
    !isWalletCurrency(input.currency)
  ) {
    return { status: "invalid_amount" };
  }

  const reference = input.nonce
    ? await purchaseReference(input.nonce)
    : await purchaseReference(newId());

  const before = await getWallet(env, input.userId, input.currency);

  // The cheap path for the common replay: the movement is already filed, so
  // nothing needs attempting. The unique index below is what makes it correct.
  if (await movementExists(env, reference)) {
    return {
      status: "already_processed",
      reference,
      balanceCents: before.balanceCents,
      currency: before.currency,
    };
  }

  if (before.exists && before.balanceCents > 0 && before.currency !== input.currency) {
    return { status: "currency_mismatch", balanceCents: before.balanceCents, currency: before.currency };
  }

  const statements: BatchStatement[] = [
    // Make sure the row is there without disturbing one that already is.
    db
      .insert(wallets)
      .values({
        id: newId(),
        userId: input.userId,
        balanceCents: 0,
        currency: input.currency,
      })
      .onConflictDoNothing({ target: wallets.userId }),
    // Relative, never absolute: two top-ups that interleave both land. The
    // CASE re-denominates an empty wallet and leaves a funded one alone, so the
    // decision above cannot be undone by a write that raced it.
    db
      .update(wallets)
      .set({
        balanceCents: sql`case when ${wallets.currency} = ${input.currency} then ${wallets.balanceCents} + ${input.amountCents} else ${input.amountCents} end`,
        currency: input.currency,
        updatedAt: new Date(),
      })
      .where(
        sql`${wallets.userId} = ${input.userId} and (${wallets.currency} = ${input.currency} or ${wallets.balanceCents} = 0)`,
      ),
    db.insert(walletTxns).values({
      id: newId(),
      userId: input.userId,
      kind: "topup",
      amountCents: input.amountCents,
      currency: input.currency,
      reference,
      // The Detail column beside a row already labelled "Top-up" has to say
      // something else, or it says the same word twice.
      note: input.note ?? "One click. No card charged.",
    }),
  ];

  try {
    await batch(env, statements);
  } catch (err) {
    // The other tap got there first. Recognise it by the movement rather than
    // by parsing a driver-specific error code.
    if (await movementExists(env, reference)) {
      const now = await getWallet(env, input.userId, input.currency);
      log.warn("top-up replayed", { reference });
      return {
        status: "already_processed",
        reference,
        balanceCents: now.balanceCents,
        currency: now.currency,
      };
    }
    throw err;
  }

  const after = await getWallet(env, input.userId, input.currency);
  log.info("wallet topped up", { userId: input.userId, amountCents: input.amountCents });
  return {
    status: "topped_up",
    balanceCents: after.balanceCents,
    amountCents: input.amountCents,
    currency: input.currency,
    reference,
  };
}

async function movementExists(env: DatabaseEnv, reference: string): Promise<boolean> {
  const db = getDb(env);
  const [row] = await db
    .select({ id: walletTxns.id })
    .from(walletTxns)
    .where(eq(walletTxns.reference, reference))
    .limit(1);
  return row !== undefined;
}

/* ------------------------------------------------------ spending and reversal */

/**
 * What `batch()` in `src/db.ts` takes. Named so the arrays below cannot widen
 * into something it will not accept.
 */
type BatchStatement = { toSQL(): { sql: string; params: unknown[] } };

/**
 * The two statements that pay for something out of the balance.
 *
 * **Push these into the caller's `batch()`, never run them on their own.** A
 * debited balance and the order it paid for must land together or not at all,
 * and two awaits is exactly how they come apart.
 *
 * The debit carries no `balance_cents >= amount` guard on purpose: with one, an
 * overspend would update no rows and let the order through unpaid. Without one,
 * `wallets_balance_nonneg` aborts the transaction and neither lands.
 */
export function spendStatements(
  env: DatabaseEnv,
  input: { userId: string; amountCents: number; currency: string; reference: string; note: string },
): BatchStatement[] {
  const db = getDb(env);
  return [
    db
      .update(wallets)
      .set({
        balanceCents: sql`${wallets.balanceCents} - ${input.amountCents}`,
        updatedAt: new Date(),
      })
      .where(eq(wallets.userId, input.userId)),
    db.insert(walletTxns).values({
      id: newId(),
      userId: input.userId,
      kind: "spend",
      amountCents: input.amountCents,
      currency: input.currency,
      reference: input.reference,
      note: input.note,
    }),
  ];
}

/**
 * The reversal of a spend — the money back, and the `refund` that explains it.
 * Same rule: these belong in the caller's `batch()`, beside whatever else is
 * being undone.
 *
 * The reference is the spend's with `-R` on the end, so the unique index accepts
 * it and a member reading the history can see which movement it reverses.
 */
export function refundStatements(
  env: DatabaseEnv,
  input: { userId: string; amountCents: number; currency: string; reference: string; note: string },
): BatchStatement[] {
  const db = getDb(env);
  return [
    db
      .update(wallets)
      .set({
        balanceCents: sql`${wallets.balanceCents} + ${input.amountCents}`,
        updatedAt: new Date(),
      })
      .where(eq(wallets.userId, input.userId)),
    db.insert(walletTxns).values({
      id: newId(),
      userId: input.userId,
      kind: "refund",
      amountCents: input.amountCents,
      currency: input.currency,
      reference: `${input.reference}-R`,
      note: input.note,
    }),
  ];
}
