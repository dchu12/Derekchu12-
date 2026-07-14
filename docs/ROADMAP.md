# Yosan — Roadmap & saved plans

_Last updated: 2026-07-14. Live version at time of writing: **v123**._

Three deployments, kept in sync on every change (now generated from one
source — edit `src/app.js`, run `npm run build`; see the README):
- **Kelly** — `https://dchu12.github.io/yosan/`
- **Derek** — `https://dchu12.github.io/yosan/derek/`
- **Beta (public)** — `https://dchu12.github.io/yosan/beta/`

## ⏭️ Open action items (saved 2026-07-14)

**Needs a Firebase console visit by Derek — do these together to save a trip:**
1. **Publish `firestore.rules`** — the roles + per-user access rules are written and committed but NOT live until published (Firestore Database → Rules → paste → Publish). See `docs/ADMIN.md`. Right after publishing: (a) confirm Kelly's exact account-email casing matches `isKelly()`, and (b) log a spend on Kelly's device to confirm sync still works.
2. **#3 Push notifications** — payday reminder, "period ends in 2 days", near-a-limit. Needs Cloud Messaging enabled + a VAPID web-push key + `firebase-messaging-sw.js`. Claude builds the app side, then a click-by-click console walkthrough. (Details below under "Paused".)
3. **#4 Household linking** — optional sign-up + two-person shared summaries. Needs Email/Password sign-up enabled + the household Firestore rules. Decisions are locked (below). Pairs with tightening `isKelly()`/`isCore()` into real membership.

**App-side follow-ups (no console needed, do anytime):**
4. ✅ **Savings counts as saved, not spent** (v123) — `periodConsumed` excludes savings transfers; `periodSaved = income − consumed`, applied across History/Results/save-rate/recap/report. Dashboard budget-execution unchanged.
5. **Public sign-up flow** — add a "Create account" option to the sign-in screen (only after #1 is published and budgets are keyed per-uid, so new users can't read Kelly/Derek data).
6. **Admin "reset / delete a user's data"** — currently the admin can Pause/Enable (revoke access) only; a guarded destructive reset was intentionally left out. Add if wanted.
7. **Reports IA — round three (optional)** — v122 added segmented Insights/History; v123 made saved-per-period a diverging zero-baseline chart + merged the total-saved card. Could still: collapsible cards, or a diverging save-rate chart too.
8. **Single-source the styles too (optional)** — `styles.css`/`index.html`/`manifest.json` are still per-deployment (theme colors, tab set). Could tokenize the accent color + firebase/tab differences into the build like `app.js`.

_Shipped so far (v116–v123): quick-add thousands-comma fix; Guest/Member/Admin roles + admin panel; test harness + CI; single-source build; CSV export; Reports save-rate trend; Spend search + date range; first-run onboarding; tightened Firestore rules; update-available toast; accessibility pass; savings-shown-as-positive; dark mode; ~40 more coach book quotes (more frequent, gentler on overspending); over-allocated hint; segmented Reports; savings-counts-as-saved; diverging saved-per-period chart._

## Shipped (game-changer roadmap)
- ✅ **#1 Natural-language quick add** (v90) — type "38 ramen" → parses amount + category + note, Enter to save.
- ✅ **#2 Context-aware coach + burn-rate** (v91) — predicts when a category will run out before payday; sometimes shows projected end-of-period savings.
- ✅ **#5 End-of-period recap card** (v92) — shareable "wrapped"-style recap on close; re-openable from History.
- ✅ **Roles: Guest / Member / Admin** (v117) — guest = local-only, member = signed-in + synced, admin (`derekchu12@gmail.com`) = admin panel (user directory + view accounts, pause/enable, broadcast banner, feature flags). App side + `firestore.rules`; deploy walkthrough in `docs/ADMIN.md`. Server enforcement needs the rules published in the Firebase console.

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
