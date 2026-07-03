# 💸 Payday Budget

A dead-simple budgeting app built around one idea: **set your budget once, every time you get paid.**

When a paycheck lands, you tell the app how much you were paid and split it across
categories (rent, groceries, fun, savings…). Then you just log spending as you go and
watch how much is left until your next paycheck. When you get paid again, you start a
fresh pay period — the old one is saved to your history.

## Features

- **Pay-period budgeting** — budget a whole paycheck at once, not a calendar month.
- **Envelope-style categories** — split every dollar; each category shows spent / budgeted / remaining.
- **"Left to spend" at a glance** — a running total plus a per-day pace for the days left in the period.
- **Quick spend logging** — one tap to record a purchase against a category.
- **History** — every closed pay period is saved so you can see whether you came in over or under.
- **Remembers your layout** — next payday pre-fills your last set of categories, so setup takes seconds.
- **Private & offline** — all data lives in your browser's `localStorage`. No account, no server, nothing leaves your device.
- **Installable** — add it to your phone's home screen (it's a PWA).

## Running it

No build step, no dependencies. Just open the app:

```bash
# Option 1: open the file directly
open index.html

# Option 2: serve it locally (recommended so the manifest/PWA works)
python3 -m http.server 8000
# then visit http://localhost:8000
```

## How to use

1. **Enter your paycheck** amount, the pay date, and how often you're paid.
2. **Split it into a budget** — assign an amount to each category until every dollar has a job.
3. **Tap "Log spend"** whenever you buy something and pick the category.
4. Check the **Overview** anytime to see what's left and your daily pace.
5. **Got paid again?** Tap "Start a new pay period" — this period is archived to History and you set up the next one.

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell and tab layout |
| `styles.css` | Styling (light + dark mode) |
| `app.js` | All app logic and state (vanilla JS, no framework) |
| `manifest.json` | PWA metadata for home-screen install |

Your data is stored under the `payday-budget-v1` key in `localStorage`.
