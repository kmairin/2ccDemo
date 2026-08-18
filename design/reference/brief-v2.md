# 2CC — the real brief (supersedes spec.md)

**2CC = Connections and Community.**
**One World. Endless Connections.**

A global community and media platform that connects people with communities,
activities and meaningful experiences around the world. It carries up-to-date
content and activity schedules from communities in every country, so a user can
see what is happening, where, and how to take part. It also builds a community
database, and runs as an independent media platform where brands can reach
relevant audiences.

Reference: https://iwelty.com

## This overturns the previous positioning

The build so far is **invitation-only and deliberately exclusive** — "By
invitation" in the footer, "membership is by invitation" on the join page, a
dark editorial treatment designed around selectivity, and copy written for
high-net-worth travellers.

**That is the opposite of this brief.** 2CC is global, open and discovery-led.
Private communities can still exist as one option a host chooses, but exclusivity
is no longer the product's premise, its tone, or its front door.

## Key features, from the brief

1. Discover communities and activities **worldwide**
2. Explore updated event schedules **by country**
3. Connect with people who share similar interests
4. Build a global database of members and communities
5. Publish community news, stories and lifestyle content
6. Offer promotional opportunities for brands and clients

## The seven asks

| # | Ask | State today |
| --- | --- | --- |
| 1 | **Subscriptions** for membership — 3, 6, 12 times | Packages exist but are **1 / 3 / 6**. Tiers must change, and they are framed as one-off purchases rather than a membership subscription. |
| 2 | **Keep memberships in a database** — the platform wants to expand country by country | Members and memberships are stored. What is missing is the country dimension and any way to see the database as an asset. |
| 3 | **Content feed + banner ads** | Nothing. No articles, no feed, no ad slots. |
| 4 | **Landing page** | `/` exists but sells an invitation-only club, not this platform. |
| 5 | **Sell tickets with payment gateways** | Checkout is mocked by design. A real gateway is a decision with keys and money attached — not something to wire without the owner. |
| 6 | **Open for AMS for other partners** | Nothing. No advertiser or partner surface. |
| 7 | **Languages: English portal** | English only today, which satisfies the ask, but nothing is structured for a second language later. |

## What this changes about the design

- **Tone.** Open and global, not selective. "By invitation" goes.
- **Geography is the spine.** Country first, then city. The current build treats
  a city as decoration on a card.
- **Media is a first-class surface**, not an afterthought: articles, stories,
  lifestyle content, with a feed.
- **Advertising is a product**, so banner slots need real placements and a
  partner-facing way to manage them.
- **Membership is a subscription** (3 / 6 / 12), not a one-off pack of credits.

## What stays

The engineering underneath is sound and does not need rebuilding: communities,
events, members, attendees, bookings, tickets, the calendar, the photo pipeline,
auth, the host console, the light/dark theme, and the deploy path. The typography
and layout system are strong. This is a repositioning plus new surfaces, not a
rewrite.

## Open questions for the owner

1. **Payment gateway** — which provider, and whose account? Real payments need
   credentials and a legal entity. Until then checkout stays mocked, clearly
   labelled.
2. **AMS scope** — self-serve advertiser sign-up and campaign management, or an
   internal tool where 2CC staff place a partner's banners?
3. **Subscription meaning** — is 3/6/12 a number of activities, or a duration in
   months? "3, 6, 12 times" reads as a count of activities; a membership
   subscription usually reads as months. These build differently.

---

## The owner's answer to the open questions

> "the goal is to be able to demo the whole experience"

So: **build every surface, breadth first, and make the money convincing rather
than real.** No question below blocks work; the calls are made and recorded here.

| Question | Decision |
| --- | --- |
| Payment gateway | Stays **mocked**, and looks like a real card checkout. Wiring a live gateway needs the owner's provider, credentials and a legal entity, and none of that makes a demo better. The checkout says plainly that no card is charged. |
| AMS scope | A **partner console**: an advertiser signs in, sees their campaigns, their banner placements and the impressions those placements got. Demo data throughout. |
| 3 / 6 / 12 | A **count of activities**, not months. It matches the existing credit model, it matches "3, 6, 12 **times**", and it means a membership is legible as "12 activities" rather than a date to diary. Package tiers move from 1/3/6 to **3/6/12**, with a single ticket sold separately. |

## Build order for the demo

Each lands and deploys on its own, so the demo grows rather than waiting.

1. **Discovery by country and city, and search** — the spine. *(in progress)*
2. **Member profiles, and buying a single ticket** — *(in progress)*
3. **Reposition** — new landing page, "By invitation" and every trace of
   exclusivity out, "One World. Endless Connections." in.
4. **Content and media** — articles with covers and categories, a feed, article
   pages. A new `articles` table (new tables are fine; it is only `ALTER` that
   the deployed database refuses).
5. **Banner ads and the partner console** — an `ads` table, real placements in
   the layout, and the AMS surface above.
6. **Subscriptions 3 / 6 / 12** — retier the packages and reframe them as
   membership rather than a pack of credits.
7. **Vocabulary** — communities, events, tickets, packages, in the owner's words
   rather than the invented ones.
