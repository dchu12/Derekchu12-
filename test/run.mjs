/* Yosan test harness.
 *
 * Loads the built app in jsdom and exercises the pure logic helpers exposed on
 * window.__yosanTest (money math, date math, the quick-add parser, and the
 * concurrency-sensitive merge logic). No browser, no network.
 *
 *   npm test            # after `npm install` (jsdom is a devDependency)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "..");

/* ---- tiny assert framework ------------------------------------------- */
let passed = 0;
const failures = [];
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${msg}\n    expected ${e}\n    got      ${a}`);
}
function ok(cond, msg) {
  if (cond) passed++;
  else failures.push(msg);
}

/* ---- load an app deployment in jsdom, return its __yosanTest ---------- */
function loadApp(dir) {
  const html = fs.readFileSync(path.join(repo, dir, "index.html"), "utf8");
  const appjs = fs.readFileSync(path.join(repo, dir, "app.js"), "utf8");
  let body = html
    .replace(/<script src="https:\/\/www.gstatic.com[^]*?<\/script>/g, "")
    .replace(/<script src="cloud.js[^]*?<\/script>/g, "")
    .replace(/<script src="app.js[^]*?<\/script>/g, "")
    .replace(/<script>\s*if \("serviceWorker"[^]*?<\/script>/g, "");
  body = body.replace(
    "</body>",
    `<script>${appjs.replace(/<\/script>/g, "<\\/script>")}</script></body>`
  );
  const dom = new JSDOM(body, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://example.com/" });
  const t = dom.window.__yosanTest;
  if (!t) throw new Error(`__yosanTest hook missing in ${dir || "root"}`);
  return t;
}

const T = loadApp("");
const cats = [
  { id: "food", name: "Groceries", budgeted: 500 },
  { id: "rent", name: "Rent", budgeted: 1200 },
];

/* ---- parseQuickAdd ---------------------------------------------------- */
eq(T.parseQuickAdd("38 ramen", cats).amount, 38, "quickadd: plain amount");
eq(T.parseQuickAdd("12.50 coffee", cats).amount, 12.5, "quickadd: decimal");
eq(T.parseQuickAdd("1,000 rent", cats).amount, 1000, "quickadd: thousands comma");
eq(T.parseQuickAdd("1,234.56 rent", cats).amount, 1234.56, "quickadd: grouped + decimal");
eq(T.parseQuickAdd("2,500", cats).amount, 2500, "quickadd: bare grouped");
eq(T.parseQuickAdd("120 groceries at loblaws", cats).categoryId, "food", "quickadd: category match");
eq(T.parseQuickAdd("120 groceries", cats).note, "", "quickadd: note stripped when only category word");
eq(T.parseQuickAdd("", cats).amount, null, "quickadd: empty → null amount");

/* ---- frequencyDays ---------------------------------------------------- */
eq(T.frequencyDays("weekly"), 7, "freq weekly");
eq(T.frequencyDays("biweekly"), 14, "freq biweekly");
eq(T.frequencyDays("semimonthly"), 15, "freq semimonthly");
eq(T.frequencyDays("monthly"), 30, "freq monthly");
eq(T.frequencyDays("nonsense"), 14, "freq default");

/* ---- periodEnd / daysLeft (deterministic via today's date) ----------- */
const todayISO = T.dateToISO(new Date());
const daysBetween = (a, b) => Math.round((b - a) / 86400000);
eq(daysBetween(T.parseDate(todayISO), T.periodEnd({ startDate: todayISO, frequency: "biweekly" })), 14, "periodEnd: biweekly = +14d");
eq(T.daysLeft({ startDate: todayISO, frequency: "biweekly" }), 14, "daysLeft: fresh biweekly = 14");
eq(T.daysLeft({ kind: "vacation", endDate: todayISO }), 1, "daysLeft: vacation ending today = 1 (inclusive)");
const past = T.dateToISO(new Date(Date.now() - 30 * 86400000));
eq(T.daysLeft({ startDate: past, frequency: "biweekly" }), 0, "daysLeft: long-past period clamps to 0");

/* ---- mergeTransactions (union / newest-edit-wins / tombstones) ------- */
{
  // newest edit wins
  const local = { transactions: [{ id: "a", amount: 10, editedAt: 1 }] };
  const remote = { transactions: [{ id: "a", amount: 99, editedAt: 5 }] };
  const m = T.mergeTransactions(local, remote);
  eq(m.transactions.find((t) => t.id === "a").amount, 99, "merge: newer remote edit wins");
}
{
  // union of distinct ids
  const local = { transactions: [{ id: "a", amount: 10, editedAt: 1 }] };
  const remote = { transactions: [{ id: "b", amount: 20, editedAt: 1 }] };
  const m = T.mergeTransactions(local, remote);
  eq(m.transactions.map((t) => t.id).sort(), ["a", "b"], "merge: union of distinct txns");
}
{
  // tombstone beats an older edit (stays deleted)
  const local = { transactions: [], deletedTxnIds: { a: 5 } };
  const remote = { transactions: [{ id: "a", amount: 10, editedAt: 3 }] };
  const m = T.mergeTransactions(local, remote);
  ok(!m.transactions.some((t) => t.id === "a"), "merge: tombstone (5) beats older edit (3)");
}
{
  // a newer edit beats an older tombstone (resurrects)
  const local = { transactions: [], deletedTxnIds: { a: 5 } };
  const remote = { transactions: [{ id: "a", amount: 10, editedAt: 9 }] };
  const m = T.mergeTransactions(local, remote);
  ok(m.transactions.some((t) => t.id === "a"), "merge: newer edit (9) beats tombstone (5)");
}

/* ---- mergePeriods (union periods + per-period txn merge) -------------- */
{
  const local = { periods: [
    { id: "p1", createdAt: "2026-01", transactions: [{ id: "x", amount: 1, editedAt: 2 }] },
    { id: "p2", createdAt: "2026-02", transactions: [{ id: "y", amount: 2, editedAt: 1 }] },
  ] };
  const merged = { periods: [
    { id: "p1", createdAt: "2026-01", transactions: [{ id: "z", amount: 3, editedAt: 1 }] },
  ] };
  T.mergePeriods(local, merged);
  const p1 = merged.periods.find((p) => p.id === "p1");
  eq(p1.transactions.map((t) => t.id).sort(), ["x", "z"], "mergePeriods: p1 txns unioned");
  ok(merged.periods.some((p) => p.id === "p2"), "mergePeriods: local-only period p2 kept");
}

/* ---- computeResults (monthly aggregation) ---------------------------- */
{
  T.setState(Object.assign(T.defaultState(), {
    periods: [
      { id: "p1", startDate: "2026-03-01", kind: "payday", paycheckAmount: 2000, extraIncome: [],
        categories: [{ id: "c1", name: "Food", budgeted: 500 }],
        transactions: [{ categoryId: "c1", amount: 300 }] },
      { id: "p2", startDate: "2026-03-15", kind: "payday", paycheckAmount: 2000, extraIncome: [{ amount: 100 }],
        categories: [{ id: "c2", name: "Food", budgeted: 500 }],
        transactions: [{ categoryId: "c2", amount: 200 }] },
    ],
  }));
  const r = T.computeResults("payday");
  const march = r.months.find((m) => m.month === "2026-03");
  eq(march.income, 4100, "computeResults: march income summed");
  eq(march.spent, 500, "computeResults: march spent summed");
  eq(march.saved, 3600, "computeResults: march saved = income - spent");
}

/* ---- fmt (USD, 2 decimals, grouped) ---------------------------------- */
eq(T.fmt(50), "$50.00", "fmt: small integer");
eq(T.fmt(-50), "-$50.00", "fmt: negative");
eq(T.fmt(0), "$0.00", "fmt: zero");
eq(T.fmt(1234.5), "$1,234.50", "fmt: thousands grouped");

/* ---- savings counts as saved, not spent ------------------------------ */
{
  const p = {
    startDate: "2026-07-01", paycheckAmount: 2600, extraIncome: [],
    categories: [
      { id: "rent", name: "Rent", budgeted: 1200, fixed: true },
      { id: "food", name: "Groceries", budgeted: 500 },
      { id: "sav", name: "Savings", budgeted: 500 },
    ],
    transactions: [
      { categoryId: "rent", amount: 1200 },
      { categoryId: "food", amount: 400 },
      { categoryId: "sav", amount: 500 }, // transfer into savings
    ],
  };
  eq(T.periodConsumed(p), 1600, "consumed excludes the savings transfer (1200+400)");
  eq(T.periodSaved(p), 1000, "saved = income - consumed = 2600 - 1600 (savings counts as saved)");
  const r = T.saveRateSeries([p]);
  eq(Math.round(r[0].rate * 100), 38, "save rate positive (1000/2600) — savings no longer sinks it");
}

/* ---- Treat Fund (under-budget rewards) -------------------------------- */
{
  const p = {
    startDate: "2026-07-01", paycheckAmount: 2600, extraIncome: [],
    categories: [
      { id: "rent", name: "Rent", budgeted: 1200, fixed: true }, // fixed — excluded
      { id: "food", name: "Groceries", budgeted: 500 },          // spent 400 → 100 under
      { id: "fun", name: "Fun", budgeted: 300 },                 // spent 300 → 0 under
      { id: "sav", name: "Savings", budgeted: 200 },             // savings — excluded
      { id: "treat", name: "Treat Yourself", budgeted: 50, treat: true }, // treat — excluded
    ],
    transactions: [
      { categoryId: "rent", amount: 1200 },
      { categoryId: "food", amount: 400 },
      { categoryId: "fun", amount: 300 },
      { categoryId: "sav", amount: 200 },
      { categoryId: "treat", amount: 0 },
    ],
  };
  eq(T.underBudgetAmount(p), 100, "under-budget = discretionary leftover only (food 100), excludes fixed/savings/treat");
  // rate defaults to 0.5 unless state overrides it
  T.setState(Object.assign(T.defaultState(), { treat: { balance: 0, earnedTotal: 0, spentTotal: 0, rate: 0.5, enabled: true } }));
  eq(T.treatEarnedFor(p), 50, "treat earned = 50% of $100 under budget = $50");
  T.setState(Object.assign(T.defaultState(), { treat: { balance: 0, earnedTotal: 0, spentTotal: 0, rate: 0.25, enabled: true } }));
  eq(T.treatEarnedFor(p), 25, "treat earned honors 25% rate");
  // overspending overall → no reward
  const over = { ...p, transactions: [{ categoryId: "food", amount: 700 }, { categoryId: "fun", amount: 300 }] };
  eq(T.treatEarnedFor(over), 0, "no treat when overspent (base negative)");
}

/* ---- safe to spend today never exceeds left to spend ----------------- */
{
  // Shopping overspent by 111.94; a naive per-category clamp would inflate the
  // number above what's actually left. Left to spend = 500+320 - (385.17+431.94)
  // = 2.89; over 1 day-left that's the whole thing, never more.
  const p = {
    startDate: "2026-07-01", frequency: "biweekly", paycheckAmount: 2600, extraIncome: [],
    categories: [
      { id: "food", name: "Food", budgeted: 500 },
      { id: "shop", name: "Shopping", budgeted: 320 },
    ],
    transactions: [
      { categoryId: "food", amount: 385.17 },
      { categoryId: "shop", amount: 431.94 }, // over by 111.94
    ],
  };
  const left = 820 - 817.11; // 2.89
  eq(Math.round(T.safeToSpendPool(p) * 100) / 100, 2.89, "safe pool = left to spend, nets overspend (not clamped per-cat)");
  ok(T.safeToSpendPool(p) <= left + 0.005, "safe pool never exceeds left to spend");
  // 65.02 left over 3 days = 21.67/day (the reported case)
  const p2 = { startDate: "2026-07-01", frequency: "biweekly", paycheckAmount: 2600, extraIncome: [],
    categories: [{ id: "a", name: "A", budgeted: 100 }], transactions: [{ categoryId: "a", amount: 34.98 }] };
  eq(Math.round((65.02 / 3) * 100) / 100, 21.67, "65.02 left / 3 days = 21.67 (sanity)");
  ok(T.safeToSpendPool(p2) <= (100 - 34.98) + 0.005, "safe pool <= left to spend (p2)");
}

/* ---- auto-trim: overspend shrinks other categories' shown "left" ----- */
{
  // Food 114.83 under, Shopping 111.94 over, Misc 62.13 over → over 174.07,
  // under 114.83 → factor 0 (fully wiped: you've overspent more than is left
  // in the under categories). Food's shown "left" trims toward 0.
  const p = {
    categories: [
      { id: "food", name: "Food", budgeted: 500 },
      { id: "shop", name: "Shopping", budgeted: 320 },
      { id: "misc", name: "Misc", budgeted: 200 },
      { id: "rent", name: "Rent", budgeted: 1200, fixed: true }, // ignored
    ],
    transactions: [
      { categoryId: "food", amount: 385.17 },
      { categoryId: "shop", amount: 431.94 },
      { categoryId: "misc", amount: 262.13 },
    ],
  };
  const t = T.discTrim(p);
  eq(Math.round(t.over * 100) / 100, 174.07, "trim: total overspend across discretionary");
  eq(Math.round(t.under * 100) / 100, 114.83, "trim: total still-under across discretionary");
  eq(t.factor, 0, "trim factor 0 when overspend exceeds what's left under");
  ok(t.active, "trim active when overspending");
  // Mild overspend: Food 200 under, Shopping 50 over → factor 0.75; Food shows 150.
  const p2 = { categories: [{ id: "f", name: "Food", budgeted: 500 }, { id: "s", name: "Shop", budgeted: 100 }],
    transactions: [{ categoryId: "f", amount: 300 }, { categoryId: "s", amount: 150 }] };
  const t2 = T.discTrim(p2);
  eq(t2.factor, 0.75, "trim factor = 1 - over/under (50/200)");
  eq(Math.round(200 * t2.factor), 150, "Food's $200 left trims to $150");
  // No overspend → factor 1, inactive.
  const p3 = { categories: [{ id: "f", name: "Food", budgeted: 500 }], transactions: [{ categoryId: "f", amount: 100 }] };
  ok(!T.discTrim(p3).active && T.discTrim(p3).factor === 1, "no trim when nothing overspent");
}

/* ---- household invite code format ------------------------------------ */
{
  const codes = Array.from({ length: 50 }, () => T.genInviteCode());
  ok(codes.every((c) => /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(c)), "invite code: 8 unambiguous chars");
}

/* ---- reminders (payday / ending-soon / near-limit + schedule) -------- */
{
  const dISO = (n) => T.dateToISO(new Date(Date.now() + n * 86400000));
  const base = { frequency: "biweekly", kind: "payday", closed: false, transactions: [] };
  const p0 = { ...base, id: "pp", startDate: dISO(-14), categories: [{ id: "a", name: "Food", budgeted: 100 }] };
  ok(T.remindersFor(p0).some((r) => r.tag === "payday-pp"), "reminder: payday fires when period ended (dl 0)");
  const p1 = { ...p0, id: "p1", startDate: dISO(-12) };
  ok(T.remindersFor(p1).some((r) => r.tag === "ending-p1"), "reminder: ending-soon fires at 2 days left");
  const p2 = { ...base, id: "p2", startDate: dISO(-1), categories: [{ id: "c", name: "Coffee", budgeted: 100 }], transactions: [{ categoryId: "c", amount: 95 }] };
  ok(T.remindersFor(p2).some((r) => r.tag === "limit-p2-c"), "reminder: near-limit fires at 95%");
  eq(T.remindersFor({ ...p0, closed: true }).length, 0, "reminder: none for a closed period");
  const sch = T.reminderSchedule({ ...base, id: "p3", startDate: dISO(0), categories: [] });
  eq(sch.find((x) => x.tag === "payday-p3").fireOn, dISO(14), "schedule: payday fires on the pay date (+14)");
  eq(sch.find((x) => x.tag === "ending-p3").fireOn, dISO(12), "schedule: ending fires 2 days before");
}

/* ---- saveRateSeries (Reports save-rate trend) ------------------------ */
{
  const series = T.saveRateSeries([
    { startDate: "2026-01-01", paycheckAmount: 2000, extraIncome: [], categories: [], transactions: [{ amount: 500 }] },
    { startDate: "2026-02-01", paycheckAmount: 1000, extraIncome: [], categories: [], transactions: [{ amount: 1000 }] },
    { startDate: "2026-03-01", paycheckAmount: 0, extraIncome: [], categories: [], transactions: [] },
  ]);
  eq(series.length, 3, "saverate: length");
  eq(series[0].rate, 0.75, "saverate: (2000-500)/2000 = 0.75");
  eq(series[1].rate, 0, "saverate: broke even → 0");
  eq(series[2].rate, 0, "saverate: zero income guarded to 0");
}

/* ---- transactionsCSV (header, ordering, escaping) -------------------- */
{
  const st = {
    periods: [
      { id: "p1", startDate: "2026-03-01", kind: "payday",
        categories: [{ id: "c1", emoji: "🍜", name: "Food", fixed: false }, { id: "c2", name: "Rent, etc", fixed: true }],
        transactions: [
          { categoryId: "c1", amount: 12.5, date: "2026-03-03", description: 'Ramen "special"' },
          { categoryId: "c2", amount: 1200, date: "2026-03-01", description: "" },
        ] },
    ],
  };
  const { csv, count } = T.transactionsCSV(st);
  const lines = csv.split("\r\n");
  eq(count, 2, "csv: transaction count");
  eq(lines[0], "Date,Category,Amount,Note,Period start,Budget type,Fixed bill", "csv: header row");
  ok(lines[1].startsWith("2026-03-01,"), "csv: rows sorted by date (rent first)");
  ok(lines[2].includes("🍜 Food"), "csv: category name with emoji");
  ok(lines[2].includes('"Ramen ""special"""'), "csv: quotes escaped");
  ok(lines[1].includes('"Rent, etc"'), "csv: comma field quoted");
  eq(T.transactionsCSV({ periods: [] }).count, 0, "csv: empty → count 0");
}

/* ---- report ----------------------------------------------------------- */
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log("All tests passed ✓");
