# Yosan — Roadmap & saved plans

_Last updated: 2026-07-06. Live version at time of writing: **v92**._

Three deployments, kept in sync on every change:
- **Kelly** — `https://dchu12.github.io/yosan/`
- **Derek** — `https://dchu12.github.io/yosan/derek/`
- **Beta (public)** — `https://dchu12.github.io/yosan/beta/`

## Shipped (game-changer roadmap)
- ✅ **#1 Natural-language quick add** (v90) — type "38 ramen" → parses amount + category + note, Enter to save.
- ✅ **#2 Context-aware coach + burn-rate** (v91) — predicts when a category will run out before payday; sometimes shows projected end-of-period savings.
- ✅ **#5 End-of-period recap card** (v92) — shareable "wrapped"-style recap on close; re-openable from History.

## Paused — pick up later

### #4 Household (linking / invites / admin) — DECISIONS LOCKED
User decisions:
- **Optional sign-in**: app stays fully usable logged-out; signing in unlocks creating/joining a household. Goes in ALL apps incl. public Beta so real new users can form households.
- **Two people per household** (a couple): admin + one partner.
- **Summaries only**: members see each other's left-to-spend / spent / saved, NOT individual categories or transactions.
- Invite = **shareable link + 6-char code**. **Admin** can invite, remove the member, rename the household; either person can leave.

Planned architecture (build additively so it can't break existing Kelly⇄Derek sync):
- **Auth**: add sign-up + sign-in (email/password) as an optional unlock. (Today only sign-in exists; accounts were pre-made in the console.)
- **Firestore**: `households/{id}` (adminUid, members, inviteCode) + `households/{id}/summaries/{uid}` (name, leftToSpend, spent, saved, updatedAt). Each app publishes just its summary and reads the partner's.
- **Together view**: a card — "You + [partner] have $X left together" — plus rename/remove/leave controls.

Requires from Derek (Firebase console):
1. Enable **Email/Password** auth + allow account creation (sign-up).
2. Deploy **Firestore security rules** (Claude will provide) so a household's data is readable/writable only by its members.

Testing caveat: live two-person linking can only be verified by Derek with two real accounts/devices — it can't be tested from the build sandbox. Claude will provide a test script.

### #3 Push notifications — build LAST, then walkthrough
- App-side: Firebase Cloud Messaging web push — payday reminder, "period ends in 2 days", "near a category limit". Opt-in.
- Requires from Derek (Firebase console): enable Cloud Messaging, generate a **VAPID web-push key**, add the messaging config; a `firebase-messaging-sw.js` service worker.
- Claude will build the app side, then give a click-by-click Firebase console walkthrough.
- Both #3 and #4 need the same Firebase console visit — do them together to save trips.

## Deploy mechanics note
Since the repo was renamed (`Derekchu12-` → `yosan`), direct `git push` to the **main** branch is dropped by GitHub's redirect; branch pushes work. Deploys are landed by pushing the feature branch, then an **API merge** (PR) into main. GitHub Pages deploys from `main`.
