/**
 * Who is in a community, and who is coming to an event
 * (`design/reference/api-contract.md`, Scope addition §B and §C).
 *
 * Both lists use an initials plate rather than an avatar: §7 bans coloured
 * initial-avatars, and a plate with no wash is the same object the covers are,
 * at 44px. Engraving is off at that size — a 0.5px hairline inside a 44px
 * square is mush, and it would cost 6KB a head.
 *
 * A person's name links to `/members/:id` when the caller supplies an `id`.
 * It is optional rather than required so that a list built from rows that do
 * not carry a user id still renders — it just renders without the link.
 */

import { Plate } from "./components";
import { initials } from "./plate";

export type PersonEntry = {
  name: string;
  /** One line: what they do. From the seed, never generated here. */
  headline: string;
  city?: string;
  /**
   * The member's `users.id`. Given one, the name links to their profile at
   * `/members/:id`; without one it stays plain text, so a caller that has no id
   * to hand renders exactly what it rendered before.
   */
  id?: string;
};

/**
 * The name is the link, not the whole card: §10.4's whole-card `::after`
 * pattern needs the card to be the only interactive thing in it, and a person
 * card sits inside lists that already carry links of their own.
 *
 * The inline style is §10.4's hit-area recipe — 44px of target grown with
 * matching negative margins, so the row is touchable without the card getting
 * taller. Same numbers the stylesheet uses for `.ledger-row a`.
 */
const NAME_LINK =
  "display:inline-flex;align-items:center;min-height:44px;margin-block:-10px;margin-inline:-8px;padding-inline:8px";

function Person(props: { person: PersonEntry; role?: string }) {
  const { person, role } = props;
  return (
    <div class="person">
      <Plate seed={person.name} shape="bare" engraving={false} monogram={initials(person.name)} />
      <div class="person-body">
        {role !== undefined ? <span class="status status--brass">{role}</span> : null}
        <p class="person-name">
          {person.id !== undefined ? (
            <a href={`/members/${person.id}`} style={NAME_LINK}>
              {person.name}
            </a>
          ) : (
            person.name
          )}
        </p>
        <p class="person-line">{person.headline}</p>
        {person.city !== undefined ? <p class="person-line">{person.city}</p> : null}
      </div>
    </div>
  );
}

export type MemberListProps = {
  /** Approved members only. Pending members are never shown publicly. */
  members: PersonEntry[];
  /** The community's `memberCount`. Must agree with the card and the host console. */
  total: number;
  /** Shown first and labelled Host. */
  host?: PersonEntry;
  /** Where `+N more` goes, when there are more than the twelve shown. */
  moreHref?: string;
};

/** Approved members: initials plate, name, headline, city. Caps at 12. */
export function MemberList(props: MemberListProps) {
  const { members, total, host, moreHref } = props;
  const shown = members.slice(0, host === undefined ? 12 : 11);
  const hidden = total - shown.length - (host === undefined ? 0 : 1);

  return (
    <div>
      <div class="people">
        {host !== undefined ? <Person person={host} role="Host" /> : null}
        {shown.map((m) => (
          <Person person={m} />
        ))}
      </div>
      <div class="people-foot">
        <span class="meta num">{total} members</span>
        {hidden > 0 ? (
          moreHref !== undefined ? (
            <a class="btn btn--quiet" href={moreHref}>
              +{hidden} more
            </a>
          ) : (
            <span class="meta num">+{hidden} more</span>
          )
        ) : null}
      </div>
    </div>
  );
}

export type AttendeeListProps = {
  /** Confirmed bookings only. Cancelled bookings never appear. */
  attendees: PersonEntry[];
  /** Confirmed count. Must agree with `placesLeft` on every other page. */
  going: number;
  capacity: number;
  /** Signed out: the count, a few names, and the sign-in line. */
  signedOut?: boolean;
  /** `/join?next=…` for the signed-out case. */
  signInHref?: string;
};

/** Confirmed attendees, and `9 of 12 going`. */
export function AttendeeList(props: AttendeeListProps) {
  const { attendees, going, capacity, signedOut, signInHref } = props;
  const shown = signedOut === true ? attendees.slice(0, 3) : attendees.slice(0, 12);
  const hidden = going - shown.length;

  return (
    <div>
      <p class="action-line">
        {going} of {capacity} going
      </p>
      {shown.length > 0 ? (
        <div class="people" style="margin-block-start:16px">
          {shown.map((a) => (
            <Person person={a} />
          ))}
        </div>
      ) : (
        <p class="meta" style="margin-block-start:16px">
          Nobody has booked yet. Places open until the day before.
        </p>
      )}
      <div class="people-foot">
        {signedOut === true ? (
          <a class="btn btn--quiet" href={signInHref ?? "/join"}>
            Sign in to see who's going
          </a>
        ) : hidden > 0 ? (
          <span class="meta num">+{hidden} more</span>
        ) : null}
      </div>
    </div>
  );
}
