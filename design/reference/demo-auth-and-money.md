# Sign-in and money, for the demo

The owner's words:

> for log in for demo let's just use a fake Sign in with google but just pass
> through and just store information in the local storage.
>
> then you can top up (click through just top up the balance then you can buy)
> or buy with credit card and just pass through.

## Sign in

One click, no typing, no password.

- `/join` leads with **Continue with Google**, then a demo account chooser
  listing a few seeded people (Alexandra Voss, Rafael Ortiz, and "Use a new
  account"). Picking one signs you straight in.
- The old email + name form stays underneath as a fallback, so nothing that
  works today stops working.
- The chosen account is mirrored into `localStorage` under `2cc.account`
  (name, email, avatar initials), which is what the owner asked for.

**A hard line: this never touches a real Google account and never asks for a
password.** It is a demo chooser with obviously-fake accounts, labelled as a
demo. Rendering anything that collects real Google credentials would be building
a credential-phishing screen, which is not on the table whatever the framing.

**Why the server session stays.** Bookings, tickets, packages, the wallet and
the host console are all keyed to a user row. `localStorage` cannot be read by
the server, so a purely client-side identity would mean nothing could actually
be bought. So: one click creates or reuses the real user row and its session
cookie, **and** mirrors the account into `localStorage`. Both, not one.

## Money

Two ways to pay, both pass-through, neither charging anything.

### Wallet

New tables (a `CREATE TABLE` is fine here; only `ALTER` is refused):

- `wallets` — `userId`, `balanceCents`, `currency`, `updatedAt`
- `wallet_txns` — `id`, `userId`, `kind` (`topup` | `spend` | `refund`),
  `amountCents`, `currency`, `reference`, `note`, `createdAt`

Surfaces:

- `/account/wallet` — the balance, a top-up panel with preset amounts, and the
  transaction history.
- `POST /account/wallet/topup` — adds the amount and records a `topup`. One
  click, no card. Guarded by the same one-time nonce the purchase flow uses, so
  a double-tap does not double the balance.
- Balance shown in the header when signed in, so it is visible during a demo.

### Checkout

The checkout offers **two** methods:

1. **Pay from balance** — enabled when the balance covers it, and it says so
   when it does not, with a top-up link right there. Spends via `batch()`
   alongside the order, so a paid order and a debited balance cannot come apart.
2. **Pay by card** — the existing mocked card block, pass-through, still saying
   plainly that no card is charged.

Buying a single ticket gets the same two options.

Every amount stays integer cents, in the community's own currency, formatted by
`src/lib/format.ts`.

## Still outstanding after this

- **Thai.** The brief now reads "Languages: Eng **& TH** portal". Nothing is
  structured for a second language yet — strings are inline in the components.
  That is a real piece of work (extract strings, a locale switch, translate) and
  it is listed, not started.
- Content feed and articles.
- Banner ads and the partner console (AMS).
- Subscriptions retiered to 3 / 6 / 12.
