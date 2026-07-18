# Household linking — core slice (test build)

Pair two accounts so each sees a combined **"together, left to spend"** plus each
person's left / spent / saved. **Summaries only** — categories and transactions
never leave the device. This is the generic version for new couples; Kelly &
Derek keep their built-in Results comparison too.

**What's in this slice:** create a household · join by 6-char code (or `?join=`
link) · together view · leave. **Not yet:** admin rename / remove-a-member UI,
and public sign-up (brand-new accounts) — those are the second pass.

---

## What Derek needs to do in Firebase (once)

**Re-publish the security rules.** `firestore.rules` now also covers
`households`, `households/*/summaries`, and `inviteCodes`. Same steps as before:
Firebase console → **Firestore Database → Rules** → select-all → paste the current
`firestore.rules` from the repo → **Publish**.

> Sign-up (Email/Password *account creation*) is **not** needed for this test —
> Kelly and Derek already have accounts. It's only needed later when brand-new
> people (Beta) create their own accounts.

---

## 2-device / 2-account test script

Do this with **Derek on his phone** and **Kelly on hers** (each signed into their
own account), after the rules are published and both apps show **Version ≥ 125**.

1. **Derek → create.** Settings → **👫 Household** → **Create a household**.
   - A **6-character code** appears, and a "Together, left to spend" card showing
     just Derek's numbers so far.
2. **Share the code.** Tap **Share invite link** (or just read Derek the code).
3. **Kelly → join.** On Kelly's phone: Settings → **👫 Household** → type the code
   → **Join with code**. (Or open Derek's `?join=` link and tap the toast.)
4. **Verify together (both phones):**
   - Both should now list **two people** (Derek + Kelly, "you" marked on each).
   - The **Together** total = Derek's left + Kelly's left. Give it a few seconds;
     summaries publish ~1s after any change.
5. **Live update:** Kelly logs a spend → within a few seconds Derek's Together
   total drops by that amount (and vice-versa).
6. **Leave:** either taps **Leave household** → they drop off the other's view.

### If something fails
- **Join says "code didn't match"** → the code was mistyped, or the rules aren't
  published yet.
- **"Couldn't join — it may be full"** → the household already has 2 members, or a
  rules issue. Send me the exact error and I'll adjust the rule.
- **Together shows only one person** → the other's summary hasn't published yet
  (log a spend or reopen the app), or a `summaries` rule issue.
- **Nothing happens on Create** → check the browser console for a Firestore
  `permission-denied`; that means the household rules didn't publish. Paste me the
  message.

Anything that breaks is almost always a rules detail — send me the console error
and I'll fix `firestore.rules` for a quick re-publish.

---

## Known limitations (this slice)
- **Two people max** per household (by design).
- **No admin rename / remove-member UI yet** — either person can **Leave**;
  full admin controls come in the second pass.
- **No public sign-up yet** — existing accounts only.
- Summaries refresh on a ~1s debounce, not instantly.
