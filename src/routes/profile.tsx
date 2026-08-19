/**
 * Members: the page a member shows the world, and the form they change it on.
 *
 *   GET  /members/:id
 *   GET  /account/profile
 *   POST /account/profile
 *   GET  /api/members/:id
 *
 * Mounted into `src/routes/account.tsx`, which `src/index.ts` mounts at `/`, so
 * the paths above are the URLs.
 *
 * **The email is never on any of them.** `users.email` is the sign-in identity
 * (`src/auth.ts`); the member's own account page prints it from their own
 * session and nothing else does. Every read here goes through
 * `src/services/members.ts`, whose profile queries name their columns
 * explicitly so an address cannot arrive by a widened `select()`.
 *
 * The two conventions the rest of the app keeps, kept here:
 *
 *   - **A validation error re-renders the page with 400**, every submitted
 *     value echoed back, the problems listed in one `Alert`, and `aria-invalid`
 *     + `aria-describedby` on the offenders — the same shape the host forms use
 *     (`src/routes/host.tsx`). Nothing typed is ever lost.
 *   - **`Cache-Control: private, no-cache`** on every response, and a LIMIT on
 *     every list (AGENTS.md §5).
 */

import { Hono, type Context } from "hono";
import {
  currentUser,
  requireUser,
  setFlash,
  takeFlash,
  type AuthEnv,
  type Flash,
  type SessionUser,
} from "../auth";
import { formatDay, formatTime, plural } from "../lib/format";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../services/common";
import {
  getMemberProfile,
  listApprovedCommunitiesForMember,
  listUpcomingEventsForMember,
  updateMemberProfile,
  type MemberCommunity,
  type MemberEvent,
  type MemberProfile,
} from "../services/members";
import { Alert, Badge, Button, EmptyState, Field, Hero, Plate, Section } from "../ui/components";
import { Layout } from "../ui/layout";
import { initials } from "../ui/plate";

const profile = new Hono<{ Bindings: AuthEnv }>();

type PageContext = Context<{ Bindings: AuthEnv }>;

/** One member's own lists are small; this is the cap, not a target (AGENTS.md §5). */
const ROW_LIMIT = 50;

/** What a member may type about themselves, and how much of it. */
const MAX_NAME = 120;
const MAX_HEADLINE = 80;
const MAX_CITY = 120;
const MAX_BIO = 600;

/** A date or a code cannot wrap; the table scrolls in its own box instead (§10.4). */
const NOWRAP = "white-space:nowrap";

/** `.package-table` is `width:100%`, so a minimum width is what makes `.scroll-x` scroll. */
function wide(rem: number): string {
  return `min-width:${rem}rem`;
}

/** §10.4: `private, no-cache`, never `no-store` — that would kill bfcache. */
function pageHeaders(c: PageContext): void {
  c.header("cache-control", "private, no-cache");
}

/** First name only, for a line of copy that has room for one word. */
function firstName(name: string): string {
  const trimmed = name.trim();
  return trimmed === "" ? "This member" : trimmed.split(/\s+/)[0]!;
}

/* --------------------------------------------------------------- form input */

/** One submitted field, trimmed. A file upload is not a string and reads as empty. */
function readField(body: Record<string, unknown>, key: string): string {
  const raw = body[key];
  return typeof raw === "string" ? raw.trim() : "";
}

/** Every problem, keyed by field, so the summary and the field agree. */
type Errors = Record<string, string>;

/** What the form holds, submitted or loaded. Always strings — a textarea has no null. */
type ProfileForm = { name: string; headline: string; city: string; bio: string };

/** An optional field left blank is stored as NULL, so the page shows no line at all. */
function orNull(value: string): string | null {
  return value === "" ? null : value;
}

/* ------------------------------------------------------------- small pieces */

/** The confirmation banner: first thing inside `<main>`, above the `<h1>` (§10.4). */
function FlashBanner(props: { message: Flash }) {
  const warn = props.message.tone === "warn";
  return (
    <div class="shell" style="padding-block-start:24px">
      <Alert tone={warn ? "warn" : "brass"} confirm={!warn}>
        {props.message.message}
      </Alert>
    </div>
  );
}

/** Every problem in one place, above the form that still holds what was typed. */
function ErrorBanner(props: { problems: string[] }) {
  return (
    <div class="shell" style="padding-block-start:24px">
      <Alert tone="rust">
        <p>
          {props.problems.length} {props.problems.length === 1 ? "thing needs" : "things need"}{" "}
          fixing before this saves. Nothing you typed was lost.
        </p>
        {props.problems.map((problem) => (
          <p class="meta">{problem}</p>
        ))}
      </Alert>
    </div>
  );
}

/** A styled 404 (§8: never a stack trace). */
function notFoundPage(c: PageContext, me: SessionUser | null): Response | Promise<Response> {
  pageHeaders(c);
  return c.html(
    <Layout title="No such member" user={me ? { name: me.user.name } : null}>
      <Hero
        index="00"
        label="Not found"
        title="No such member"
        lede="Nobody here answers to that. Members are listed on the community they belong to."
      />
      <Section index="01" label="Elsewhere" title="Where to go instead">
        <div class="row">
          <Button href="/communities" variant="ghost">
            The communities
          </Button>
          <Button href="/events" variant="quiet">
            All events
          </Button>
        </div>
      </Section>
    </Layout>,
    404,
  );
}

/* ------------------------------------------------------- the public profile */

type ProfilePageProps = {
  viewer: { name: string } | null;
  member: MemberProfile;
  communities: MemberCommunity[];
  attending: MemberEvent[];
  /** Their own profile: offer the form rather than making them find it. */
  isSelf: boolean;
};

function MemberProfilePage(props: ProfilePageProps) {
  const { viewer, member, communities, attending, isSelf } = props;
  const who = isSelf ? "You are" : `${firstName(member.name)} is`;

  return (
    <Layout
      title={member.name}
      description={member.headline ?? `${member.name} on 2CC.`}
      user={viewer}
      active={isSelf ? "account" : undefined}
    >
      <Hero
        index="01"
        label="Member"
        title={member.name}
        lede={member.headline ?? undefined}
      >
        <div class="row" data-member={member.id}>
          <span style="display:block;width:96px;flex:none">
            <Plate seed={member.name} shape="square" monogram={initials(member.name)} />
          </span>
          <span class="stack">
            {member.city !== null ? <span class="meta">{member.city}</span> : null}
            <span class="meta num">
              {plural(communities.length, "community", "communities")} ·{" "}
              {plural(attending.length, "date booked", "dates booked")}
            </span>
          </span>
          {isSelf ? (
            <Button href="/account/profile" variant="quiet">
              Edit your profile
            </Button>
          ) : null}
        </div>
      </Hero>

      <Section index="02" label="About" title="In their words">
        <div data-bio="">
          {member.bio !== null ? (
            <div class="prose">
              <p>{member.bio}</p>
            </div>
          ) : isSelf ? (
            <EmptyState
              title="No note yet."
              note="Two or three sentences on what you do and what you turn up for."
              action={{ href: "/account/profile", label: "Write one" }}
            />
          ) : (
            <EmptyState
              title="No note yet."
              note={`${firstName(member.name)} has not written one. The communities below are the record.`}
            />
          )}
        </div>
      </Section>

      <Section index="03" label="Communities" title="Where they belong">
        {communities.length === 0 ? (
          <EmptyState
            title={`${who} not in a community yet.`}
            note="A community admits members by package or by the host's say-so."
            action={{ href: "/communities", label: "The directory" }}
          />
        ) : (
          <div class="bordered scroll-x" tabindex={0} data-communities="">
            <table class="package-table" style={wide(26)}>
              <caption class="vh">Communities {member.name} belongs to</caption>
              <thead style={NOWRAP}>
                <tr>
                  <th scope="col">Community</th>
                  <th scope="col">Where</th>
                </tr>
              </thead>
              <tbody>
                {communities.map((community) => (
                  <tr>
                    <th scope="row">
                      <a href={`/communities/${community.slug}`}>{community.name}</a>
                      <span class="package-derivation">
                        <Badge tone={community.role === "host" ? "brass" : "quiet"}>
                          {community.role === "host" ? "Host" : "Member"}
                        </Badge>{" "}
                        {community.category}
                      </span>
                    </th>
                    <td>
                      {community.city}
                      <span class="package-derivation">{community.tagline}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section index="04" label="Coming up" title="Where they will be">
        {attending.length === 0 ? (
          <EmptyState
            title="Nothing booked."
            note="Places show here once a ticket is spent on a date still to come."
            action={{ href: "/events", label: "The ledger" }}
          />
        ) : (
          <div class="bordered scroll-x" tabindex={0} data-attending="">
            <table class="package-table" style={wide(28)}>
              <caption class="vh">Events {member.name} is going to</caption>
              <thead style={NOWRAP}>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Event</th>
                </tr>
              </thead>
              <tbody>
                {attending.map((event) => {
                  const startsAt = new Date(event.startsAt);
                  return (
                    <tr>
                      <td class="num" style={NOWRAP}>
                        {formatDay(startsAt)}
                        <span class="package-derivation num">{formatTime(startsAt)}</span>
                      </td>
                      <th scope="row">
                        <a href={`/events/${event.slug}`}>{event.title}</a>
                        <span class="package-derivation">
                          <a href={`/communities/${event.communitySlug}`}>{event.communityName}</a> ·{" "}
                          {event.venue}, {event.city}
                        </span>
                      </th>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </Layout>
  );
}

profile.get("/members/:id", async (c) => {
  const me = await currentUser(c);
  const member = await getMemberProfile(c.env, c.req.param("id"));
  if (!member) return notFoundPage(c, me);

  const [communities, attending] = await Promise.all([
    listApprovedCommunitiesForMember(c.env, member.id, { limit: ROW_LIMIT }),
    listUpcomingEventsForMember(c.env, member.id, new Date(), { limit: ROW_LIMIT }),
  ]);

  pageHeaders(c);
  return c.html(
    <MemberProfilePage
      viewer={me ? { name: me.user.name } : null}
      member={member}
      communities={communities}
      attending={attending}
      isSelf={me !== null && me.user.id === member.id}
    />,
  );
});

/* ---------------------------------------------------------- the edit form */

type EditPageProps = {
  user: { id: string; name: string };
  flash: Flash | null;
  problems: string[];
  errors: Errors;
  form: ProfileForm;
};

function EditProfilePage(props: EditPageProps) {
  const { user, flash, problems, errors, form } = props;

  return (
    <Layout
      title="Your profile"
      description="Your name, your line, your city and a short note."
      user={{ name: user.name }}
      active="account"
    >
      {problems.length > 0 ? <ErrorBanner problems={problems} /> : null}
      {flash !== null && problems.length === 0 ? <FlashBanner message={flash} /> : null}

      <Hero
        index="01"
        label="Profile"
        title="How members see you"
        lede="Four things: your name, one line on what you do, your city, and a short note. Members of a community you join see all four. Nobody sees your email."
      >
        <Button href={`/members/${user.id}`} variant="quiet">
          See your public profile
        </Button>
      </Hero>

      <Section index="02" label="Details" title="Your details">
        <form class="column-420" method="post" action="/account/profile" data-profile-form="">
          <Field
            label="Name"
            name="name"
            value={form.name}
            required={true}
            error={errors.name}
            autocomplete="name"
            hint="What a host reads on the attendee list."
          />
          <Field
            label="Headline"
            name="headline"
            value={form.headline}
            error={errors.headline}
            hint={`One line: what you do. Up to ${MAX_HEADLINE} characters.`}
          />
          <Field
            label="City"
            name="city"
            value={form.city}
            error={errors.city}
            autocomplete="address-level2"
            hint="Where you are based most of the year."
          />
          <Field
            label="About you"
            name="bio"
            value={form.bio}
            multiline={true}
            rows={6}
            error={errors.bio}
            hint={`Two or three sentences. Up to ${MAX_BIO} characters.`}
          />

          <div style="margin-block-start:32px">
            <Button type="submit" variant="primary">
              Save your profile
            </Button>
          </div>
        </form>
      </Section>
    </Layout>
  );
}

/** The whole page from a form state. Shared by the GET and the 400 re-render. */
function renderEdit(
  c: PageContext,
  me: SessionUser,
  state: { flash: Flash | null; problems: string[]; errors: Errors; form: ProfileForm },
  status: 200 | 400,
): Response | Promise<Response> {
  pageHeaders(c);
  return c.html(
    <EditProfilePage
      user={{ id: me.user.id, name: me.user.name }}
      flash={state.flash}
      problems={state.problems}
      errors={state.errors}
      form={state.form}
    />,
    status,
  );
}

profile.get("/account/profile", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  const flash = await takeFlash(c.env, me.session);
  return renderEdit(
    c,
    me,
    {
      flash,
      problems: [],
      errors: {},
      form: {
        name: me.user.name,
        headline: me.user.headline ?? "",
        city: me.user.city ?? "",
        bio: me.user.bio ?? "",
      },
    },
    200,
  );
});

profile.post("/account/profile", async (c) => {
  const me = await requireUser(c);
  if (me instanceof Response) return me;

  const body = await c.req.parseBody();
  const form: ProfileForm = {
    name: readField(body, "name"),
    headline: readField(body, "headline"),
    city: readField(body, "city"),
    bio: readField(body, "bio"),
  };

  // Only the name is required — the other three are a member's own business,
  // and an empty one is stored as NULL rather than rejected.
  const errors: Errors = {};
  if (form.name === "") errors.name = "A name is needed.";
  else if (form.name.length > MAX_NAME) {
    errors.name = `A name is longer than ${MAX_NAME} characters.`;
  }
  if (form.headline.length > MAX_HEADLINE) {
    errors.headline = `A headline is longer than ${MAX_HEADLINE} characters.`;
  }
  if (form.city.length > MAX_CITY) errors.city = `A city is longer than ${MAX_CITY} characters.`;
  if (form.bio.length > MAX_BIO) errors.bio = `The note is longer than ${MAX_BIO} characters.`;

  const problems = Object.values(errors);
  if (problems.length > 0) {
    return renderEdit(c, me, { flash: null, problems, errors, form }, 400);
  }

  await updateMemberProfile(c.env, me.user.id, {
    name: form.name,
    headline: orNull(form.headline),
    city: orNull(form.city),
    bio: orNull(form.bio),
  });

  await setFlash(c.env, me.session.id, "Profile saved. Members of your communities see it now.");
  return c.redirect("/account/profile", 302);
});

/* ---------------------------------------------------------------- the JSON */

/** `?limit=` — 1 to 100, default 50. A bad one is a 400, never a silent fallback. */
function readLimit(c: PageContext): number | Response {
  const raw = c.req.query("limit");
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    return c.json({ error: `limit must be a whole number between 1 and ${MAX_LIMIT}` }, 400);
  }
  return value;
}

profile.get("/api/members/:id", async (c) => {
  const limit = readLimit(c);
  if (limit instanceof Response) return limit;

  const member = await getMemberProfile(c.env, c.req.param("id"));
  if (!member) return c.json({ error: "Member not found" }, 404);

  const [communities, attending] = await Promise.all([
    listApprovedCommunitiesForMember(c.env, member.id, { limit }),
    listUpcomingEventsForMember(c.env, member.id, new Date(), { limit }),
  ]);

  c.header("cache-control", "private, no-cache");
  return c.json({ member, communities, attending });
});

export default profile;
