#!/usr/bin/env bash
# 2CC end-to-end gate — criteria C5 and C6 of the loop spec.
#
# Drives the LIVE dev server over real HTTP with a real cookie jar. No mocks,
# no app.request(). If this passes, the member and host journeys actually work.
#
#   ./e2e.sh [base-url]     default http://localhost:8787
set -uo pipefail

BASE="${1:-http://localhost:8787}"
JAR="$(mktemp)"
HOSTJAR="$(mktemp)"
PASS=0
FAIL=0
FAILED_NAMES=()

c()  { curl -sS -b "$JAR"     -c "$JAR"     "$@"; }          # member session
ch() { curl_sS_h "$@"; }
curl_sS_h() { curl -sS -b "$HOSTJAR" -c "$HOSTJAR" "$@"; }

code()  { curl -sS -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" "$@"; }
codeh() { curl -sS -o /dev/null -w '%{http_code}' -b "$HOSTJAR" -c "$HOSTJAR" "$@"; }

ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); FAILED_NAMES+=("$1"); printf '  \033[31mFAIL\033[0m  %s\n     expected: %s\n     actual:   %s\n' "$1" "$2" "$3"; }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }
has()  { if printf '%s' "$3" | grep -qF -- "$2"; then ok "$1"; else bad "$1" "contains '$2'" "$(printf '%s' "$3" | head -c 180)"; fi; }
hasnt(){ if printf '%s' "$3" | grep -qF -- "$2"; then bad "$1" "must NOT contain '$2'" "found it"; else ok "$1"; fi; }

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- public pages
section "Public pages render"
for path in / /communities /events /join; do
  is "GET $path is 200" "200" "$(code "$BASE$path")"
done
is "GET /api/health" '{"status":"ok"}' "$(c "$BASE/api/health")"
is "unknown route 404s" "404" "$(code "$BASE/definitely-not-a-route")"

# The seeded directory must actually list communities.
COMMUNITIES_JSON="$(c "$BASE/api/communities")"
COMMUNITY_COUNT="$(printf '%s' "$COMMUNITIES_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(Array.isArray(j)?j.length:(j.communities||[]).length)}catch{console.log(0)}})')"
if [ "${COMMUNITY_COUNT:-0}" -ge 5 ]; then ok "api lists $COMMUNITY_COUNT communities"; else bad "api lists >=5 communities" ">=5" "$COMMUNITY_COUNT"; fi

SLUG="$(printf '%s' "$COMMUNITIES_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=Array.isArray(j)?j:(j.communities||[]);const pub=a.find(c=>!c.isPrivate)||a[0];console.log(pub.slug)})')"
is "GET /communities/$SLUG is 200" "200" "$(code "$BASE/communities/$SLUG")"

# Pick an event that actually has room. The seed deliberately includes a FULL
# one, and booking it is correctly refused — picking blindly made the gate blame
# the app for behaving properly.
EVENTS_JSON="$(c "$BASE/api/events?community=$SLUG")"
EVSLUG="$(printf '%s' "$EVENTS_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=Array.isArray(j)?j:(j.events||[]);const open=a.find(e=>e.placesLeft>0);console.log(open?open.slug:"")})')"
if [ -z "$EVSLUG" ]; then bad "community has a bookable event" "one with placesLeft>0" "none"; fi

# And find a full one anywhere, so the refusal path is covered rather than assumed.
FULLSLUG="$(c "$BASE/api/events?limit=100" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=Array.isArray(j)?j:(j.events||[]);const full=a.find(e=>e.placesLeft===0);console.log(full?full.slug:"")})')"

# ------------------------------------------------------------------ signed out
section "Signed out is properly gated"
is "/account redirects or 401s" "302" "$(code -o /dev/null "$BASE/account")"
is "/api/me is 401" "401" "$(code "$BASE/api/me")"
is "/host redirects" "302" "$(code "$BASE/host")"

# ----------------------------------------------------------------- member auth
section "Member signs in"
EMAIL="e2e-$(date +%s)@2cc.club"
LOGIN_CODE="$(code -X POST -d "email=$EMAIL" -d "name=E2E Member" "$BASE/auth/login")"
is "POST /auth/login redirects" "302" "$LOGIN_CODE"
ME="$(c "$BASE/api/me")"
has "/api/me returns the new member" "$EMAIL" "$ME"
is "/account now 200" "200" "$(code "$BASE/account")"

# ------------------------------------------------------------------- join flow
section "Join a community"
is "POST join redirects" "302" "$(code -X POST "$BASE/communities/$SLUG/join")"
MEMBERSHIPS="$(c "$BASE/api/me")"
has "membership recorded" "$SLUG" "$MEMBERSHIPS"

# ---------------------------------------------------------------- buy the pass
section "Buy a Trio (3-ticket) package"
PKG="$(c "$BASE/api/communities/$SLUG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const p=(j.packages||[]).find(p=>p.tickets===3);console.log(p?p.id:"")})')"
if [ -z "$PKG" ]; then bad "community has a 3-ticket package" "a package with tickets=3" "none"; fi
is "POST buy redirects" "302" "$(code -X POST "$BASE/communities/$SLUG/packages/$PKG/buy")"
TICKETS="$(c "$BASE/api/me" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const t=(j.packages||[]).reduce((n,p)=>n+(p.ticketsTotal-p.ticketsUsed),0);console.log(t)})')"
is "3 tickets available after purchase" "3" "$TICKETS"

# ------------------------------------------------ gallery, members, attendees
section "Explore: gallery, members, attendees"
COMMUNITY_DETAIL="$(c "$BASE/api/communities/$SLUG")"
PHOTOS="$(printf '%s' "$COMMUNITY_DETAIL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.photos||[]).length)})')"
if [ "${PHOTOS:-0}" -ge 4 ]; then ok "community has $PHOTOS gallery photos"; else bad "community gallery has >=4 photos" ">=4" "$PHOTOS"; fi
MEMBERS="$(printf '%s' "$COMMUNITY_DETAIL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.members||[]).length)})')"
if [ "${MEMBERS:-0}" -ge 1 ]; then ok "community lists $MEMBERS members"; else bad "community lists members" ">=1" "$MEMBERS"; fi

COMMUNITY_HTML="$(c "$BASE/communities/$SLUG")"
has "community page renders the gallery"  'data-gallery'  "$COMMUNITY_HTML"
has "community page renders members"      'data-members'  "$COMMUNITY_HTML"

EV_DETAIL="$(c "$BASE/api/events/$EVSLUG")"
ATT_BEFORE="$(printf '%s' "$EV_DETAIL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.attendees||[]).length)})')"
ok "event shows $ATT_BEFORE attendees before booking"
EV_HTML="$(c "$BASE/events/$EVSLUG")"
has "event page renders attendees" 'data-attendees' "$EV_HTML"
has "event page renders a gallery" 'data-gallery'   "$EV_HTML"

# ------------------------------------------------------------------- book flow
section "Book an event, spend a ticket"
is "GET /events/$EVSLUG is 200" "200" "$(code "$BASE/events/$EVSLUG")"
is "POST book redirects" "302" "$(code -X POST "$BASE/events/$EVSLUG/book")"
TICKETS_AFTER="$(c "$BASE/api/me" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const t=(j.packages||[]).reduce((n,p)=>n+(p.ticketsTotal-p.ticketsUsed),0);console.log(t)})')"
is "tickets 3 -> 2 after booking" "2" "$TICKETS_AFTER"

CODE="$(c "$BASE/api/me" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const b=(j.bookings||[]).find(b=>b.status==="confirmed");console.log(b?b.code:"")})')"
if [ -n "$CODE" ]; then
  is "ticket page 200" "200" "$(code "$BASE/account/tickets/$CODE")"
  has "ticket page shows the code" "$CODE" "$(c "$BASE/account/tickets/$CODE")"
else
  bad "booking produced a ticket code" "a code" "none"
fi

ATT_AFTER="$(c "$BASE/api/events/$EVSLUG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.attendees||[]).length)})')"
is "attendee count rose by one after booking" "$((ATT_BEFORE+1))" "$ATT_AFTER"

# double-booking must be refused, not silently double-charged
DOUBLE="$(code -X POST "$BASE/events/$EVSLUG/book")"
TICKETS_DOUBLE="$(c "$BASE/api/me" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.packages||[]).reduce((n,p)=>n+(p.ticketsTotal-p.ticketsUsed),0))})')"
is "second booking does not spend another ticket" "2" "$TICKETS_DOUBLE"

# An event at capacity must refuse, and must not silently take a ticket.
if [ -n "$FULLSLUG" ]; then
  section "A full event refuses the booking"
  ok "seed provides a full event ($FULLSLUG)"
  FULL_CODE="$(code -X POST "$BASE/events/$FULLSLUG/book")"
  if [ "$FULL_CODE" = "302" ] || [ "$FULL_CODE" = "409" ]; then ok "booking a full event is refused, not a 500 ($FULL_CODE)"; else bad "full event refused" "302 or 409" "$FULL_CODE"; fi
  TICKETS_FULL="$(c "$BASE/api/me" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.packages||[]).reduce((n,p)=>n+(p.ticketsTotal-p.ticketsUsed),0))})')"
  is "a refused booking spends no ticket" "2" "$TICKETS_FULL"
else
  bad "seed provides a full event" "one with placesLeft=0" "none"
fi

# ------------------------------------------------------------- mock checkout
section "Mock checkout is a real, visible step"
CHECKOUT="$(c "$BASE/communities/$SLUG/packages/$PKG/checkout")"
is "checkout page 200" "200" "$(code "$BASE/communities/$SLUG/packages/$PKG/checkout")"
has "checkout says it is a demo" "DEMO" "$CHECKOUT"
has "checkout shows the masked card" "4242" "$CHECKOUT"
hasnt "checkout has no enabled card input" 'name="cardNumber"' "$CHECKOUT"

# ------------------------------------------------------------------- calendar
section "Calendar"
is "GET /calendar is 200" "200" "$(code "$BASE/calendar")"
MONTH="$(node -e 'const d=new Date();console.log(d.toISOString().slice(0,7))')"
is "GET /calendar?month=$MONTH is 200" "200" "$(code "$BASE/calendar?month=$MONTH")"
is "invalid month is 400" "400" "$(code "$BASE/calendar?month=nonsense")"
CAL="$(c "$BASE/api/calendar?month=$MONTH")"
has "calendar api returns the month" "$MONTH" "$CAL"

# --------------------------------------------------------------- cancel refund
section "Cancel returns the ticket"
is "POST cancel redirects" "302" "$(code -X POST "$BASE/account/tickets/$CODE/cancel")"
TICKETS_BACK="$(c "$BASE/api/me" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.packages||[]).reduce((n,p)=>n+(p.ticketsTotal-p.ticketsUsed),0))})')"
is "tickets 2 -> 3 after cancel" "3" "$TICKETS_BACK"

# ------------------------------------------------------------------- host flow
section "Host creates a community, a package and an event"
HEMAIL="e2e-host-$(date +%s)@2cc.club"
is "host signs in" "302" "$(codeh -X POST -d "email=$HEMAIL" -d "name=E2E Host" "$BASE/auth/login")"
is "GET /host is 200" "200" "$(codeh "$BASE/host")"

NEWNAME="E2E Test Community $(date +%s)"
is "POST create community" "302" "$(codeh -X POST \
  --data-urlencode "name=$NEWNAME" \
  --data-urlencode "tagline=A community created by the end-to-end gate" \
  --data-urlencode "description=Created automatically to prove the host journey works end to end." \
  --data-urlencode "city=Lisbon" --data-urlencode "country=Portugal" \
  --data-urlencode "category=dining" \
  "$BASE/host/communities")"

NEWSLUG="$(curl_sS_h "$BASE/api/me" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const h=(j.hosting||[]);console.log(h.length?h[h.length-1].slug:"")})')"
if [ -z "$NEWSLUG" ]; then bad "new community appears under hosting" "a slug" "none"; fi

is "POST create package" "302" "$(codeh -X POST \
  --data-urlencode "name=Trio" --data-urlencode "tickets=3" --data-urlencode "priceCents=90000" \
  "$BASE/host/communities/$NEWSLUG/packages")"

STARTS="$(node -e 'const d=new Date(Date.now()+7*864e5);d.setUTCHours(18,0,0,0);console.log(d.toISOString().slice(0,16))')"
ENDS="$(node -e 'const d=new Date(Date.now()+7*864e5);d.setUTCHours(22,0,0,0);console.log(d.toISOString().slice(0,16))')"
is "POST create event" "302" "$(codeh -X POST \
  --data-urlencode "title=E2E Chef's Table" \
  --data-urlencode "summary=An event created by the end-to-end gate." \
  --data-urlencode "description=Long-form description for the end-to-end gate event." \
  --data-urlencode "venue=Rua do Teste 1" --data-urlencode "city=Lisbon" \
  --data-urlencode "startsAt=$STARTS" --data-urlencode "endsAt=$ENDS" \
  --data-urlencode "capacity=12" --data-urlencode "status=published" \
  "$BASE/host/communities/$NEWSLUG/events")"

has "new community is in the public directory" "$NEWSLUG" "$(c "$BASE/api/communities")"
NEWEV="$(c "$BASE/api/events?community=$NEWSLUG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=Array.isArray(j)?j:(j.events||[]);console.log(a.length?a[0].slug:"")})')"
if [ -n "$NEWEV" ]; then ok "new event is publicly listed ($NEWEV)"; else bad "new event publicly listed" "a slug" "none"; fi

# ---------------------------------------------------------- authorisation edge
section "A host cannot manage someone else's community"
is "member is refused on host's community" "403" "$(code -X POST --data-urlencode "name=X" --data-urlencode "tickets=1" --data-urlencode "priceCents=100" "$BASE/host/communities/$NEWSLUG/packages")"

# --------------------------------------------------------------- bad input 400
section "Bad input is rejected with 400, not a 500"
is "login without email" "400" "$(code -X POST -d "name=No Email" "$BASE/auth/login")"
is "booking an unknown event" "404" "$(code -X POST "$BASE/events/not-a-real-event/book")"
is "unknown community 404s" "404" "$(code "$BASE/communities/not-a-real-community")"

# ------------------------------------------------------------------- logout
section "Logout"
is "POST /auth/logout redirects" "302" "$(code -X POST "$BASE/auth/logout")"
is "/api/me is 401 again" "401" "$(code "$BASE/api/me")"

# ---------------------------------------------------------------- cleanup
# The host journey creates a real community and event. Leaving them behind
# pollutes the demo data and, because successive runs share a slug prefix and an
# identical start time, it also makes date-order assertions ambiguous. Remove
# what this run created. Best-effort: a missing psql is not a gate failure.
PSQL="/opt/homebrew/opt/postgresql@16/bin/psql"
if [ -x "$PSQL" ]; then
  PGPASSWORD=postgres "$PSQL" "postgres://postgres:postgres@localhost:5432/loop_dev" -q -c "
    delete from circles where slug like 'e2e-test-community-%';
    delete from users  where email like 'e2e-%@2cc.club';
  " >/dev/null 2>&1 && ok "cleaned up the data this run created" \
                    || printf '  note: cleanup skipped (database not reachable)\n'
else
  printf '  note: cleanup skipped (psql not found)\n'
fi

rm -f "$JAR" "$HOSTJAR"
printf '\n\033[1mE2E: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then printf 'failed: %s\n' "${FAILED_NAMES[*]}"; exit 1; fi
exit 0
