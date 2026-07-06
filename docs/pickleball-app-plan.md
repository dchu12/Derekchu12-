# 🏓 Open Play Pickleball App — Technical Plan

**Status:** Planning / architecture proposal (no code written yet)
**Scope decisions made with the user:**

- Planning only for now — this doc is for review before any build.
- Integrate with **DUPR** (official Partner API). **Reclub is dropped** as an integration target (see below).
- Tech approach: **left to recommendation** → server-backed app on Firebase (rationale below).

---

## 1. Feasibility summary

| Integration | Feasible? | Why |
|---|---|---|
| **DUPR** | ✅ Yes | DUPR runs an official **Partner API**: player/rating lookup, match create + **bulk submit**, rating-change **webhooks**, clubs, events. Requires being approved as a DUPR API partner to get a **client key + secret** (UAT + production). Some read-only public profile/rating endpoints also exist. |
| **Reclub** | ⚠️ No (recommended to drop) | Reclub is a **consumer app and a direct competitor** to what we're building (login + open-play discovery/RSVP + DUPR submission, live in 35+ countries). No public/developer API was found for third parties to build on. Its only integration is Reclub→DUPR, not Reclub→us. Options if revisited: (a) ask Reclub about a partnership, (b) unofficial scraping — **not recommended** (fragile, likely violates ToS). |

**Bottom line:** The product is very buildable. Integrate directly with DUPR; treat Reclub as a competitor to differentiate from, not a partner.

---

## 2. Product scope (v1)

Core loop: **sign in → find/join an open-play session → play → enter scores → results push to DUPR → ratings update.**

**Must-have (v1)**
- User accounts (email + social sign-in)
- Player profile, optionally linked to a DUPR account (by email → DUPR ID)
- Create / browse / join **open-play sessions** (venue, date/time, court count, skill range, capacity)
- RSVP with live roster + waitlist; see who's coming and their DUPR rating
- Score entry for games played in a session
- Push match results to DUPR (bulk) and reflect updated ratings back in-app

**Nice-to-have (later)**
- Organizer tools: court assignment by skill, check-in, session templates
- Ratings history charts, leaderboards within a club
- Push notifications (session reminders, roster changes, rating updates)
- Payments / session fees
- Clubs/venues as first-class entities with membership

**Explicitly out of scope for v1:** tournament brackets, payments, native iOS/Android (PWA first).

---

## 3. Recommended architecture

**Recommendation: server-backed app on Firebase, PWA frontend.**

Two hard constraints rule out a pure client-side app (like today's Yosan):
1. **Open play is multi-user.** Shared sessions, RSVPs, and live rosters require a shared database, not per-device `localStorage`.
2. **DUPR requires a server.** The Partner API uses a **client secret that must never ship in browser JS**, and DUPR **webhooks** need a server endpoint to receive rating-change events.

Firebase is chosen because it satisfies both with low ops, and Yosan already uses Firebase (Auth/Firestore) — so the team knows it.

```
┌─────────────────────────────────────────────────────────┐
│  PWA frontend (installable, like Yosan)                   │
│  - Auth UI, session discovery, RSVP, score entry          │
│  - Talks ONLY to Firebase (Auth + Firestore) + callable   │
│    Cloud Functions. Never sees the DUPR secret.           │
└───────────────┬───────────────────────────────────────────┘
                │
   ┌────────────┴───────────────┐
   │ Firebase Auth              │  email + Google/Apple sign-in
   │ Firestore (DB)             │  users, sessions, rsvps, matches
   │ Cloud Functions (backend)  │  ← holds DUPR client key/secret
   └────────────┬───────────────┘
                │  server-to-server (secret stays here)
                ▼
        ┌───────────────────┐
        │   DUPR Partner API │  players, ratings, matches (bulk),
        │   + webhooks       │  clubs, events
        └───────────────────┘
```

**Why not a plain React + Postgres + Node stack?** Also valid, and better if the team prefers full control / SQL / to avoid vendor lock-in. But it's more infra to stand up (host, DB, auth, deploy). Firebase gets a multi-user MVP running fastest and matches the existing stack. If we outgrow it, the data model below ports cleanly to Postgres.

---

## 4. Data model (Firestore collections)

```
users/{uid}
  displayName, email, photoURL
  duprId            // set once linked
  duprLinked: bool
  homeRatingSingles, homeRatingDoubles   // cached from DUPR
  createdAt

sessions/{sessionId}          // an open-play event
  title, venueName, venueGeo
  startAt, endAt
  courtCount, capacity
  skillMin, skillMax          // DUPR range
  organizerUid
  status: open | full | closed | cancelled
  attendeeCount               // denormalized for cheap listing

sessions/{sessionId}/rsvps/{uid}
  uid, status: going|waitlist|cancelled
  rating                      // snapshot at RSVP time
  joinedAt

matches/{matchId}
  sessionId
  teamA: [uid...], teamB: [uid...]
  scores: [[11,7],[9,11],[11,6]]
  enteredBy, enteredAt
  duprStatus: pending | submitted | confirmed | error
  duprMatchId                 // returned by DUPR on submit
```

**Security rules (sketch):** users read/write their own profile; anyone signed-in reads open sessions; only the organizer edits a session; RSVP writes limited to the acting user; **matches are validated/submitted via a Cloud Function**, not written directly from the client, so scores can't be forged before hitting DUPR.

---

## 5. DUPR integration design

All DUPR calls happen in **Cloud Functions** (secret-holding backend). The client never talks to DUPR.

| Flow | Trigger | DUPR call |
|---|---|---|
| **Link account** | User taps "Connect DUPR", enters DUPR email | Look up DUPR ID by email → store `duprId` on user |
| **Refresh rating** | On link, and on a schedule / after matches | Get player rating → cache on user doc |
| **Submit results** | Organizer/host closes a session | **Bulk create matches** for that session; store `duprMatchId` + status per match |
| **Rating updates** | DUPR sends webhook | Cloud Function HTTP endpoint verifies + updates cached ratings |

**Auth to DUPR:** partner client key + secret stored in Firebase Functions config / Secret Manager, exchanged for access tokens (auto-refreshed). Use the **UAT environment** for all development, production only after approval.

**Prerequisite (start early — it gates everything):** apply for **DUPR API partner** access to obtain credentials. This approval is the long pole; begin it before/at the start of the build.

---

## 6. Build phases

1. **Foundation** — Firebase project, Auth (email + Google), PWA shell, user profile. *No DUPR yet.*
2. **Open play core** — create/browse/join sessions, RSVP + waitlist, live roster. *This is a complete, useful app on its own even before DUPR.*
3. **Score entry** — record games within a session; store matches with `duprStatus: pending`.
4. **DUPR read** — link account by email, cache + display ratings, skill-range filtering on sessions.
5. **DUPR write** — bulk-submit matches, handle webhook rating updates, surface submit status/errors.
6. **Polish** — organizer tools (court assignment), notifications, ratings history.

Phases 1–3 need **no DUPR credentials**, so the app can be built and demoed in parallel with the partner-approval process.

---

## 7. Open questions for the user

1. **New repo vs. here?** This decision was deferred. Given Yosan is a live budgeting app, a **separate repo** is cleanest; reusing this one means archiving/replacing Yosan. (Recommend separate repo.)
2. **Geographic focus / venues** — are these public courts, a specific club, or user-created meetups?
3. **Who submits scores** — self-report by players, or organizer-verified before pushing to DUPR? (Affects trust + the security rules above.)
4. **Singles, doubles, or both** in v1?
5. **Do you already have a DUPR partner relationship**, or do we need to start the application from scratch?

---

## 8. Risks

- **DUPR partner approval timeline** — external dependency, unknown lead time. Mitigation: build phases 1–3 without it.
- **Score integrity** — self-reported scores hitting real DUPR ratings is abuse-prone. Mitigation: organizer confirmation step + server-side validation.
- **Reclub competition** — mature incumbent. Differentiation (niche club focus, better UX, specific geography) matters more than feature parity.
- **DUPR API terms** — confirm rate limits, allowed data caching, and display requirements before shipping.
