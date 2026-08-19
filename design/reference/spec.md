> **SUPERSEDED.** This described 2CC as an invitation-only club for a small,
> selective membership. The owner's real brief is the opposite: a global,
> open community and media platform. See **brief-v2.md**, which wins over
> everything in this file. Kept only because the screen list and the
> vocabulary section are still accurate.

# 2CC — the members' community

A private events platform for people who travel. Communities ("communities") run
events; members buy packages and attend. Think Airbnb Experiences crossed with
a yacht club's calendar — for a small, selective membership rather than the
public.

The brief comes from two references the owner gave:

- **iwelty.com** — a wellness activity platform: discover / book / join classes
  and events, card-based listings, category filters, three membership tiers.
  Take the *structure* from this: directory → detail → book, membership tiers,
  clean card grid.
- **rizzup event registration** (`event-registration.rizzup.com/match-on-court`)
  — a single-event registration funnel. Returned HTTP 403 to our fetch, so it
  was **not** read; nothing here is derived from it. Treated as "a focused
  one-event signup flow" only.

Where the references are bright, friendly and mass-market, 2CC is the opposite:
**dark, quiet, expensive-feeling, invitation-only.**

## Who it is for

High-net-worth members who travel. They land in a new city and want the same
quality of company and activity they have at home: a sunrise padel session, a
chef's table, a day on someone's boat, a members-only strength class.

Two sides of the product:

- **Members** — browse communities, request to join, buy a package, book an event.
- **Hosts** — run a community, publish events, price packages, approve members,
  see who is coming.

## Vocabulary (use these words in the UI)

| Word | Means |
| --- | --- |
| **Community** | a community — "Adriatic Sailing Society", "The Cold Room" |
| **Event** | an event a community runs at a date, time and venue |
| **Package** | prepaid tickets for one community: **Single (1)**, **Trio (3)**, **Season (6)** |
| **Member** | a signed-in person |
| **Host** | the member who runs a community |

A package is scoped to one community. Booking an event spends one ticket from a
package for that community. Cancelling returns the ticket.

## Screens

1. **Landing `/`** — hero statement, how it works in three steps, featured
   communities, next events, a quiet note that membership is by invitation.
2. **Communities `/communities`** — filterable card grid (all / sailing / wellness /
   dining / sport / art), city and member count on each card.
3. **Community `/communities/:slug`** — cover, host, the story, upcoming events,
   the three packages with prices, join / request-to-join.
4. **Events `/events`** — the whole calendar, soonest first.
5. **Event `/events/:slug`** — cover, when/where, description, capacity and
   places left, the community it belongs to, book button.
6. **Join `/join`** — the sign-in. Email + name, framed as an invitation.
7. **Account `/account`** — packages and tickets left, upcoming bookings, communities
   joined, ticket links.
8. **Ticket `/account/tickets/:code`** — a single confirmation, code shown large.
9. **Host console `/host`** — my communities, create a community.
10. **Manage community `/host/communities/:slug`** — publish an event, set packages,
    approve pending members, see attendees per event.

## Look and feel

Dark, editorial, generous whitespace. Nothing shouts.

```
--ink-950   #0A0A0B    page
--ink-900   #101012    raised surface
--ink-800   #17171A    card
--line      rgba(240,232,218,0.10)
--ivory     #F4EFE7    primary text
--ivory-dim #A9A399    secondary text
--brass     #C8A961    the one accent — hairlines, small caps, prices
--brass-lit #E0C88A    hover
```

- **Display type:** Fraunces (serif) — headlines, community names, prices.
- **UI type:** Inter — everything else.
- **Small caps + letter-spacing** for labels and metadata. This is the main
  "expensive" signal, along with hairline rules in `--brass`.
- **Cover art:** no photography available, so covers are generated — a
  deterministic gradient per community/event derived from its slug, with a fine
  grain overlay. They must look intentional, not like a missing image.
- Mobile-first. Everything readable at 375px, comfortable at 1280px.
- Motion: almost none. A slow fade or a hairline that lights up on hover.

## Non-goals for this build

- No real payments. Buying a package is a mock checkout that records an order.
- No email sending. Sign-in is email + name, no password, no magic link.
- No photo uploads. Covers are generated.
