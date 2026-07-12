# Roles & Admin — setup and walkthrough

Yosan now has **three kinds of user instance**:

| Role | Who | What they can do |
|------|-----|------------------|
| **Guest** | Not signed in | Full app, local-only (nothing leaves the device). No sync. |
| **Member** | Any signed-in account | Everything a guest can, plus cloud sync of their budget and shared monthly results. |
| **Admin** | `derekchu12@gmail.com` | Everything a member can, plus the **Admin panel**: see all accounts and their data, pause/enable accounts, broadcast a message to everyone, and toggle features app-wide. |

Roles are decided by the signed-in email. The app only *reveals* the admin UI to
the admin; the real enforcement lives in **`firestore.rules`** (server-side), so a
technical user editing the client JavaScript still can't read other people's data
or write app config.

---

## What the admin can do (in-app)

Open **Settings → Admin → Open admin panel** (only visible when signed in as the
admin):

- **📢 Broadcast** — type a message, flip it on, Save. It appears as a bar at the
  top of the app for **everyone** (including signed-out visitors). Clear it by
  turning it off and saving.
- **Feature flags** — toggle features app-wide:
  - *Quick add* — the natural-language "38 ramen" field on Log spend.
  - *Vacation Mode* — the vacation-budget preference.
  Flags default to **on** if config hasn't loaded, so nothing disappears by accident.
- **Users** — a live directory of every account that has signed in (name, email,
  which deployment, last-active). For each account you can:
  - **View** — a read-only summary of their current period (left / income /
    budgeted / spent, category breakdown, months on record).
  - **Pause / Enable** — a paused account is locked out of the app on its next
    sync with an "Account paused" screen. Their data stays safe; enabling restores
    access. (You can't pause your own admin account.)

---

## One-time Firebase setup (Derek)

The app side is already deployed. To turn on **server-side enforcement**, publish
the rules once:

1. Go to the [Firebase console](https://console.firebase.google.com/) → project
   **payday-budget-496a1**.
2. **Build → Firestore Database → Rules** tab.
3. Replace the contents with the file **`firestore.rules`** from this repo.
4. Click **Publish**.

   *(CLI alternative, if you use the Firebase CLI:*
   `firebase deploy --only firestore:rules` *with `firestore.rules` referenced in
   `firebase.json`.)*

That's it — no custom claims needed. The admin is recognized by the email on the
sign-in token.

### Optional — let new people sign up

Today accounts are pre-created in the console, so only Kelly and Derek exist. If
you want *new* users to be able to register themselves (each becoming a **Member**):

1. **Build → Authentication → Sign-in method → Email/Password → Enable.**
2. Add a sign-up path in the app (not built yet — say the word and I'll add a
   "Create account" option to the sign-in screen).

---

## How to test after publishing rules

1. **Admin path** — sign in as `derekchu12@gmail.com` (Derek's app or the root
   app). Settings should show an **Admin** section with a role badge. Open the
   panel: you should see the Users list populate as accounts sign in.
2. **Broadcast** — turn on a broadcast in the admin panel; open the app in another
   browser/device (even signed out) and confirm the bar appears at the top. Turn
   it off and confirm it disappears.
3. **Member path** — sign in as `Kellyseadreams@gmail.com`. Settings should show a
   **Member** badge and **no** Admin section.
4. **Pause** — from the admin panel, Pause the Kelly account; on Kelly's device the
   app should switch to the "Account paused" lock on next sync. Enable to restore.
5. **Rules smoke test** — while signed in as a member, confirm you *cannot* write
   `app/config` (the flag/broadcast controls simply aren't shown to members, and a
   direct write would be denied by rules).

---

## Known limitations / follow-ups

- **`disabled` is honored by the client.** Pausing hides the app and stops that
  device from syncing UI, but because budgets are still keyed per-deployment
  (`kelly` / `derek`) rather than per-user, the rules can't yet hard-block a paused
  account's *budget writes*. This is fine for the current fixed set of accounts.
- **Budgets are readable by any signed-in account.** This deliberately preserves
  the existing Kelly⇄Derek sync. It's safe while sign-up is closed (only Kelly and
  Derek accounts exist). **Before enabling public sign-up**, migrate budgets to
  per-uid keys and tighten the `budgets/{key}` / `results/{key}` rules to
  `isOwner`/household membership — otherwise a new user could read the existing
  budgets. This pairs naturally with the roadmap's Household (#4) work.
- **Reset / delete a user's data** isn't wired to a button yet (Pause covers
  "revoke access" safely). The rules already allow the admin to delete a `users/*`
  doc; ask if you want a guarded "reset data" action added.
