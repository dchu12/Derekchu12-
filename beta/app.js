/* Payday Budget — set your budget once each time you're paid.
 * Pure vanilla JS. State persists in localStorage. No backend. */

(function () {
  "use strict";

  const STORAGE_KEY = "payday-budget-beta-v1";

  /* Beta playground: the "Email report" button opens a blank-recipient draft
   * so testers can send it wherever they like. */
  const REPORT_EMAILS = [];

  /* Bump on each release so you can confirm the live version in Settings. */
  const APP_VERSION = "91";

  /* Beta build is local-only (no Firebase sign-in), so these are inert. */
  const BUDGET_KEY = "beta";
  const PERSON_NAME = "You";
  const PARTNER_NAME = "Partner";

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  const defaultState = () => ({
    periods: [],          // list of budgets, newest last (kind: "payday" | "vacation")
    template: null,       // remembered category layout for the next payday
    vacationTemplate: null, // remembered category layout for the next vacation
    goals: [],            // savings goals/jars: { id, emoji, name, target, saved }
    fixedCollapsed: false, // whether the Fixed bills section is collapsed
    vacationMode: false,  // when on, a vacation budget can run alongside the pay period
    activeBudget: "payday", // which budget the top switcher is showing: "payday" | "vacation"
    view: "dashboard",
  });

  /* Default categories offered when planning a vacation budget. */
  const VACATION_CATEGORIES = [
    { emoji: "✈️", name: "Flights", budgeted: "", fixed: true },
    { emoji: "🏨", name: "Lodging", budgeted: "", fixed: true },
    { emoji: "🍽️", name: "Food & Dining", budgeted: "" },
    { emoji: "🎟️", name: "Activities", budgeted: "" },
    { emoji: "🚕", name: "Local Transport", budgeted: "" },
    { emoji: "🛍️", name: "Shopping", budgeted: "" },
    { emoji: "🎁", name: "Souvenirs", budgeted: "" },
    { emoji: "📦", name: "Miscellaneous", budgeted: "" },
  ];

  // Migrate older shapes forward (single `goal` → `goals` array).
  // Uses an inline id (runs during initial load, before `uid` is initialized).
  function migrateState(s) {
    const gid = () => "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    if (s.goal && (!Array.isArray(s.goals) || !s.goals.length)) {
      s.goals = [{ id: gid(), emoji: "🎯", name: s.goal.name || "Savings goal", target: Number(s.goal.target) || 0, saved: 0 }];
    }
    delete s.goal;
    if (!Array.isArray(s.goals)) s.goals = [];
    return s;
  }

  let state = load();

  // Cloud sync (Firebase) — entirely optional. The app is fully usable signed out.
  let cloudUser = null;   // current Firebase user, or null
  let cloudUnsub = null;  // realtime budget listener unsubscribe
  let pushTimer = null;   // debounce handle for cloud writes
  let firstAuth = true;   // so we only show the first-visit sign-in prompt once
  let resultsUnsub = [];  // realtime results listeners (both people)
  const resultsCache = { kelly: null, derek: null }; // latest results docs
  let resultsSeeded = false; // publish our results summary once after first sync
  // Data-safety banner: stays dismissed for 30 days once closed (persisted), so it doesn't nag.
  let bannerDismissed =
    Date.now() - Number(localStorage.getItem(STORAGE_KEY + "-banner-dismissed") || 0) < 30 * 86400000;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const st = migrateState(Object.assign(defaultState(), parsed));
      st.view = "dashboard"; // always land on Overview after a refresh
      return st;
    } catch (e) {
      console.warn("Failed to load state, starting fresh.", e);
      return defaultState();
    }
  }

  // Write to localStorage without touching the sync timestamp (used when
  // adopting a remote change, so it doesn't bounce straight back to the cloud).
  function persistLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error("Failed to save state", e);
    }
  }

  function save() {
    state.updatedAt = Date.now();
    persistLocal();
    schedulePush();
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */
  const uid = () =>
    Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const fmt = (n) => {
    const v = Number(n || 0);
    const body =
      "$" +
      Math.abs(v).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    return v < 0 ? "-" + body : body;
  };

  // Compact money for tight spots like chart labels: $1.9k, $355, -$50.
  const fmtCompact = (n) => {
    const v = Number(n || 0);
    const a = Math.abs(v);
    const s = a >= 1000 ? "$" + (a / 1000).toFixed(a >= 10000 ? 0 : 1) + "k" : "$" + Math.round(a);
    return (v < 0 ? "-" : "") + s;
  };

  const fmtShort = (n) => {
    const v = Number(n || 0);
    return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  };

  const todayISO = () => new Date().toISOString().slice(0, 10);

  // Format a Date object as a local YYYY-MM-DD (avoids UTC off-by-one).
  const dateToISO = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  function parseDate(iso) {
    // Treat ISO date as local, not UTC, to avoid off-by-one.
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function frequencyDays(freq) {
    return { weekly: 7, biweekly: 14, semimonthly: 15, monthly: 30 }[freq] || 14;
  }

  function periodEnd(period) {
    // Vacation budgets carry an explicit (inclusive) end date; return the
    // exclusive day-after so daysLeft / range labels line up with pay periods.
    if (period.endDate) {
      const end = parseDate(period.endDate);
      end.setDate(end.getDate() + 1);
      return end;
    }
    const start = parseDate(period.startDate);
    const end = new Date(start);
    end.setDate(end.getDate() + frequencyDays(period.frequency));
    return end;
  }

  const periodKind = (p) => (p && p.kind === "vacation" ? "vacation" : "payday");

  function daysLeft(period) {
    const end = periodEnd(period);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const ms = end - now;
    return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
  }

  // Most recent open (non-closed) budget of a given kind, or null.
  function activePeriodOf(kind) {
    for (let i = state.periods.length - 1; i >= 0; i--) {
      const p = state.periods[i];
      if (!p.closed && periodKind(p) === kind) return p;
    }
    return null;
  }
  // The budget currently shown by the top switcher (defaults to the pay period).
  function activePeriod() {
    const which = state.activeBudget === "vacation" ? "vacation" : "payday";
    return activePeriodOf(which);
  }
  const activeVacation = () => activePeriodOf("vacation");
  const activePayday = () => activePeriodOf("payday");

  function catSpent(period, catId) {
    return period.transactions
      .filter((t) => t.categoryId === catId)
      .reduce((s, t) => s + Number(t.amount), 0);
  }

  const totalBudgeted = (p) => p.categories.reduce((s, c) => s + Number(c.budgeted), 0);
  const totalSpent = (p) => p.transactions.reduce((s, t) => s + Number(t.amount), 0);
  // Total income for a period: the paycheck plus any extra income logged.
  const periodIncome = (p) =>
    Number(p.paycheckAmount || 0) + (p.extraIncome || []).reduce((s, i) => s + Number(i.amount || 0), 0);

  // Short label for the current pay period's date range, e.g. "Jul 1 – Jul 14".
  const fmtShortDate = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  function periodRangeLabel(p) {
    const s = parseDate(p.startDate);
    const last = periodEnd(p); // next paycheck date
    last.setDate(last.getDate() - 1); // inclusive last day of this period
    return `${fmtShortDate(s)} – ${fmtShortDate(last)}`;
  }

  /* ------------------------------------------------------------------ *
   * Concurrent-edit safety: merge transactions by id (union, newest-edit
   * wins) with tombstones for deletes, so simultaneous logging by two
   * people never drops a transaction.
   * ------------------------------------------------------------------ */

  // Delete a transaction and record a tombstone so it doesn't resurrect on merge.
  function deleteTxn(p, txnId) {
    const idx = p.transactions.findIndex((t) => t.id === txnId);
    if (idx === -1) return null;
    const [removed] = p.transactions.splice(idx, 1);
    if (!p.deletedTxnIds) p.deletedTxnIds = {};
    p.deletedTxnIds[txnId] = Date.now();
    return { removed, idx };
  }

  // Restore a tombstoned transaction (Undo). Bump editedAt so it beats the tombstone on merge.
  function restoreTxn(p, txnObj, idx) {
    if (p.deletedTxnIds) delete p.deletedTxnIds[txnObj.id];
    txnObj.editedAt = Date.now();
    p.transactions.splice(Math.min(idx, p.transactions.length), 0, txnObj);
  }

  // Merge one period's transactions from a local and a remote copy.
  function mergeTransactions(localP, remoteP) {
    const tomb = {};
    const addTomb = (m) => {
      if (m) for (const k in m) tomb[k] = Math.max(tomb[k] || 0, m[k]);
    };
    addTomb(localP && localP.deletedTxnIds);
    addTomb(remoteP && remoteP.deletedTxnIds);
    const byId = {};
    const consider = (t) => {
      if (!t || !t.id) return;
      const ex = byId[t.id];
      if (!ex || (t.editedAt || 0) >= (ex.editedAt || 0)) byId[t.id] = t;
    };
    (remoteP && remoteP.transactions ? remoteP.transactions : []).forEach(consider);
    (localP && localP.transactions ? localP.transactions : []).forEach(consider);
    const live = Object.keys(byId)
      .map((k) => byId[k])
      .filter((t) => !(tomb[t.id] != null && tomb[t.id] >= (t.editedAt || 0)));
    return { transactions: live, deletedTxnIds: tomb };
  }

  // Merge periods between a local state and an incoming (remote) state, in place on `merged`.
  function mergePeriods(local, merged) {
    const localById = {};
    (local.periods || []).forEach((p) => (localById[p.id] = p));
    const seen = {};
    (merged.periods || []).forEach((rp) => {
      seen[rp.id] = true;
      const lp = localById[rp.id];
      if (lp) {
        const m = mergeTransactions(lp, rp);
        rp.transactions = m.transactions;
        rp.deletedTxnIds = m.deletedTxnIds;
      }
    });
    // Keep periods created locally that the remote copy hasn't seen yet.
    (local.periods || []).forEach((lp) => {
      if (!seen[lp.id]) merged.periods.push(lp);
    });
    merged.periods.sort((a, b) =>
      String(a.createdAt || a.startDate || "").localeCompare(String(b.createdAt || b.startDate || ""))
    );
  }

  // Month-by-month summary for the shared Results view (published to Firestore).
  function computeResults() {
    const months = {};
    state.periods.forEach((p) => {
      const mk = (p.startDate || "").slice(0, 7); // YYYY-MM
      if (!mk) return;
      const m = months[mk] || (months[mk] = { income: 0, budgeted: 0, spent: 0, cats: {} });
      m.income += periodIncome(p);
      m.budgeted += totalBudgeted(p);
      m.spent += totalSpent(p);
      p.categories.forEach((c) => {
        const cc = m.cats[c.name] || (m.cats[c.name] = { emoji: c.emoji || "", budgeted: 0, spent: 0 });
        cc.budgeted += Number(c.budgeted || 0);
        cc.spent += catSpent(p, c.id);
      });
    });
    const list = Object.keys(months)
      .sort()
      .reverse()
      .map((mk) => {
        const m = months[mk];
        return {
          month: mk,
          income: m.income,
          budgeted: m.budgeted,
          spent: m.spent,
          saved: m.income - m.spent,
          categories: Object.keys(m.cats).map((n) => ({
            name: n,
            emoji: m.cats[n].emoji,
            budgeted: m.cats[n].budgeted,
            spent: m.cats[n].spent,
          })),
        };
      });
    return { name: PERSON_NAME, updatedAt: Date.now(), months: list };
  }
  // Actual money saved in a period = income minus everything spent.
  const periodSaved = (p) => periodIncome(p) - totalSpent(p);
  // Cumulative savings across all closed (finished) periods.
  const totalSavedToDate = () =>
    state.periods.filter((p) => p.closed).reduce((s, p) => s + periodSaved(p), 0);

  // A savings/goal category (e.g. "Savings", "Emergency fund") is money set aside
  // on purpose — funding it fully is a win, not overspending, so the coach never scolds it.
  function isSavingsCat(c) {
    return /sav(e|ing)|emergency|nest\s*egg|rainy\s*day|invest/i.test(c.name || "");
  }

  // Set of category ids currently spent over their (non-zero) budget.
  function overBudgetIds(p) {
    return new Set(
      p.categories
        .filter((c) => c.budgeted > 0 && !isSavingsCat(c) && catSpent(p, c.id) > c.budgeted + 0.005)
        .map((c) => c.id)
    );
  }

  // Discretionary categories in the 85%–under-100% "getting close" zone (still money left, not over).
  function closeIds(p) {
    return new Set(
      p.categories
        .filter((c) => {
          if (c.fixed || isSavingsCat(c) || !(c.budgeted > 0)) return false;
          const cs = catSpent(p, c.id);
          return cs >= c.budgeted * 0.85 && cs < c.budgeted - 0.005;
        })
        .map((c) => c.id)
    );
  }

  /* Pick a fresh on-track line each time (each open/action), avoiding an
   * immediate repeat so it always feels new. */
  let _recentCoach = [];
  function rotateLine(lines) {
    if (!lines.length) return "";
    if (lines.length === 1) return lines[0];
    // Avoid the last several quotes (tracked by text) so they don't repeat soon.
    const keep = Math.min(lines.length - 1, 10);
    const pool = lines.filter((l) => !_recentCoach.includes(l));
    const choices = pool.length ? pool : lines;
    const pick = choices[Math.floor(Math.random() * choices.length)];
    _recentCoach.push(pick);
    while (_recentCoach.length > keep) _recentCoach.shift();
    return pick;
  }

  /* A friendly coach line for the dashboard, based on how the period's going. */
  function coachMessage(p) {
    // Coach only on discretionary spending — fixed bills auto-fill to 100%, and
    // savings/goal categories are wins rather than overspending.
    const cats = p.categories.filter((c) => c.budgeted > 0 && !c.fixed && !isSavingsCat(c));
    const over = cats.filter((c) => catSpent(p, c.id) > c.budgeted + 0.005);
    if (over.length) {
      const names = over.map((c) => c.name).join(", ");
      return {
        tone: "over",
        text: `🧭 You've slipped a little over on ${names}. No stress — ease up there or trim another category to balance it out.`,
      };
    }

    // Timing for burn-rate projections (how far through the period are we?).
    const dl = daysLeft(p);
    const totalDays = Math.max(1, Math.round((periodEnd(p) - parseDate(p.startDate)) / 86400000));
    const elapsed = Math.min(totalDays, Math.max(0, totalDays - dl));
    const timeFrac = elapsed / totalDays;

    // Predictive: a category not yet over, but on pace to blow its budget before payday.
    if (dl > 0 && elapsed >= 2 && timeFrac > 0) {
      const risky = cats
        .map((c) => {
          const cs = catSpent(p, c.id);
          return { c, cs, projected: cs / timeFrac };
        })
        .filter((x) => x.cs > 0 && x.cs < x.c.budgeted - 0.005 && x.projected > x.c.budgeted * 1.12)
        .sort((a, b) => b.projected / b.c.budgeted - a.projected / a.c.budgeted);
      if (risky.length) {
        const r = risky[0];
        const dailyRate = r.cs / elapsed;
        const daysToEmpty = dailyRate > 0 ? Math.max(1, Math.floor((r.c.budgeted - r.cs) / dailyRate)) : dl;
        return {
          tone: "close",
          text: `📈 At this pace, ${r.c.name} runs out in about ${daysToEmpty} ${daysToEmpty === 1 ? "day" : "days"} — before your next paycheck. Easing off a little keeps it in the green.`,
        };
      }
    }
    const close = cats
      .filter((c) => {
        const cs = catSpent(p, c.id);
        return cs >= c.budgeted * 0.85 && cs < c.budgeted - 0.005;
      })
      .sort((a, b) => catSpent(p, b.id) / b.budgeted - catSpent(p, a.id) / a.budgeted);
    if (close.length) {
      const c = close[0];
      const left = c.budgeted - catSpent(p, c.id);
      const pct = Math.round((catSpent(p, c.id) / c.budgeted) * 100);
      return {
        tone: "close",
        text: `👀 ${c.name} is getting close — ${fmt(left)} left (${pct}%). Ease off here and you'll finish strong.`,
      };
    }
    // On track — mix warm encouragement with wisdom from The Psychology of Money
    // and The Art of Spending Money (both by Morgan Housel).
    const lines = [
      // Warm, on-track encouragements
      "💙 You're right on track — lovely work. Keep it up!",
      "🌊 Looking good — plenty of comfortable room left this period.",
      "🎯 Bang on budget. This is exactly what winning looks like.",
      "🍃 Calm and steady — your budget's breathing easy this period.",
      "⛵ Smooth sailing. You're gliding through this one with room to spare.",
      "🌿 Nothing to fix here. You're quietly nailing it.",
      "🧊 Cool, calm, and under budget. Love to see it.",
      "🌤️ Clear skies on the budget — keep doing what you're doing.",
      "💪 Steady hands, steady budget. You've got this handled.",
      "🎈 Light and breezy — you've left yourself lots of wiggle room.",
      "🌟 Every mindful choice this period is adding up. Nicely done.",
      "🧘 Budget's in a good place. Breathe easy and carry on.",
      "🚀 On pace and in control — future-you is going to be thankful.",
      "🌻 Growing your savings one calm decision at a time. Beautiful.",
      "🏆 Give yourself a nod — you're spending with real intention.",
      "🪷 Unbothered budget, moisturized savings. Thriving.",
      "🔥 You're on a roll — same energy for the rest of the period.",
      "🍀 Right where you want to be. Keep the momentum going.",
      // General money wisdom
      "🌱 A budget isn't about spending less — it's about spending on what matters. You're doing that.",
      "💡 Small, boring, consistent choices are what quietly build wealth. Keep going.",
      "🧭 Every dollar you give a job is a dollar that stops wandering off. Nice work.",
      "⏳ Patience with money is a quiet superpower — and you're flexing it right now.",
      "🪴 Wealth grows in the quiet: no drama, just steady saving. That's you this period.",
      "🔑 Freedom is just savings you haven't spent yet — and you're building some.",
      "📈 Slow money is steady money. You're playing the long game well.",
      "🕰️ The best time to save was last payday; the second best is this one — and you're on it.",
      "🧩 Budgeting is choosing your regrets in advance — and you're choosing wisely.",
      "🌙 Money you don't spend tonight becomes options tomorrow. You're stacking options.",
      "⚖️ Spend on today, save for tomorrow — you've found the balance this period.",
      "🌰 Big oaks come from steadily planted acorns. Keep planting.",
      // The Psychology of Money (Morgan Housel)
      "✨ “Saving is the gap between your ego and your income.” You're minding that gap beautifully. — The Psychology of Money",
      "💰 “Wealth is what you don't see.” Every dollar you don't spend is quietly becoming your freedom. — The Psychology of Money",
      "🕊️ “Controlling your time is the highest dividend money pays.” Staying on budget buys more of it. — The Psychology of Money",
      "🌱 “Building wealth has little to do with your income and a lot to do with your savings rate.” You're doing the part that matters. — The Psychology of Money",
      "☕ “Spending money to show people how much money you have is the fastest way to have less.” Nice and steady wins. — The Psychology of Money",
      "🎩 “The ability to do what you want, when you want, is priceless.” Your budget is buying that. — The Psychology of Money",
      "🛡️ “Room for error is what lets you endure.” You're leaving yourself some — smart. — The Psychology of Money",
      "😌 “Enough” is knowing when to stop moving the goalposts. You seem to know yours. — The Psychology of Money",
      "🌰 Compounding rewards patience, not intensity. You're giving it time. — The Psychology of Money",
      // The Art of Spending Money (Morgan Housel)
      "🛍️ “Spending money is easy. Spending it well is a skill.” And you're getting good at it. — The Art of Spending Money",
      "👑 “The highest form of wealth is not caring what other people think about what you buy.” Spend on what you love. — The Art of Spending Money",
      "🧭 “The whole point of money is to give you independence and freedom.” Every mindful choice buys a little more. — The Art of Spending Money",
      "🎁 The best purchases buy better days, not just nicer things. You're spending with intention. — The Art of Spending Money",
      "🍷 Spending well means matching money to what you actually value. You're aligned this period. — The Art of Spending Money",
      "🌅 Money's real job is to improve how you feel about your days. Looks like it's doing its job. — The Art of Spending Money",
    ];
    // Celebrate any savings/goal category she's fully funded this period.
    const funded = p.categories.filter(
      (c) => c.budgeted > 0 && isSavingsCat(c) && catSpent(p, c.id) >= c.budgeted - 0.005
    );
    if (funded.length) {
      lines.unshift(
        `🎉 You've fully funded ${funded.map((c) => c.name).join(", ")} this period — future-you is grateful. Beautifully done!`
      );
    }
    // Every so often, surface a data-aware projection instead of a quote so the
    // coach feels like it's actually watching the numbers.
    if (dl > 0 && elapsed >= 3 && timeFrac > 0) {
      const projSaved = periodIncome(p) - totalSpent(p) / timeFrac;
      if (projSaved > 0.005 && Math.random() < 0.5) {
        return { tone: "ok", text: `📊 At your current pace, you're on track to save about ${fmt(projSaved)} this period — keep it up!` };
      }
    }
    return { tone: "ok", text: rotateLine(lines) };
  }

  const freqLabel = (f) =>
    ({ weekly: "Weekly", biweekly: "Every 2 weeks", semimonthly: "Twice a month", monthly: "Monthly" }[f] || f);

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  /* Default categories offered on first setup. */
  const STARTER_CATEGORIES = [
    { emoji: "🏠", name: "Rent", budgeted: "", fixed: true },
    { emoji: "📱", name: "Phone", budgeted: "", fixed: true },
    { emoji: "🌐", name: "Internet", budgeted: "", fixed: true },
    { emoji: "📺", name: "Streaming", budgeted: "", fixed: true },
    { emoji: "🏋️", name: "Gym", budgeted: "", fixed: true },
    { emoji: "🛒", name: "Groceries", budgeted: "" },
    { emoji: "🍽️", name: "Restaurants", budgeted: "" },
    { emoji: "🥡", name: "Take-Out", budgeted: "" },
    { emoji: "☕", name: "Coffee", budgeted: "" },
    { emoji: "⛽", name: "Gas", budgeted: "" },
    { emoji: "🚌", name: "Transit", budgeted: "" },
    { emoji: "🛍️", name: "Shopping", budgeted: "" },
    { emoji: "🎬", name: "Entertainment", budgeted: "" },
    { emoji: "📦", name: "Miscellaneous", budgeted: "" },
  ];

  /* Editable category row, shared by the setup and Manage editors.
   * `id` is the identity used by the surrounding editor (row id or key). */
  function catEditRow(r, id, opts) {
    opts = opts || {};
    const note = opts.note ? `<div class="mc-spent">${esc(opts.note)}</div>` : "";
    const label = r.name || "category";
    const grip = opts.drag
      ? `<button type="button" class="mc-drag" data-drag aria-label="Reorder ${esc(label)} — drag, or use arrow keys" title="Drag to reorder">⠿</button>`
      : "";
    return `
      <div class="cat-edit-row${opts.drag ? " has-drag" : ""}" data-row="${esc(id)}">
        <div class="alloc-item">
          ${grip}
          <input class="emoji-in" data-f="emoji" value="${esc(r.emoji)}" maxlength="2" aria-label="Emoji" />
          <input class="name-in" data-f="name" placeholder="Category" value="${esc(r.name)}" aria-label="Category name" />
          <div class="money-input amt-in">
            <input data-f="budgeted" type="number" inputmode="decimal" placeholder="0" step="0.01" value="${esc(r.budgeted)}" aria-label="Budget amount" />
          </div>
          <button type="button" class="rm" data-rm="${esc(id)}" title="Remove ${esc(label)}" aria-label="Remove ${esc(label)}">×</button>
        </div>
        <div class="cat-opts">
          <label class="opt-toggle" title="Auto-logged as spent each payday">
            <input type="checkbox" data-f="fixed" ${r.fixed ? "checked" : ""} /> Fixed bill
          </label>
          <label class="opt-toggle" title="Carry any leftover into next period">
            <input type="checkbox" data-f="rollover" ${r.rollover ? "checked" : ""} /> 🔄 Rollover
          </label>
        </div>
        ${note}
      </div>`;
  }

  /* Pointer + keyboard reordering for the category editors.
   * Drag a row's grip (works with touch and mouse), or focus it and press
   * ArrowUp/ArrowDown. `applyOrder` receives the new list of data-row keys,
   * top to bottom, so each editor can re-sort its own working array. */
  function enableRowDrag(listEl, applyOrder) {
    let dragEl = null;

    const syncOrder = () =>
      applyOrder(Array.from(listEl.querySelectorAll(".cat-edit-row")).map((el) => el.dataset.row));

    listEl.addEventListener("pointerdown", (e) => {
      const handle = e.target.closest("[data-drag]");
      if (!handle) return;
      const rowEl = handle.closest(".cat-edit-row");
      if (!rowEl) return;
      e.preventDefault();
      dragEl = rowEl;
      rowEl.classList.add("dragging");

      const move = (ev) => {
        if (!dragEl) return;
        ev.preventDefault();
        const y = ev.clientY;
        const others = Array.from(listEl.querySelectorAll(".cat-edit-row:not(.dragging)"));
        let ref = null;
        for (const el of others) {
          const box = el.getBoundingClientRect();
          if (y < box.top + box.height / 2) {
            ref = el;
            break;
          }
        }
        if (ref) listEl.insertBefore(dragEl, ref);
        else listEl.appendChild(dragEl);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        if (!dragEl) return;
        dragEl.classList.remove("dragging");
        dragEl = null;
        syncOrder();
      };
      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });

    listEl.addEventListener("keydown", (e) => {
      const handle = e.target.closest("[data-drag]");
      if (!handle || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      const rowEl = handle.closest(".cat-edit-row");
      if (!rowEl) return;
      e.preventDefault();
      if (e.key === "ArrowUp" && rowEl.previousElementSibling) {
        listEl.insertBefore(rowEl, rowEl.previousElementSibling);
      } else if (e.key === "ArrowDown" && rowEl.nextElementSibling) {
        listEl.insertBefore(rowEl.nextElementSibling, rowEl);
      }
      handle.focus();
      syncOrder();
    });
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */
  const main = document.getElementById("main");
  const modalRoot = document.getElementById("modal-root");

  /* ------------------------------------------------------------------ *
   * Modal + toast infrastructure (accessible: Escape, focus trap,
   * focus restore). Every modal in the app mounts through mountModal.
   * ------------------------------------------------------------------ */
  let _lastFocused = null;

  function mountModal(html) {
    _lastFocused = document.activeElement;
    modalRoot.innerHTML = html;
    const overlay = modalRoot.querySelector(".modal-overlay");
    const modal = modalRoot.querySelector(".modal");
    modal.setAttribute("tabindex", "-1");

    const focusable = () =>
      Array.from(
        modal.querySelectorAll(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);

    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Tab") {
        const f = focusable();
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    function close() {
      if (modalRoot.innerHTML === "") return;
      modalRoot.innerHTML = "";
      document.removeEventListener("keydown", onKey, true);
      if (_lastFocused && typeof _lastFocused.focus === "function") {
        try { _lastFocused.focus(); } catch (e) {}
      }
    }

    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    // Focus the first sensible control (or the dialog itself).
    setTimeout(() => {
      const first = modal.querySelector(
        "input:not([type=hidden]),select,textarea,button"
      );
      (first || modal).focus();
    }, 40);

    return { close, modal };
  }

  /* Lightweight toast with an optional action (used for Undo). */
  let _toastTimer = null;
  function showToast(message, actionLabel, actionFn) {
    let host = document.getElementById("toast-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "toast-host";
      document.body.appendChild(host);
    }
    host.innerHTML = `
      <div class="toast" role="status">
        <span>${esc(message)}</span>
        ${actionLabel ? `<button class="toast-action" type="button">${esc(actionLabel)}</button>` : ""}
      </div>`;
    const clear = () => { host.innerHTML = ""; };
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(clear, 5000);
    if (actionLabel && actionFn) {
      host.querySelector(".toast-action").addEventListener("click", () => {
        if (_toastTimer) clearTimeout(_toastTimer);
        clear();
        actionFn();
      });
    }
  }

  /* Show an inline validation message under a field (replaces alert()). */
  function showFieldError(inputEl, message) {
    clearFieldError(inputEl);
    inputEl.classList.add("input-invalid");
    inputEl.setAttribute("aria-invalid", "true");
    const err = document.createElement("div");
    err.className = "field-error";
    err.textContent = message;
    const container = inputEl.closest(".field") || inputEl.parentElement;
    container.appendChild(err);
    inputEl.focus();
  }
  function clearFieldError(inputEl) {
    inputEl.classList.remove("input-invalid");
    inputEl.removeAttribute("aria-invalid");
    const container = inputEl.closest(".field") || inputEl.parentElement;
    const err = container && container.querySelector(".field-error");
    if (err) err.remove();
  }

  function render() {
    // "History" and "Report" are now one combined "Reports" tab.
    if (state.view === "history") state.view = "report";
    // Vacation Mode off → the switcher is hidden, so never sit on the vacation view.
    if (!state.vacationMode && state.activeBudget === "vacation") state.activeBudget = "payday";

    // Sync tab highlight
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.view === state.view)
    );

    renderBudgetSwitch();

    const period = activePeriod();
    const onVacation = state.activeBudget === "vacation";

    // Header "Log spend" is available whenever the selected budget has an active period.
    const headerLog = document.getElementById("header-log");
    if (headerLog) headerLog.hidden = !period;
    const headerAdd = document.getElementById("header-add");
    if (headerAdd) headerAdd.hidden = !period;

    // Reports (history + export) and Results stay reachable even between paychecks (no active period).
    if (state.view === "report") return renderHistory();
    if (state.view === "results") return renderResults();

    if (!period) {
      // No active budget for the selected type — show the matching setup flow.
      if (onVacation) renderVacationSetup();
      else renderSetup();
      return;
    }

    if (state.view === "dashboard") renderDashboard(period);
    else if (state.view === "spend") renderSpend(period);
  }

  // Top switcher between the pay-period budget and the vacation budget.
  // Only shown when Vacation Mode is on.
  function renderBudgetSwitch() {
    const el = document.getElementById("budget-switch");
    if (!el) return;
    if (!state.vacationMode) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    const which = state.activeBudget === "vacation" ? "vacation" : "payday";
    el.innerHTML =
      `<button type="button" class="bud-btn ${which === "payday" ? "active" : ""}" data-bud="payday">💼 Pay Period</button>` +
      `<button type="button" class="bud-btn ${which === "vacation" ? "active" : ""}" data-bud="vacation">🏖️ Vacation</button>`;
  }

  /* ---------- Setup / new payday flow ---------- */
  function renderSetup() {
    const isFirst = state.periods.length === 0;
    const template = state.template || { frequency: "biweekly", categories: STARTER_CATEGORIES };

    main.innerHTML = `
      <div class="card">
        <h2>${isFirst ? "Welcome 👋" : "New payday 🎉"}</h2>
        <p class="sub">${
          isFirst
            ? "Set your budget once, right when you get paid. Enter your paycheck and split it into categories."
            : "You got paid again — set up this pay period's budget."
        }</p>

        <div class="field money-input">
          <label>How much did you get paid?</label>
          <input id="paycheck" type="number" inputmode="decimal" placeholder="0.00" step="0.01" />
        </div>

        <div class="field-row">
          <div class="field">
            <label>Pay date</label>
            <input id="startDate" type="date" value="${todayISO()}" />
          </div>
          <div class="field">
            <label>How often are you paid?</label>
            <select id="frequency">
              ${["weekly", "biweekly", "semimonthly", "monthly"]
                .map(
                  (f) =>
                    `<option value="${f}" ${f === template.frequency ? "selected" : ""}>${freqLabel(f)}</option>`
                )
                .join("")}
            </select>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>Split it into a budget</h2>
        <p class="sub">Budget what you plan to spend — whatever's left over is your savings.</p>
        <div id="alloc-list"></div>
        <button class="btn btn-ghost btn-sm" id="add-cat">+ Add category</button>

        <div class="alloc-summary">
          <span>Paycheck <b id="sum-paycheck">$0.00</b></span>
          <span>Savings <b class="remaining" id="sum-remaining">$0.00</b></span>
        </div>

        <button class="btn btn-primary btn-block" id="start-period">Start this pay period</button>
      </div>

      ${
        isFirst
          ? `<p class="footer-note">Everything is stored privately on this device.</p>`
          : `<p class="footer-note">Your last budget layout is pre-filled — tweak the amounts.</p>`
      }
    `;

    // Most recent (now-closed) period, used to roll leftovers into this one.
    const prevPeriod = state.periods.length ? state.periods[state.periods.length - 1] : null;

    // Working copy of allocation rows — with rollover added for opted-in categories.
    let rows = template.categories.map((c) => {
      const base = c.budgeted != null ? Number(c.budgeted) || 0 : 0;
      let rolled = 0;
      if (c.rollover && prevPeriod && prevPeriod.closed) {
        const pc = prevPeriod.categories.find((x) => x.name === c.name);
        if (pc) {
          const leftover = Number(pc.budgeted || 0) - catSpent(prevPeriod, pc.id);
          if (leftover > 0.005) rolled = leftover;
        }
      }
      const total = base + rolled;
      return {
        id: uid(),
        emoji: c.emoji || "💵",
        name: c.name || "",
        budgeted: total > 0 ? String(+total.toFixed(2)) : c.budgeted != null ? String(c.budgeted) : "",
        fixed: !!c.fixed,
        rollover: !!c.rollover,
        _rolled: rolled,
      };
    });

    const listEl = document.getElementById("alloc-list");
    const paycheckEl = document.getElementById("paycheck");

    function drawRows() {
      listEl.innerHTML = rows
        .map((r) =>
          catEditRow(r, r.id, {
            drag: true,
            note: r._rolled > 0 ? `🔄 +${fmt(r._rolled)} rolled over from last period` : "",
          })
        )
        .join("");
      updateSummary();
    }

    enableRowDrag(listEl, (order) => {
      rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    });

    function updateSummary() {
      const paycheck = Number(paycheckEl.value) || 0;
      const allocated = rows.reduce((s, r) => s + (Number(r.budgeted) || 0), 0);
      const remaining = paycheck - allocated;
      document.getElementById("sum-paycheck").textContent = fmt(paycheck);
      const remEl = document.getElementById("sum-remaining");
      remEl.textContent = fmt(remaining);
      remEl.className = "remaining " + (remaining < -0.005 ? "neg" : remaining > 0.005 ? "pos" : "");
    }

    listEl.addEventListener("input", (e) => {
      const item = e.target.closest(".cat-edit-row");
      if (!item) return;
      const row = rows.find((r) => r.id === item.dataset.row);
      if (!row) return;
      const f = e.target.dataset.f;
      row[f] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
      if (f === "budgeted") updateSummary();
    });

    listEl.addEventListener("click", (e) => {
      const rm = e.target.dataset.rm;
      if (!rm) return;
      rows = rows.filter((r) => r.id !== rm);
      drawRows();
    });

    document.getElementById("add-cat").addEventListener("click", () => {
      rows.push({ id: uid(), emoji: "💵", name: "", budgeted: "", fixed: false });
      drawRows();
      const last = listEl.querySelector(".cat-edit-row:last-child .name-in");
      if (last) last.focus();
    });

    paycheckEl.addEventListener("input", updateSummary);

    document.getElementById("start-period").addEventListener("click", () => {
      const paycheck = Number(paycheckEl.value);
      if (!paycheck || paycheck <= 0) {
        showFieldError(paycheckEl, "Enter the amount you were paid.");
        return;
      }
      const cats = rows
        .filter((r) => r.name.trim() && Number(r.budgeted) > 0)
        .map((r) => ({
          id: uid(),
          emoji: r.emoji.trim() || "💵",
          name: r.name.trim(),
          budgeted: Number(r.budgeted),
          fixed: !!r.fixed,
          rollover: !!r.rollover,
        }));
      if (cats.length === 0) {
        showToast("Add at least one category with an amount.");
        return;
      }

      const startDate = document.getElementById("startDate").value || todayISO();
      const period = {
        id: uid(),
        paycheckAmount: paycheck,
        startDate,
        frequency: document.getElementById("frequency").value,
        categories: cats,
        transactions: [],
        closed: false,
        createdAt: new Date().toISOString(),
      };
      // Fixed bills are auto-logged as spent on payday.
      cats.forEach((c) => {
        if (c.fixed && c.budgeted > 0) {
          period.transactions.push({
            id: uid(),
            categoryId: c.id,
            amount: c.budgeted,
            description: c.name,
            date: startDate,
            auto: true,
            editedAt: Date.now(),
          });
        }
      });
      state.periods.push(period);
      // Remember layout (names/emojis/amounts/fixed) for next payday.
      state.template = {
        frequency: period.frequency,
        categories: cats.map((c) => ({ emoji: c.emoji, name: c.name, budgeted: c.budgeted, fixed: c.fixed, rollover: !!c.rollover })),
      };
      state.view = "dashboard";
      save();
      render();
    });

    drawRows();
  }

  /* ---------- Vacation budget setup (runs alongside the pay period) ---------- */
  function renderVacationSetup() {
    const template = state.vacationTemplate || { categories: VACATION_CATEGORIES };
    const todayIso = todayISO();
    const weekOut = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return dateToISO(d); })();

    main.innerHTML = `
      <div class="card">
        <h2>Plan your vacation 🏖️</h2>
        <p class="sub">Set a total for the trip and the dates you'll be away. This budget runs alongside your regular pay period — the two are tracked separately.</p>

        <div class="field money-input">
          <label>Total vacation budget</label>
          <input id="vac-total" type="number" inputmode="decimal" placeholder="0.00" step="0.01" />
        </div>

        <div class="field-row">
          <div class="field">
            <label>Start date</label>
            <input id="vac-start" type="date" value="${todayIso}" />
          </div>
          <div class="field">
            <label>End date</label>
            <input id="vac-end" type="date" value="${weekOut}" />
          </div>
        </div>
      </div>

      <div class="card">
        <h2>Split it into a budget</h2>
        <p class="sub">Plan what you'll spend while away — whatever's left over comes home with you.</p>
        <div id="alloc-list"></div>
        <button class="btn btn-ghost btn-sm" id="add-cat">+ Add category</button>

        <div class="alloc-summary">
          <span>Budget <b id="sum-paycheck">$0.00</b></span>
          <span>Unallocated <b class="remaining" id="sum-remaining">$0.00</b></span>
        </div>

        <button class="btn btn-primary btn-block" id="start-vacation">Start vacation budget</button>
      </div>

      <p class="footer-note">You can switch back to your pay period anytime using the toggle up top.</p>
    `;

    let rows = template.categories.map((c) => ({
      id: uid(),
      emoji: c.emoji || "💵",
      name: c.name || "",
      budgeted: c.budgeted != null ? String(c.budgeted) : "",
      fixed: !!c.fixed,
      rollover: false,
    }));

    const listEl = document.getElementById("alloc-list");
    const totalEl = document.getElementById("vac-total");

    function drawRows() {
      listEl.innerHTML = rows.map((r) => catEditRow(r, r.id, { drag: true })).join("");
      updateSummary();
    }
    enableRowDrag(listEl, (order) => {
      rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    });
    function updateSummary() {
      const total = Number(totalEl.value) || 0;
      const allocated = rows.reduce((s, r) => s + (Number(r.budgeted) || 0), 0);
      const remaining = total - allocated;
      document.getElementById("sum-paycheck").textContent = fmt(total);
      const remEl = document.getElementById("sum-remaining");
      remEl.textContent = fmt(remaining);
      remEl.className = "remaining " + (remaining < -0.005 ? "neg" : remaining > 0.005 ? "pos" : "");
    }
    listEl.addEventListener("input", (e) => {
      const item = e.target.closest(".cat-edit-row");
      if (!item) return;
      const row = rows.find((r) => r.id === item.dataset.row);
      if (!row) return;
      const f = e.target.dataset.f;
      row[f] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
      if (f === "budgeted") updateSummary();
    });
    listEl.addEventListener("click", (e) => {
      const rm = e.target.dataset.rm;
      if (!rm) return;
      rows = rows.filter((r) => r.id !== rm);
      drawRows();
    });
    document.getElementById("add-cat").addEventListener("click", () => {
      rows.push({ id: uid(), emoji: "💵", name: "", budgeted: "", fixed: false });
      drawRows();
      const last = listEl.querySelector(".cat-edit-row:last-child .name-in");
      if (last) last.focus();
    });
    totalEl.addEventListener("input", updateSummary);

    document.getElementById("start-vacation").addEventListener("click", () => {
      const total = Number(totalEl.value);
      if (!total || total <= 0) {
        showFieldError(totalEl, "Enter a total for your vacation budget.");
        return;
      }
      const startDate = document.getElementById("vac-start").value || todayIso;
      const endDate = document.getElementById("vac-end").value || startDate;
      if (parseDate(endDate) < parseDate(startDate)) {
        showToast("End date can't be before the start date.");
        return;
      }
      const cats = rows
        .filter((r) => r.name.trim() && Number(r.budgeted) > 0)
        .map((r) => ({
          id: uid(),
          emoji: r.emoji.trim() || "💵",
          name: r.name.trim(),
          budgeted: Number(r.budgeted),
          fixed: !!r.fixed,
        }));
      if (cats.length === 0) {
        showToast("Add at least one category with an amount.");
        return;
      }
      const period = {
        id: uid(),
        kind: "vacation",
        paycheckAmount: total,
        startDate,
        endDate,
        frequency: "custom",
        categories: cats,
        transactions: [],
        closed: false,
        createdAt: new Date().toISOString(),
      };
      // Prepaid fixed items (flights, lodging) auto-log as spent up front.
      cats.forEach((c) => {
        if (c.fixed && c.budgeted > 0) {
          period.transactions.push({
            id: uid(),
            categoryId: c.id,
            amount: c.budgeted,
            description: c.name,
            date: startDate,
            auto: true,
            editedAt: Date.now(),
          });
        }
      });
      state.periods.push(period);
      state.vacationTemplate = {
        categories: cats.map((c) => ({ emoji: c.emoji, name: c.name, budgeted: c.budgeted, fixed: c.fixed })),
      };
      state.activeBudget = "vacation";
      state.view = "dashboard";
      save();
      render();
    });

    drawRows();
  }

  /* ---------- Dashboard ---------- */
  function renderDashboard(p) {
    const isVac = periodKind(p) === "vacation";
    const budgeted = totalBudgeted(p);
    const spent = totalSpent(p);
    const remaining = budgeted - spent;
    const saved = periodIncome(p) - spent; // money kept so far (income minus spent) — matches History/Results
    const dl = daysLeft(p);
    const coach = coachMessage(p);
    // Budget-used ring for the hero card.
    const pctSpent = budgeted > 0 ? Math.round((spent / budgeted) * 100) : 0;
    const ringC = 2 * Math.PI * 43;
    const ringDash = (Math.min(100, Math.max(0, pctSpent)) / 100) * ringC;

    const renderCat = (c) => {
      const cs = catSpent(p, c.id);
      const pct = c.budgeted > 0 ? (cs / c.budgeted) * 100 : 0;
      const cls = pct > 100 ? "over" : c.fixed ? "ok" : pct > 85 ? "warn" : "ok";
      const over = cs > c.budgeted + 0.005;
      const pctLabel = c.budgeted > 0 ? Math.round(pct) + "%" : "—";
      const remainAmt = over ? fmt(cs - c.budgeted) : fmt(c.budgeted - cs);
      const remainLabel = over ? "over" : "left";
      const fixedTag = c.fixed ? `<span class="cat-fixed" title="Fixed bill" aria-label="Fixed bill"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10.5" width="16" height="9.5" rx="2.5"></rect><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"></path></svg></span>` : "";
      return `
        <button type="button" class="cat-row cat-row-tap ${over ? "is-over" : ""}" data-cat="${c.id}"
          aria-label="Log spending for ${esc(c.name)}">
          <span class="cat-tile">${esc(c.emoji)}</span>
          <span class="cat-body">
            <span class="cat-line">
              <span class="cat-name">${esc(c.name)}${fixedTag}</span>
              <span class="cat-pct">${pctLabel}</span>
            </span>
            <span class="cat-line cat-sub">
              <span class="cat-spent"><b>${fmt(cs)}</b> of ${fmt(c.budgeted)}</span>
              <span class="cat-left ${over ? "over" : ""}"><b>${remainAmt}</b> <span class="cat-left-label">${remainLabel}</span></span>
            </span>
            <span class="bar"><span class="bar-fill ${cls}" style="width:${Math.min(100, pct)}%"></span></span>
          </span>
          <span class="cat-chevron" aria-hidden="true">›</span>
        </button>`;
    };

    const fixedCats = p.categories.filter((c) => c.fixed);
    const spendCats = p.categories.filter((c) => !c.fixed);
    const fixedCollapsed = !!state.fixedCollapsed;
    const fixedBudgeted = fixedCats.reduce((s, c) => s + Number(c.budgeted), 0);
    let cats;
    if (fixedCats.length) {
      cats =
        `<button type="button" class="fixed-summary ${fixedCollapsed ? "collapsed" : ""}" id="fixed-toggle" aria-expanded="${!fixedCollapsed}">
           <span class="ft-left">
             <span class="ft-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10.5" width="16" height="9.5" rx="2.5"></rect><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"></path></svg></span>
             <span class="ft-title">Fixed Bills</span>
             <span class="ft-count">${fixedCats.length}</span>
           </span>
           <span class="ft-right">
             <span class="ft-amt">${fmt(fixedBudgeted)}</span>
             <span class="ft-caret" aria-hidden="true">›</span>
           </span>
         </button>` +
        (fixedCollapsed ? "" : fixedCats.map(renderCat).join(""));
      if (spendCats.length) {
        cats +=
          `<div class="section-label cat-section-gap">Discretionary Spending</div>` +
          spendCats.map(renderCat).join("");
      }
    } else {
      cats = p.categories.map(renderCat).join("");
    }

    // Data-safety nudge: this budget only lives on-device until it's synced.
    const needsSafety = state.periods.length > 0 && !cloudUser && !bannerDismissed;
    const safetyBanner = needsSafety
      ? `<div class="safety-banner">
           <div class="safety-text">🔒 This budget is only saved on this device. ${cloudOn() ? "Sign in to sync it so you never lose it if your browser clears data." : "Download a backup so you never lose it if your browser clears data."}</div>
           <div class="safety-actions">
             ${cloudOn() ? `<button class="btn btn-primary btn-sm" id="safety-signin">Sign in to sync</button>` : ""}
             <button class="btn btn-ghost btn-sm" id="safety-backup">Download backup</button>
             <button type="button" class="safety-x" id="safety-dismiss" aria-label="Dismiss">✕</button>
           </div>
         </div>`
      : "";

    main.innerHTML = `
      ${dl === 0 ? (isVac
          ? `<button class="btn btn-primary btn-block period-ended" id="period-ended">🏖️ Your vacation ended — close it out</button>`
          : `<button class="btn btn-primary btn-block period-ended" id="period-ended">🎉 Your pay period ended — start the next one</button>`) : ""}
      ${safetyBanner}
      <div class="card hero">
        <div class="hero-main">
          <div class="hero-eyebrow">Left to spend</div>
          <div class="amount">${fmt(remaining)}</div>
          <button type="button" class="hero-days" id="edit-dates" aria-label="Edit dates" title="Edit dates">${
            isVac
              ? (dl === 0 ? "Vacation ended" : `${dl} ${dl === 1 ? "day" : "days"} left of vacation`)
              : (dl === 0 ? "Next paycheck due" : `${dl} ${dl === 1 ? "day" : "days"} until next paycheck`)
          }</button>
        </div>
        <div class="hero-ring" role="img" aria-label="${pctSpent}% of budget spent">
          <svg width="100" height="100" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="43" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="9"/>
            <circle cx="50" cy="50" r="43" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-dasharray="${ringC.toFixed(1)}" stroke-dashoffset="${(ringC - ringDash).toFixed(1)}" transform="rotate(-90 50 50)"/>
          </svg>
          <div class="hero-ring-label"><span class="hrl-pct">${pctSpent}%</span><span class="hrl-cap">spent</span></div>
        </div>
      </div>

      <div class="coach coach-${coach.tone}">${esc(coach.text)}</div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;">
          <h2 style="margin:0;">Expense Categories</h2>
          <button class="icon-btn" id="manage-cats" aria-label="Manage categories" title="Manage categories"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="9" cy="7" r="2.4" fill="var(--surface-2)"/><circle cx="15" cy="12" r="2.4" fill="var(--surface-2)"/><circle cx="8" cy="17" r="2.4" fill="var(--surface-2)"/></svg></button>
        </div>
        ${cats}
      </div>

      <div class="card stat-card">
        <div class="stat-grid">
          <div class="sstat"><div class="sk">Budgeted</div><div class="sv">${fmt(budgeted)}</div></div>
          <div class="sstat"><div class="sk">Spent</div><div class="sv">${fmt(spent)}</div></div>
          <div class="sstat"><div class="sk">${saved >= 0 ? "Saved" : "Over budget"}</div><div class="sv ${saved > 0.005 ? "pos" : saved < -0.005 ? "neg" : ""}">${fmt(Math.abs(saved))}</div></div>
        </div>
      </div>

      <button class="btn btn-block btn-payday" id="add-income">${isVac ? "Add to vacation budget" : "Add extra income"}</button>
      <button class="btn btn-block btn-payday" id="new-payday" style="margin-top:10px;">${isVac ? "End vacation" : "Got paid? Start a new pay period"}</button>
    `;

    document.getElementById("manage-cats").addEventListener("click", () => openManageCategories(p));
    document.getElementById("add-income").addEventListener("click", () => openIncomeModal(p));
    document.getElementById("new-payday").addEventListener("click", () => (isVac ? confirmEndVacation(p) : confirmNewPayday(p)));
    const ed = document.getElementById("edit-dates");
    if (ed) ed.addEventListener("click", () => openPeriodDates(p));
    const ssi = document.getElementById("safety-signin");
    if (ssi) ssi.addEventListener("click", () => openLogin(false));
    const sbk = document.getElementById("safety-backup");
    if (sbk) sbk.addEventListener("click", exportData);
    const sdm = document.getElementById("safety-dismiss");
    if (sdm)
      sdm.addEventListener("click", () => {
        bannerDismissed = true;
        try { localStorage.setItem(STORAGE_KEY + "-banner-dismissed", String(Date.now())); } catch (e) {}
        render();
      });
    const pe = document.getElementById("period-ended");
    if (pe) pe.addEventListener("click", () => (isVac ? confirmEndVacation(p) : confirmNewPayday(p)));
    const ft = document.getElementById("fixed-toggle");
    if (ft)
      ft.addEventListener("click", () => {
        state.fixedCollapsed = !state.fixedCollapsed;
        save();
        render();
      });
    main.querySelectorAll(".cat-row-tap").forEach((el) =>
      el.addEventListener("click", () => openSpendModal(p, el.dataset.cat))
    );
  }

  /* ---------- Edit the current pay period's dates ---------- */
  function openPeriodDates(p) {
    if (periodKind(p) === "vacation") return openVacationDates(p);
    const { close } = mountModal(`
      <div class="modal-overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Edit pay period dates">
          <h2>Pay period dates</h2>
          <p class="sub">Set the day you were last paid and how often you're paid — this drives the countdown to your next paycheck.</p>
          <div class="field">
            <label for="pd-start">Last paid on</label>
            <input id="pd-start" type="date" value="${esc(p.startDate)}" />
          </div>
          <div class="field">
            <label for="pd-freq">Pay frequency</label>
            <select id="pd-freq">
              <option value="weekly">Weekly</option>
              <option value="biweekly">Every 2 weeks</option>
              <option value="semimonthly">Twice a month</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div class="pd-next" id="pd-next"></div>
          <div class="field-row" style="margin-top:14px;">
            <button class="btn btn-ghost" id="pd-cancel" style="flex:1;">Cancel</button>
            <button class="btn btn-primary" id="pd-save" style="flex:2;">Save</button>
          </div>
        </div>
      </div>
    `);
    const startEl = document.getElementById("pd-start");
    const freqEl = document.getElementById("pd-freq");
    const nextEl = document.getElementById("pd-next");
    freqEl.value = p.frequency || "biweekly";

    const refresh = () => {
      const s = startEl.value;
      if (!s) {
        nextEl.textContent = "";
        return;
      }
      const end = periodEnd({ startDate: s, frequency: freqEl.value });
      nextEl.innerHTML = `Next paycheck: <b>${esc(fmtDateLong(dateToISO(end)))}</b>`;
    };
    startEl.addEventListener("change", refresh);
    freqEl.addEventListener("change", refresh);
    refresh();

    document.getElementById("pd-cancel").addEventListener("click", close);
    document.getElementById("pd-save").addEventListener("click", () => {
      const s = startEl.value;
      if (!s) {
        showToast("Pick the date you were last paid.");
        return;
      }
      p.startDate = s;
      p.frequency = freqEl.value;
      save();
      close();
      render();
      showToast("Pay period updated ✓");
    });
  }

  /* ---------- Edit the vacation budget's date range ---------- */
  function openVacationDates(p) {
    const { close } = mountModal(`
      <div class="modal-overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Edit vacation dates">
          <h2>Vacation dates</h2>
          <p class="sub">Set when your trip starts and ends — this drives the days-left countdown.</p>
          <div class="field-row">
            <div class="field">
              <label for="vd-start">Start date</label>
              <input id="vd-start" type="date" value="${esc(p.startDate)}" />
            </div>
            <div class="field">
              <label for="vd-end">End date</label>
              <input id="vd-end" type="date" value="${esc(p.endDate || p.startDate)}" />
            </div>
          </div>
          <div class="field-row" style="margin-top:14px;">
            <button class="btn btn-ghost" id="vd-cancel" style="flex:1;">Cancel</button>
            <button class="btn btn-primary" id="vd-save" style="flex:2;">Save</button>
          </div>
        </div>
      </div>
    `);
    document.getElementById("vd-cancel").addEventListener("click", close);
    document.getElementById("vd-save").addEventListener("click", () => {
      const s = document.getElementById("vd-start").value;
      const e = document.getElementById("vd-end").value;
      if (!s || !e) { showToast("Pick both a start and end date."); return; }
      if (parseDate(e) < parseDate(s)) { showToast("End date can't be before the start date."); return; }
      p.startDate = s;
      p.endDate = e;
      save();
      close();
      render();
      showToast("Vacation dates updated ✓");
    });
  }

  /* ---------- End (close) the vacation budget ---------- */
  function confirmEndVacation(p) {
    const remaining = totalBudgeted(p) - totalSpent(p);
    const { close } = mountModal(`
      <div class="modal-overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="End vacation">
          <h2>End this vacation? 🏖️</h2>
          <p class="sub">This closes your vacation budget and saves it to history. You had
            <b>${fmt(remaining)}</b> left across all categories. Your pay period isn't affected.</p>
          <div class="field-row">
            <button class="btn btn-ghost" id="ev-cancel" style="flex:1;">Not yet</button>
            <button class="btn btn-primary" id="ev-go" style="flex:2;">Yes, end vacation</button>
          </div>
        </div>
      </div>
    `);
    document.getElementById("ev-cancel").addEventListener("click", close);
    document.getElementById("ev-go").addEventListener("click", () => {
      p.closed = true;
      p.closedAt = new Date().toISOString();
      state.activeBudget = "payday"; // hop back to the pay period after ending
      save();
      close();
      render();
    });
  }

  /* ---------- Quick add sheet (header "+"): income or new pay period ---------- */
  function openQuickAdd(p) {
    const isVac = periodKind(p) === "vacation";
    const { close } = mountModal(`
      <div class="modal-overlay">
        <div class="modal quick-add" role="dialog" aria-modal="true" aria-label="Quick add">
          <h2>Quick add</h2>
          <p class="sub">${isVac ? "Top up your vacation budget, or end the trip." : "Add money to this period, or close it out and start fresh."}</p>
          <button class="btn btn-block btn-payday" id="qa-income">${isVac ? "Add to vacation budget" : "Add extra income"}</button>
          <button class="btn btn-block btn-payday" id="qa-payday" style="margin-top:10px;">${isVac ? "End vacation" : "Got paid? Start a new pay period"}</button>
          <button class="btn btn-ghost btn-block" id="qa-cancel" style="margin-top:10px;">Cancel</button>
        </div>
      </div>
    `);
    document.getElementById("qa-cancel").addEventListener("click", close);
    document.getElementById("qa-income").addEventListener("click", () => {
      close();
      openIncomeModal(p);
    });
    document.getElementById("qa-payday").addEventListener("click", () => {
      close();
      if (isVac) confirmEndVacation(p);
      else confirmNewPayday(p);
    });
  }

  /* ---------- Add extra income to the current period ---------- */
  function openIncomeModal(p) {
    const isVac = periodKind(p) === "vacation";
    const { close } = mountModal(`
      <div class="modal-overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="${isVac ? "Add to vacation budget" : "Add income"}">
          <h2>${isVac ? "Add to vacation budget" : "Add extra income"}</h2>
          <p class="sub">${isVac ? "Extra cash for the trip — a gift, refund, or top-up. It increases what you can spend on vacation." : "A bonus, refund, or second paycheck this period — it increases what you can save."}</p>
          <div class="field money-input">
            <label for="inc-amount">Amount</label>
            <input id="inc-amount" type="number" inputmode="decimal" placeholder="0.00" step="0.01" />
          </div>
          <div class="field">
            <label for="inc-note">Note (optional)</label>
            <input id="inc-note" placeholder="e.g. Work bonus" />
          </div>
          <div class="field-row">
            <button class="btn btn-ghost" id="inc-cancel" style="flex:1;">Cancel</button>
            <button class="btn btn-primary" id="inc-save" style="flex:2;">Add income</button>
          </div>
        </div>
      </div>
    `);
    const amountEl = document.getElementById("inc-amount");
    amountEl.addEventListener("input", () => clearFieldError(amountEl));
    document.getElementById("inc-cancel").addEventListener("click", close);
    document.getElementById("inc-save").addEventListener("click", () => {
      const amount = Number(amountEl.value);
      if (!amount || amount <= 0) {
        showFieldError(amountEl, "Enter an amount greater than zero.");
        return;
      }
      if (!p.extraIncome) p.extraIncome = [];
      p.extraIncome.push({
        id: uid(),
        amount,
        note: document.getElementById("inc-note").value.trim(),
        date: todayISO(),
      });
      save();
      close();
      render();
      showToast("Income added");
    });
  }

  /* ---------- Manage categories (add / remove / edit on an active period) ---------- */
  function openManageCategories(p) {
    // Working copy — existing rows keep their id so transactions stay linked.
    let rows = p.categories.map((c) => ({
      id: c.id,
      emoji: c.emoji,
      name: c.name,
      budgeted: String(c.budgeted),
      fixed: !!c.fixed,
      rollover: !!c.rollover,
      _key: uid(),
    }));

    const { close } = mountModal(`
      <div class="modal-overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Manage categories">
          <h2>Manage categories</h2>
          <p class="sub">Add new ones, remove what you don't need, or adjust an amount. Changes apply to this pay period.</p>
          <div id="mc-list"></div>
          <button class="btn btn-ghost btn-sm" id="mc-add">+ Add category</button>
          <div class="alloc-summary">
            <span>Total budgeted <b id="mc-total">$0.00</b></span>
            <span>of ${fmt(p.paycheckAmount)} paycheck</span>
          </div>
          <div class="field-row">
            <button class="btn btn-ghost" id="mc-cancel" style="flex:1;">Cancel</button>
            <button class="btn btn-primary" id="mc-save" style="flex:2;">Save changes</button>
          </div>
        </div>
      </div>
    `);

    const listEl = document.getElementById("mc-list");

    enableRowDrag(listEl, (order) => {
      rows.sort((a, b) => order.indexOf(a._key) - order.indexOf(b._key));
    });

    function spentFor(rowId) {
      return rowId ? catSpent(p, rowId) : 0;
    }

    function drawRows() {
      listEl.innerHTML = rows
        .map((r) => {
          const spent = spentFor(r.id);
          const note = spent > 0 ? `${fmt(spent)} already logged here` : "";
          return catEditRow(r, r._key, { note, drag: true });
        })
        .join("");
      updateTotal();
    }

    function updateTotal() {
      const total = rows.reduce((s, r) => s + (Number(r.budgeted) || 0), 0);
      document.getElementById("mc-total").textContent = fmt(total);
    }

    listEl.addEventListener("input", (e) => {
      const rowEl = e.target.closest(".cat-edit-row");
      if (!rowEl) return;
      const row = rows.find((r) => r._key === rowEl.dataset.row);
      if (!row) return;
      const f = e.target.dataset.f;
      row[f] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
      if (f === "budgeted") updateTotal();
    });

    listEl.addEventListener("click", (e) => {
      const key = e.target.dataset.rm;
      if (!key) return;
      const row = rows.find((r) => r._key === key);
      const spent = row ? spentFor(row.id) : 0;
      if (spent > 0) {
        const n = p.transactions.filter((t) => t.categoryId === row.id).length;
        if (
          !confirm(
            `"${row.name}" has ${n} transaction${n === 1 ? "" : "s"} (${fmt(spent)}) logged.\nRemoving it will also delete those. Continue?`
          )
        )
          return;
      }
      rows = rows.filter((r) => r._key !== key);
      drawRows();
    });

    document.getElementById("mc-add").addEventListener("click", () => {
      rows.push({ id: null, emoji: "💵", name: "", budgeted: "", fixed: false, rollover: false, _key: uid() });
      drawRows();
      const last = listEl.querySelector(".cat-edit-row:last-child .name-in");
      if (last) last.focus();
    });

    document.getElementById("mc-cancel").addEventListener("click", close);

    document.getElementById("mc-save").addEventListener("click", () => {
      const kept = rows
        .filter((r) => r.name.trim())
        .map((r) => ({
          id: r.id || uid(),
          emoji: r.emoji.trim() || "💵",
          name: r.name.trim(),
          budgeted: Math.max(0, Number(r.budgeted) || 0),
          fixed: !!r.fixed,
          rollover: !!r.rollover,
        }));

      if (kept.length === 0) {
        showToast("Keep at least one category.");
        return;
      }

      // Any transactions whose category was removed get dropped (tombstoned so
      // the removal survives a sync merge).
      const keptIds = new Set(kept.map((c) => c.id));
      p.transactions.slice().forEach((t) => {
        if (!keptIds.has(t.categoryId)) deleteTxn(p, t.id);
      });
      p.categories = kept;

      // Remember the new layout for the next payday.
      state.template = {
        frequency: p.frequency,
        categories: kept.map((c) => ({ emoji: c.emoji, name: c.name, budgeted: c.budgeted, fixed: c.fixed, rollover: !!c.rollover })),
      };

      save();
      close();
      render();
    });

    drawRows();
  }

  /* ---------- Spend view (log + list transactions) ---------- */
  function renderSpend(p) {
    const sortOrder = state._spendSort === "oldest" ? "oldest" : "newest";
    const txns = [...p.transactions].sort((a, b) => {
      const cmp = (a.date + a.id).localeCompare(b.date + b.id);
      return sortOrder === "oldest" ? cmp : -cmp;
    });

    const catById = Object.fromEntries(p.categories.map((c) => [c.id, c]));
    const total = totalSpent(p);
    // Top categories = discretionary only (exclude fixed bills — they don't vary).
    const catTotals = p.categories
      .map((c) => ({ c, amt: catSpent(p, c.id) }))
      .filter((x) => x.amt > 0 && !x.c.fixed)
      .sort((a, b) => b.amt - a.amt);
    const discTotal = catTotals.reduce((s, x) => s + x.amt, 0);
    const topCats = catTotals.slice(0, 3);
    // Donut breakdown: top 3 discretionary categories + "Other" for the rest.
    const segTotal = topCats.reduce((s, x) => s + x.amt, 0);
    const otherAmt = Math.max(0, discTotal - segTotal);
    const segs = topCats.map((x, i) => ({ label: `${x.c.emoji} ${x.c.name}`, amt: x.amt, color: `var(--seg${i + 1})` }));
    if (otherAmt > 0.005) segs.push({ label: "Other", amt: otherAmt, color: "var(--seg-other)" });
    let donutCum = 0;
    const donutArcs = segs
      .map((s) => {
        const pct = discTotal > 0 ? (s.amt / discTotal) * 100 : 0;
        const off = 25 - donutCum;
        donutCum += pct;
        return `<circle cx="21" cy="21" r="15.915" fill="none" stroke="${s.color}" stroke-width="5" stroke-dasharray="${pct.toFixed(2)} ${(100 - pct).toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"></circle>`;
      })
      .join("");
    const donutLegend = segs
      .map((s) => {
        const segPct = discTotal > 0 ? Math.round((s.amt / discTotal) * 100) : 0;
        return `<div class="dn-row"><span class="dn-dot" style="background:${s.color}"></span><span class="dn-name">${esc(s.label)}</span><span class="dn-amt">${fmt(s.amt)}</span><span class="dn-pct">${segPct}%</span></div>`;
      })
      .join("");

    // Optional filter by category (tap a chip). Transient, per-device.
    const usedCatIds = [...new Set(p.transactions.map((t) => t.categoryId))];
    let activeFilter = state._spendFilter || "all";
    const usedCats = p.categories.filter((c) => usedCatIds.includes(c.id));
    const hasDisc = usedCats.some((c) => !c.fixed);
    const hasFixed = usedCats.some((c) => c.fixed);
    const isTypeFilter = (f) => f === "all" || f === "discretionary" || f === "fixed";
    // Drop stale filters: a removed category, or a type with nothing behind it.
    if (!isTypeFilter(activeFilter) && !usedCatIds.includes(activeFilter)) activeFilter = "all";
    if (activeFilter === "discretionary" && !hasDisc) activeFilter = "all";
    if (activeFilter === "fixed" && !hasFixed) activeFilter = "all";

    const matchesFilter = (t) => {
      if (activeFilter === "all") return true;
      const c = catById[t.categoryId];
      if (activeFilter === "discretionary") return c && !c.fixed;
      if (activeFilter === "fixed") return c && !!c.fixed;
      return t.categoryId === activeFilter;
    };
    const filtered = txns.filter(matchesFilter);
    const filteredTotal = filtered.reduce((s, t) => s + Number(t.amount), 0);

    // Offer the discretionary / fixed split only when both kinds of spending exist.
    const typeChips =
      hasDisc && hasFixed
        ? `<button type="button" class="chip ${activeFilter === "discretionary" ? "active" : ""}" data-f="discretionary">Discretionary</button>
           <button type="button" class="chip ${activeFilter === "fixed" ? "active" : ""}" data-f="fixed">Fixed Bills</button>`
        : "";

    const filterRow = txns.length
      ? `<div class="chips spend-filter" id="spend-filter" role="group" aria-label="Filter transactions">
           <button type="button" class="chip ${activeFilter === "all" ? "active" : ""}" data-f="all">All</button>
           ${typeChips}
           ${p.categories
             .filter((c) => usedCatIds.includes(c.id))
             .map(
               (c) =>
                 `<button type="button" class="chip ${activeFilter === c.id ? "active" : ""}" data-f="${c.id}">${esc(c.emoji)} ${esc(c.name)}</button>`
             )
             .join("")}
         </div>`
      : "";

    const sortRow = txns.length
      ? `<div class="chips sort-row" id="spend-sort" role="group" aria-label="Sort by date">
           <button type="button" class="chip ${sortOrder === "newest" ? "active" : ""}" data-sort="newest">Newest first</button>
           <button type="button" class="chip ${sortOrder === "oldest" ? "active" : ""}" data-sort="oldest">Oldest first</button>
         </div>`
      : "";

    const list = filtered.length
      ? filtered
          .map((t) => {
            const c = catById[t.categoryId] || { emoji: "❓", name: "Uncategorized" };
            return `
          <div class="txn" data-id="${t.id}">
            <button type="button" class="txn-left txn-edit" data-edit="${t.id}" aria-label="Edit ${esc(t.description || c.name)}">
              <div class="txn-emoji">${esc(c.emoji)}</div>
              <div>
                <div class="txn-desc">${esc(t.description || c.name)}</div>
                <div class="txn-meta">${esc(c.name)} · ${esc(fmtDateShort(t.date))}</div>
              </div>
            </button>
            <div style="display:flex;align-items:center;">
              <span class="txn-amt">${fmt(t.amount)}</span>
              <button class="rm" data-rm="${t.id}" title="Delete" aria-label="Delete ${esc(t.description || c.name)}">🗑</button>
            </div>
          </div>`;
          })
          .join("")
      : `<div class="empty"><div class="big">🧾</div><p>${activeFilter === "all" ? "No spending logged yet this period. Tap “Log spend” up top to add one." : "Nothing matches this filter yet."}</p></div>`;

    const filterName =
      activeFilter === "discretionary" ? "discretionary spending"
      : activeFilter === "fixed" ? "fixed bills"
      : (catById[activeFilter] || {}).name || "category";
    const subline =
      activeFilter === "all"
        ? `${filtered.length} ${filtered.length === 1 ? "transaction" : "transactions"}${txns.length ? " · tap one to edit" : ""}`
        : `${filtered.length} ${filtered.length === 1 ? "transaction" : "transactions"} · ${fmt(filteredTotal)} in ${esc(filterName)}`;

    main.innerHTML = `
      <div class="card spend-sum">
        <div class="ss-label">Spent this period</div>
        <div class="ss-total">${fmt(total)}</div>
        <div class="ss-range">${esc(periodRangeLabel(p))}</div>
        ${topCats.length ? `<div class="ss-top">
          <div class="ss-top-label">Top discretionary spending</div>
          <div class="dn-wrap">
            <div class="dn-chart"><svg viewBox="0 0 42 42" aria-hidden="true"><circle cx="21" cy="21" r="15.915" fill="none" stroke="var(--surface-2)" stroke-width="5"></circle>${donutArcs}</svg></div>
            <div class="dn-legend">${donutLegend}</div>
          </div>
        </div>` : ""}
      </div>
      <div class="card">
        <p class="sub" style="margin-top:0;">${subline}</p>
        ${filterRow}
        ${sortRow}
        ${list}
      </div>
    `;

    const sortEl = document.getElementById("spend-sort");
    if (sortEl)
      sortEl.addEventListener("click", (e) => {
        const b = e.target.closest("[data-sort]");
        if (!b) return;
        state._spendSort = b.dataset.sort;
        render();
      });

    const filterEl = document.getElementById("spend-filter");
    if (filterEl)
      filterEl.addEventListener("click", (e) => {
        const b = e.target.closest("[data-f]");
        if (!b) return;
        state._spendFilter = b.dataset.f;
        render();
      });

    main.querySelectorAll("[data-edit]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const t = p.transactions.find((x) => x.id === btn.dataset.edit);
        if (t) openSpendModal(p, null, t);
      })
    );

    main.querySelectorAll("[data-rm]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const res = deleteTxn(p, btn.dataset.rm);
        if (!res) return;
        save();
        render();
        showToast("Transaction deleted", "Undo", () => {
          restoreTxn(p, res.removed, res.idx);
          save();
          render();
        });
      })
    );
  }

  // editTxn: pass an existing transaction to edit it instead of adding a new one.
  /* Light synonym map (keyed by lowercased category name) so quick-add can
   * match everyday words to a category even when the name differs. */
  const QUICK_SYNONYMS = {
    groceries: ["grocery", "costco", "superstore", "loblaws", "supermarket", "walmart"],
    restaurants: ["restaurant", "dinner", "lunch", "brunch"],
    "take-out": ["takeout", "take out", "uber eats", "doordash", "skip"],
    dining: ["dinner", "lunch", "restaurant", "brunch"],
    "food & dining": ["food", "dinner", "lunch", "restaurant", "meal"],
    coffee: ["starbucks", "cafe", "latte", "tims", "timmies", "espresso"],
    gas: ["fuel", "petrol", "gasoline"],
    transit: ["bus", "subway", "ttc", "metro", "train", "presto"],
    transport: ["uber", "lyft", "taxi", "cab", "bus"],
    "local transport": ["uber", "lyft", "taxi", "cab", "metro", "train"],
    "ride-share": ["uber", "lyft", "taxi", "cab", "ride"],
    shopping: ["amazon", "clothes", "mall", "store"],
    entertainment: ["movie", "movies", "concert", "game", "spotify", "show"],
    gym: ["fitness", "workout", "class"],
    phone: ["cell", "mobile", "cellphone"],
    internet: ["wifi", "isp"],
    streaming: ["netflix", "spotify", "disney", "hulu", "prime", "crave"],
    rent: ["mortgage", "landlord"],
    flights: ["flight", "airfare", "plane", "airline"],
    lodging: ["hotel", "airbnb", "motel", "hostel", "stay"],
    activities: ["tour", "ticket", "tickets", "activity", "excursion", "museum"],
    souvenirs: ["souvenir", "gift", "gifts", "keepsake"],
  };

  /* Parse a natural-language quick-add like "38 ramen" or "$12 coffee" into
   * { amount, categoryId, note } using the period's own categories + synonyms. */
  function parseQuickAdd(text, cats) {
    const raw = String(text || "").trim();
    if (!raw) return { amount: null, categoryId: null, note: "" };
    const m = raw.match(/\d+(?:[.,]\d+)?/);
    const amount = m ? Number(m[0].replace(",", ".")) : null;
    let rest = raw;
    if (m) rest = rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length);
    rest = rest.replace(/\$/g, " ").replace(/\s+/g, " ").trim();
    const restLc = rest.toLowerCase();
    let best = null, bestScore = 0, bestHit = "";
    for (const c of cats) {
      const name = (c.name || "").toLowerCase();
      const tokens = name.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
      const candidates = tokens.concat(QUICK_SYNONYMS[name] || []);
      for (const cand of candidates) {
        if (cand && restLc.includes(cand) && cand.length > bestScore) {
          bestScore = cand.length; best = c; bestHit = cand;
        }
      }
    }
    let note = rest;
    if (bestHit) {
      const safe = bestHit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      note = rest.replace(new RegExp(safe, "ig"), " ").replace(/\s+/g, " ").trim();
    }
    return { amount, categoryId: best ? best.id : null, note };
  }

  function openSpendModal(p, presetCatId, editTxn, afterSave) {
    const cats = p.categories;
    const editing = !!editTxn;
    let selectedCat =
      (editTxn && editTxn.categoryId) || presetCatId || cats[0].id;
    if (!cats.some((c) => c.id === selectedCat)) selectedCat = cats[0].id;

    const { close } = mountModal(`
      <div class="modal-overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="${editing ? "Edit spending" : "Log spending"}">
          <h2>${editing ? "Edit spending" : "Log spending"}</h2>
          ${editing ? "" : `
          <div class="field quick-add-field">
            <label for="sp-quick">⚡ Quick add</label>
            <input id="sp-quick" placeholder="Type it — e.g. “38 ramen” or “12 coffee”" autocomplete="off" enterkeyhint="done" />
            <div class="quick-hint" id="sp-quick-hint" aria-live="polite"></div>
          </div>`}
          <div class="field money-input">
            <label for="sp-amount">Amount</label>
            <input id="sp-amount" type="number" inputmode="decimal" placeholder="0.00" step="0.01"
              value="${editing ? esc(editTxn.amount) : ""}" />
          </div>
          <div class="field">
            <label>Category</label>
            <div class="chips" id="sp-chips" role="group" aria-label="Category">
              ${cats
                .map(
                  (c) =>
                    `<button type="button" class="chip ${c.id === selectedCat ? "active" : ""}" data-cat="${c.id}" aria-pressed="${c.id === selectedCat}">${esc(c.emoji)} ${esc(c.name)}</button>`
                )
                .join("")}
            </div>
          </div>
          <div class="field">
            <label for="sp-desc">Note (optional)</label>
            <input id="sp-desc" placeholder="e.g. Groceries at Loblaws" value="${editing ? esc(editTxn.description || "") : ""}" />
          </div>
          <div class="field">
            <label for="sp-date">Date</label>
            <input id="sp-date" type="date" value="${editing ? esc(editTxn.date) : todayISO()}" />
          </div>
          <div class="field-row">
            <button class="btn btn-ghost" id="sp-cancel" style="flex:1;">Cancel</button>
            <button class="btn btn-primary" id="sp-save" style="flex:2;">${editing ? "Save changes" : "Save"}</button>
          </div>
        </div>
      </div>
    `);

    const amountEl = document.getElementById("sp-amount");
    amountEl.addEventListener("input", () => clearFieldError(amountEl));

    document.getElementById("sp-chips").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-cat]");
      if (!btn) return;
      selectedCat = btn.dataset.cat;
      document.querySelectorAll("#sp-chips .chip").forEach((c) => {
        const on = c.dataset.cat === selectedCat;
        c.classList.toggle("active", on);
        c.setAttribute("aria-pressed", on);
      });
    });

    const quickEl = document.getElementById("sp-quick");
    if (quickEl) {
      const hintEl = document.getElementById("sp-quick-hint");
      const applyQuick = () => {
        const parsed = parseQuickAdd(quickEl.value, cats);
        if (parsed.amount != null && !Number.isNaN(parsed.amount)) {
          amountEl.value = String(parsed.amount);
          clearFieldError(amountEl);
        }
        if (parsed.categoryId) {
          selectedCat = parsed.categoryId;
          document.querySelectorAll("#sp-chips .chip").forEach((c) => {
            const on = c.dataset.cat === selectedCat;
            c.classList.toggle("active", on);
            c.setAttribute("aria-pressed", on);
          });
        }
        if (parsed.note) document.getElementById("sp-desc").value = parsed.note;
        const cat = cats.find((c) => c.id === parsed.categoryId);
        if (parsed.amount != null || cat) {
          hintEl.innerHTML =
            `→ ${parsed.amount != null ? "<b>" + esc(fmt(parsed.amount)) + "</b>" : "<span class='qh-dim'>amount?</span>"}` +
            `${cat ? " · " + esc(cat.emoji) + " " + esc(cat.name) : " · <span class='qh-dim'>pick a category</span>"}`;
        } else {
          hintEl.innerHTML = "";
        }
      };
      quickEl.addEventListener("input", applyQuick);
      quickEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          applyQuick();
          document.getElementById("sp-save").click();
        }
      });
      setTimeout(() => { try { quickEl.focus(); } catch (e) {} }, 30);
    }

    document.getElementById("sp-cancel").addEventListener("click", close);

    document.getElementById("sp-save").addEventListener("click", () => {
      const amount = Number(amountEl.value);
      if (!amount || amount <= 0) {
        showFieldError(amountEl, "Enter an amount greater than zero.");
        return;
      }
      const fields = {
        categoryId: selectedCat,
        amount,
        description: document.getElementById("sp-desc").value.trim(),
        date: document.getElementById("sp-date").value || todayISO(),
      };
      const beforeOver = overBudgetIds(p);
      const beforeClose = closeIds(p);
      if (editing) {
        Object.assign(editTxn, fields, { editedAt: Date.now() });
      } else {
        p.transactions.push({ id: uid(), ...fields, editedAt: Date.now() });
      }
      save();
      // Editing from History (a closed period): just return to the detail view.
      if (afterSave) {
        close();
        afterSave();
        return;
      }
      const afterOver = overBudgetIds(p);
      const afterClose = closeIds(p);
      const newlyOver = p.categories.filter((c) => afterOver.has(c.id) && !beforeOver.has(c.id));
      const newlyClose = p.categories.filter(
        (c) => afterClose.has(c.id) && !beforeClose.has(c.id) && !afterOver.has(c.id)
      );
      close();
      render();
      if (newlyOver.length) {
        openOverBudgetAlert(p, newlyOver);
      } else if (newlyClose.length) {
        const c = newlyClose[0];
        const left = c.budgeted - catSpent(p, c.id);
        showToast(`👀 ${c.name} is almost tapped out — ${fmt(left)} left. You've got this!`);
      }
    });
  }

  /* Fires when logging spending pushes a category over its budget. */
  function openOverBudgetAlert(p, cats) {
    const detail = cats
      .map((c) => {
        const cs = catSpent(p, c.id);
        return `<li><b>${esc(c.emoji)} ${esc(c.name)}</b> — over by <b class="ob-amt">${fmt(cs - c.budgeted)}</b><br /><span class="ob-sub">${fmt(cs)} spent of ${fmt(c.budgeted)}</span></li>`;
      })
      .join("");

    const plural = cats.length > 1;
    const subject = `⚠️ Over budget: ${cats.map((c) => c.name).join(", ")}`;
    const body =
      `This budget has been exceeded in the following categor${plural ? "ies" : "y"}:\n\n` +
      cats
        .map((c) => {
          const cs = catSpent(p, c.id);
          return `• ${c.name}: spent ${fmt(cs)} of ${fmt(c.budgeted)} — over by ${fmt(cs - c.budgeted)}`;
        })
        .join("\n") +
      `\n\nPay period starting ${fmtDateLong(p.startDate)}.` +
      `\n\n— sent from Yosan`;

    const { close } = mountModal(`
      <div class="modal-overlay">
        <div class="modal" role="alertdialog" aria-modal="true" aria-label="Over budget alert">
          <div class="ob-head">⚠️</div>
          <h2 style="text-align:center;">Over budget</h2>
          <p class="sub" style="text-align:center;">Heads up — this spending puts ${plural ? "these categories" : "this category"} over budget.</p>
          <ul class="ob-list">${detail}</ul>
          <button class="btn btn-primary btn-block" id="ob-email">✉️ Email this alert</button>
          <p class="footer-note" style="margin:8px 0 14px;">Opens a pre-filled draft you can send to anyone.</p>
          <button class="btn btn-ghost btn-block" id="ob-dismiss">Dismiss</button>
        </div>
      </div>
    `);

    document.getElementById("ob-email").addEventListener("click", () => {
      const href =
        "mailto:" +
        REPORT_EMAILS.join(",") +
        "?subject=" +
        encodeURIComponent(subject) +
        "&body=" +
        encodeURIComponent(body);
      window.location.href = href;
    });
    document.getElementById("ob-dismiss").addEventListener("click", close);
  }

  /* ---------- New payday confirmation ---------- */
  function confirmNewPayday(p) {
    const remaining = totalBudgeted(p) - totalSpent(p);
    const { close } = mountModal(`
      <div class="modal-overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Start a new pay period">
          <h2>Start a new pay period?</h2>
          <p class="sub">This closes your current budget and saves it to history. You had
            <b>${fmt(remaining)}</b> left across all categories.</p>
          <div class="field-row">
            <button class="btn btn-ghost" id="np-cancel" style="flex:1;">Not yet</button>
            <button class="btn btn-primary" id="np-go" style="flex:2;">Yes, I got paid</button>
          </div>
        </div>
      </div>
    `);
    document.getElementById("np-cancel").addEventListener("click", close);
    document.getElementById("np-go").addEventListener("click", () => {
      p.closed = true;
      p.closedAt = new Date().toISOString();
      save();
      close();
      render(); // no active period -> setup flow appears
    });
  }

  /* ---------- History ---------- */
  function renderHistory() {
    const periodsAll = state.periods.slice().reverse(); // newest first (incl. active)
    if (periodsAll.length === 0) {
      main.innerHTML = `<div class="empty"><div class="big">📊</div><h2>Nothing here yet</h2><p>Set up a pay period first — then review your history and export reports here.</p></div>`;
      return;
    }

    // Compact export/share card (no full-text preview).
    if (!state._reportId || !periodsAll.some((p) => p.id === state._reportId)) state._reportId = periodsAll[0].id;
    const rptSel = periodsAll.find((p) => p.id === state._reportId);
    const rpt = buildReport(rptSel);
    const canShare = typeof navigator !== "undefined" && !!navigator.share;
    const exportCard = `
      <div class="card">
        <h2>Export &amp; share</h2>
        <p class="sub">Pick a pay period, then email, copy, or download it.</p>
        <div class="field" style="margin-bottom:12px;">
          <label>Pay period</label>
          <select id="rp-period">${periodsAll.map((p) => `<option value="${p.id}" ${p.id === rptSel.id ? "selected" : ""}>${esc(fmtDateLong(p.startDate))}${p.closed ? "" : " (current)"}</option>`).join("")}</select>
        </div>
        ${canShare ? `<button class="btn btn-primary btn-block" id="rp-share" style="margin-bottom:10px;">📤 Share…</button>` : ""}
        <div class="field-row">
          <button class="btn btn-ghost" id="rp-email" style="flex:1;">✉️ Email</button>
          <button class="btn btn-ghost" id="rp-copy" style="flex:1;">📋 Copy</button>
          <button class="btn btn-ghost" id="rp-csv" style="flex:1;">⬇️ CSV</button>
        </div>
      </div>`;

    const closed = state.periods.filter((p) => p.closed).slice().reverse(); // newest first
    const hasHistory = closed.length > 0;
    const n = closed.length;
    const totalSaved = hasHistory ? totalSavedToDate() : 0;
    const avgSaved = hasHistory ? closed.reduce((s, p) => s + periodSaved(p), 0) / n : 0;
    const avgSpent = hasHistory ? closed.reduce((s, p) => s + totalSpent(p), 0) / n : 0;

    // Savings per period — oldest→newest, most recent 8.
    const chrono = closed.slice().reverse().slice(-8);
    const svals = chrono.map((p) => periodSaved(p));
    const smax = Math.max(1, ...svals.map((v) => Math.abs(v)));
    const chart = `<div class="savings-chart">${chrono
      .map((p, i) => {
        const v = svals[i];
        const h = Math.max(4, Math.round((Math.abs(v) / smax) * 100));
        return `<div class="sc-col"><div class="sc-track"><div class="sc-bar ${v < 0 ? "neg" : ""}" style="height:${h}%" title="${fmt(v)}"></div></div><div class="sc-x">${esc(fmtDateShort(p.startDate))}</div><div class="sc-v">${esc(fmtCompact(v))}</div></div>`;
      })
      .join("")}</div>`;

    // Overspend patterns across all closed periods.
    const overCount = {};
    closed.forEach((p) =>
      p.categories.forEach((c) => {
        if (c.budgeted > 0 && catSpent(p, c.id) > c.budgeted + 0.005) {
          const key = `${c.emoji}||${c.name}`;
          overCount[key] = (overCount[key] || 0) + 1;
        }
      })
    );
    const topOver = Object.entries(overCount).sort((a, b) => b[1] - a[1]).slice(0, 3);

    // Per-category spending averages across closed periods (closed is newest-first).
    const catStats = {};
    closed.forEach((p) =>
      p.categories.forEach((c) => {
        const key = `${c.emoji}||${c.name}`;
        const s = catStats[key] || (catStats[key] = { emoji: c.emoji, name: c.name, total: 0, count: 0, last: null });
        const cs = catSpent(p, c.id);
        s.total += cs;
        s.count += 1;
        if (s.last === null) s.last = cs; // first seen = most recent
      })
    );
    const patterns = Object.values(catStats)
      .map((s) => ({ ...s, avg: s.total / s.count }))
      .filter((s) => s.avg > 0.005)
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 6);
    const patternsCard = patterns.length
      ? `<div class="card">
           <h2>Spending patterns</h2>
           <p class="sub">Your average spend per pay period, by category (↑ higher than usual · ↓ lower).</p>
           <div class="pat-list">
             ${patterns
               .map((s) => {
                 const trend = s.last > s.avg * 1.15 ? "up" : s.last < s.avg * 0.85 ? "down" : "steady";
                 const arrow = trend === "up" ? "↑" : trend === "down" ? "↓" : "→";
                 return `<div class="pat-item">
                     <span class="pat-name">${esc(s.emoji)} ${esc(s.name)}</span>
                     <span class="pat-nums">avg <b>${fmt(s.avg)}</b> · last ${fmt(s.last)} <span class="pat-trend ${trend}">${arrow}</span></span>
                   </div>`;
               })
               .join("")}
           </div>
         </div>`
      : "";

    const goals = state.goals || [];
    const goalsCard = `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:${goals.length ? "10px" : "6px"};gap:8px;">
          <h2 style="margin:0;">Savings goals</h2>
          <button class="btn btn-ghost btn-sm" id="goal-add" style="margin:0;">+ Add goal</button>
        </div>
        ${
          goals.length
            ? goals
                .map((g) => {
                  const pct = g.target > 0 ? Math.min(100, (g.saved / g.target) * 100) : 0;
                  const done = g.target > 0 && g.saved >= g.target - 0.005;
                  return `<button type="button" class="goal" data-goal="${g.id}">
                     <div class="goal-top"><span class="goal-name">${esc(g.emoji || "🎯")} ${esc(g.name)}</span><span class="goal-nums">${fmt(g.saved)} / ${fmt(g.target)}</span></div>
                     <div class="bar"><div class="bar-fill ok" style="width:${pct}%"></div></div>
                     <div class="goal-sub">${done ? "Reached! 🎉" : fmt(g.target - g.saved) + " to go"}</div>
                   </button>`;
                })
                .join("")
            : `<p class="sub" style="margin:0;">No goals yet. Add one — a vacation, an emergency fund — and set money aside toward it over time.</p>`
        }
      </div>`;

    const items = closed
      .map((p) => {
        const spent = totalSpent(p);
        const saved = periodSaved(p);
        return `
        <div class="hist-item" data-id="${p.id}">
          <div>
            <div class="hist-date">${esc(fmtDateLong(p.startDate))}</div>
            <div class="hist-sub">Income ${fmt(periodIncome(p))} · spent ${fmt(spent)}</div>
          </div>
          <div class="hist-right">
            <div class="hist-saved ${saved >= 0 ? "pos" : "neg"}">${saved >= 0 ? "+" : ""}${fmt(saved)}</div>
            <div class="hist-sub">${saved >= 0 ? "saved" : "overspent"}</div>
          </div>
        </div>`;
      })
      .join("");

    main.innerHTML =
      (hasHistory
        ? `
      <div class="card">
        <div class="ins-label">Total saved to date</div>
        <div class="ins-amount ${totalSaved < 0 ? "neg" : ""}">${fmt(totalSaved)}</div>
        <div class="ins-sub">across ${n} pay period${n === 1 ? "" : "s"} · avg ${fmt(avgSaved)} saved · ${fmt(avgSpent)} spent</div>
      </div>
      <div class="card">
        <h2>Saved per period</h2>
        <p class="sub">Most recent ${chrono.length} period${chrono.length === 1 ? "" : "s"}.</p>
        ${chart}
      </div>
      ${
        topOver.length
          ? `<div class="card">
        <h2>Watch these</h2>
        <p class="sub">Categories you went over most often.</p>
        ${topOver
          .map(([k, c]) => {
            const [emoji, name] = k.split("||");
            return `<div class="ov-item"><span class="ov-name">${esc(emoji)} ${esc(name)}</span><span class="ov-count">${c}× over</span></div>`;
          })
          .join("")}
      </div>`
          : ""
      }
      ${patternsCard}
      <div class="card">
        <h2>Past pay periods</h2>
        <p class="sub">Tap one to see the details.</p>
        ${items}
      </div>`
        : `<div class="card"><h2>History</h2><p class="sub" style="margin:0;">Your saved totals, trends, and past pay periods appear here once you finish a pay period.</p></div>`) +
      exportCard +
      goalsCard;

    document.getElementById("rp-period").addEventListener("change", (e) => { state._reportId = e.target.value; render(); });
    const rpShare = document.getElementById("rp-share");
    if (rpShare) rpShare.addEventListener("click", async () => { try { await navigator.share({ title: rpt.subject, text: rpt.text }); } catch (e) {} });
    document.getElementById("rp-email").addEventListener("click", () => { window.location.href = "mailto:" + REPORT_EMAILS.join(",") + "?subject=" + encodeURIComponent(rpt.subject) + "&body=" + encodeURIComponent(rpt.text); });
    document.getElementById("rp-copy").addEventListener("click", async (e) => { const btn = e.currentTarget; try { await navigator.clipboard.writeText(rpt.text); } catch { const ta = document.createElement("textarea"); ta.value = rpt.text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch {} document.body.removeChild(ta); } const orig = btn.textContent; btn.textContent = "✓ Copied"; setTimeout(() => (btn.textContent = orig), 1500); });
    document.getElementById("rp-csv").addEventListener("click", () => { exportCSV(rptSel); showToast("CSV downloaded ✓"); });

    main.querySelectorAll(".hist-item").forEach((el) =>
      el.addEventListener("click", () => openHistoryDetail(el.dataset.id))
    );
    const ga = document.getElementById("goal-add");
    if (ga) ga.addEventListener("click", () => openGoalEdit(null));
    main.querySelectorAll("[data-goal]").forEach((el) =>
      el.addEventListener("click", () => openGoalDetail(el.dataset.goal))
    );
  }

  function fmtDateShort(iso) {
    try {
      return parseDate(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    } catch {
      return iso;
    }
  }

  /* ---------- Savings goal ---------- */
  // Goal detail: add money toward it, or edit/delete it.
  function openGoalDetail(id) {
    const g = (state.goals || []).find((x) => x.id === id);
    if (!g) return;
    const pct = g.target > 0 ? Math.min(100, (g.saved / g.target) * 100) : 0;
    const done = g.target > 0 && g.saved >= g.target - 0.005;
    const { close } = mountModal(`
      <div class="modal-overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Savings goal">
          <h2>${esc(g.emoji || "🎯")} ${esc(g.name)}</h2>
          <p class="sub">${fmt(g.saved)} of ${fmt(g.target)} · ${done ? "reached 🎉" : fmt(g.target - g.saved) + " to go"}</p>
          <div class="bar" style="margin-bottom:16px;"><div class="bar-fill ok" style="width:${pct}%"></div></div>
          <div class="field money-input">
            <label for="gc-amt">Add money to this goal</label>
            <input id="gc-amt" type="number" inputmode="decimal" placeholder="0.00" step="0.01" />
          </div>
          <button class="btn btn-primary btn-block" id="gc-add">Add contribution</button>
          <div class="field-row" style="margin-top:12px;">
            <button class="btn btn-ghost" id="gc-edit" style="flex:1;">Edit</button>
            <button class="btn btn-danger" id="gc-del" style="flex:1;">Delete</button>
          </div>
          <button class="btn btn-ghost btn-block" id="gc-close" style="margin-top:8px;">Close</button>
        </div>
      </div>
    `);
    const amtEl = document.getElementById("gc-amt");
    amtEl.addEventListener("input", () => clearFieldError(amtEl));
    document.getElementById("gc-add").addEventListener("click", () => {
      const v = Number(amtEl.value);
      if (!v || v <= 0) {
        showFieldError(amtEl, "Enter an amount greater than zero.");
        return;
      }
      g.saved = Math.max(0, (Number(g.saved) || 0) + v);
      save();
      close();
      render();
      showToast(`Added ${fmt(v)} to ${g.name} 🎯`);
    });
    document.getElementById("gc-close").addEventListener("click", close);
    document.getElementById("gc-edit").addEventListener("click", () => {
      close();
      openGoalEdit(id);
    });
    document.getElementById("gc-del").addEventListener("click", () => {
      if (confirm(`Delete the "${g.name}" goal?`)) {
        state.goals = (state.goals || []).filter((x) => x.id !== id);
        save();
        close();
        render();
      }
    });
  }

  // Create a new goal (id null) or edit an existing one.
  function openGoalEdit(id) {
    const g = id ? (state.goals || []).find((x) => x.id === id) : null;
    const editing = !!g;
    const { close } = mountModal(`
      <div class="modal-overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="${editing ? "Edit goal" : "New goal"}">
          <h2>${editing ? "Edit goal" : "New savings goal"}</h2>
          <p class="sub">Give it a name and a target, then add money toward it whenever you like.</p>
          <div class="field-row">
            <div class="field" style="flex:0 0 72px;">
              <label for="g-emoji">Icon</label>
              <input id="g-emoji" class="emoji-in" maxlength="2" value="${esc(g ? g.emoji || "🎯" : "🎯")}" style="width:100%;text-align:center;" />
            </div>
            <div class="field" style="flex:1;">
              <label for="g-name">Name</label>
              <input id="g-name" placeholder="e.g. Trip to Japan" value="${esc(g ? g.name : "")}" />
            </div>
          </div>
          <div class="field money-input">
            <label for="g-target">Target amount</label>
            <input id="g-target" type="number" inputmode="decimal" placeholder="0.00" step="0.01" value="${g && g.target != null ? esc(g.target) : ""}" />
          </div>
          ${
            editing
              ? `<div class="field money-input"><label for="g-saved">Saved so far</label>
                   <input id="g-saved" type="number" inputmode="decimal" placeholder="0.00" step="0.01" value="${esc(g.saved || 0)}" /></div>`
              : ""
          }
          <div class="field-row">
            <button class="btn btn-ghost" id="g-cancel" style="flex:1;">Cancel</button>
            <button class="btn btn-primary" id="g-save" style="flex:2;">${editing ? "Save" : "Create goal"}</button>
          </div>
        </div>
      </div>
    `);
    const targetEl = document.getElementById("g-target");
    targetEl.addEventListener("input", () => clearFieldError(targetEl));
    document.getElementById("g-cancel").addEventListener("click", close);
    document.getElementById("g-save").addEventListener("click", () => {
      const target = Number(targetEl.value);
      if (!target || target <= 0) {
        showFieldError(targetEl, "Enter a target greater than zero.");
        return;
      }
      const emoji = document.getElementById("g-emoji").value.trim() || "🎯";
      const name = document.getElementById("g-name").value.trim() || "Savings goal";
      if (editing) {
        g.emoji = emoji;
        g.name = name;
        g.target = target;
        const sv = document.getElementById("g-saved");
        if (sv) g.saved = Math.max(0, Number(sv.value) || 0);
      } else {
        if (!Array.isArray(state.goals)) state.goals = [];
        state.goals.push({ id: uid(), emoji, name, target, saved: 0 });
      }
      save();
      close();
      render();
    });
  }

  function fmtDateLong(iso) {
    try {
      return parseDate(iso).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return iso;
    }
  }

  function openHistoryDetail(id) {
    const p = state.periods.find((x) => x.id === id);
    if (!p) return;
    const spent = totalSpent(p);
    const catById = Object.fromEntries(p.categories.map((c) => [c.id, c]));
    // Re-render the History list and reopen this detail (used after an edit/delete).
    const reopen = () => {
      render();
      openHistoryDetail(id);
    };

    const catSummary = p.categories
      .map((c) => {
        const cs = catSpent(p, c.id);
        const over = cs > c.budgeted + 0.005;
        return `<div class="cat-row"><div class="cat-top">
          <span class="cat-name"><span class="cat-emoji">${esc(c.emoji)}</span>${esc(c.name)}</span>
          <span class="cat-amounts ${over ? "over" : ""}"><b>${fmt(cs)}</b> of ${fmt(c.budgeted)}</span>
        </div></div>`;
      })
      .join("");

    const txns = [...p.transactions].sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));
    const txnList = txns.length
      ? txns
          .map((t) => {
            const c = catById[t.categoryId] || { emoji: "❓", name: "Uncategorized" };
            return `
          <div class="txn" data-id="${t.id}">
            <button type="button" class="txn-left txn-edit" data-edit="${t.id}" aria-label="Edit ${esc(t.description || c.name)}">
              <div class="txn-emoji">${esc(c.emoji)}</div>
              <div>
                <div class="txn-desc">${esc(t.description || c.name)}</div>
                <div class="txn-meta">${esc(c.name)} · ${esc(fmtDateShort(t.date))}</div>
              </div>
            </button>
            <div style="display:flex;align-items:center;">
              <span class="txn-amt">${fmt(t.amount)}</span>
              <button class="rm" data-rm="${t.id}" title="Delete" aria-label="Delete ${esc(t.description || c.name)}">🗑</button>
            </div>
          </div>`;
          })
          .join("")
      : `<p class="sub" style="margin-top:8px;">No transactions recorded.</p>`;

    const { close } = mountModal(`
      <div class="modal-overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Pay period details">
          <h2>${esc(fmtDateLong(p.startDate))}</h2>
          <p class="sub">Paid ${fmt(p.paycheckAmount)} · ${freqLabel(p.frequency)} · spent ${fmt(spent)}</p>
          ${catSummary}
          <div class="divider"></div>
          <div class="section-label" style="display:flex;justify-content:space-between;align-items:center;">
            <span>Transactions</span>
            <button class="btn btn-ghost btn-sm" id="hist-add" style="margin:0;">+ Add</button>
          </div>
          <p class="footer-note" style="margin:2px 0 6px;">Tap a transaction to edit it, or 🗑 to remove it.</p>
          <div class="hist-txns">${txnList}</div>
          <div class="divider"></div>
          <button class="btn btn-danger btn-block btn-sm" id="hist-del">Delete this record</button>
          <button class="btn btn-ghost btn-block" id="hist-close" style="margin-top:8px;">Close</button>
        </div>
      </div>
    `);

    document.getElementById("hist-close").addEventListener("click", close);
    document.getElementById("hist-add").addEventListener("click", () => openSpendModal(p, null, null, reopen));
    modalRoot.querySelectorAll("[data-edit]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const t = p.transactions.find((x) => x.id === btn.dataset.edit);
        if (t) openSpendModal(p, null, t, reopen);
      })
    );
    modalRoot.querySelectorAll("[data-rm]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const res = deleteTxn(p, btn.dataset.rm);
        if (!res) return;
        save();
        reopen();
        showToast("Transaction deleted", "Undo", () => {
          restoreTxn(p, res.removed, res.idx);
          save();
          reopen();
        });
      })
    );
    document.getElementById("hist-del").addEventListener("click", () => {
      if (confirm("Delete this pay period record permanently?")) {
        state.periods = state.periods.filter((x) => x.id !== id);
        save();
        close();
        render();
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Report — auto-generate a summary and send it via share/email/copy
   * ------------------------------------------------------------------ */
  function buildReport(p) {
    const budgeted = totalBudgeted(p);
    const spent = totalSpent(p);
    const remaining = budgeted - spent;
    const saved = periodIncome(p) - spent;
    const unbudgeted = periodIncome(p) - budgeted;
    const active = !p.closed;
    const dl = daysLeft(p);

    const pad = (label, value) => label.padEnd(13) + value;

    const catLines = p.categories
      .slice()
      .sort((a, b) => catSpent(p, b.id) - catSpent(p, a.id))
      .map((c) => {
        const cs = catSpent(p, c.id);
        const diff = c.budgeted - cs;
        const flag = cs > c.budgeted + 0.005 ? "🔴" : cs > c.budgeted * 0.85 ? "⚠️" : "✅";
        const tail =
          diff < -0.005 ? `${fmt(-diff)} over` : `${fmt(diff)} left`;
        return `${flag} ${c.emoji} ${c.name}\n     ${fmt(cs)} of ${fmt(c.budgeted)}  ·  ${tail}`;
      })
      .join("\n");

    const status = remaining < -0.005 ? "🔴 over budget" : "✅ within budget";

    const lines = [
      `Yosan — ${PERSON_NAME}'s Summary`,
      `Pay period starting ${fmtDateLong(p.startDate)}`,
      `${freqLabel(p.frequency)}${active ? ` · ${dl} ${dl === 1 ? "day" : "days"} left` : " · closed"}`,
      "",
      pad("Income", fmt(periodIncome(p))),
      pad("Budgeted", fmt(budgeted)),
      pad("Spent", fmt(spent)),
      pad(active ? "Remaining" : "Left over", `${fmt(active ? remaining : saved)}  ${status}`),
      pad(unbudgeted >= 0 ? "Unbudgeted" : "Over budget", fmt(Math.abs(unbudgeted))),
      "",
      "By category (most spent first):",
      catLines || "  (no spending yet)",
      "",
      `Generated ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`,
    ];

    const subject = `Budget summary — ${fmtDateLong(p.startDate)} (${fmt(spent)} spent)`;
    return { subject, text: lines.join("\n") };
  }

  // Build a spreadsheet-friendly CSV of a period's transactions.
  function buildCSV(p) {
    const catById = Object.fromEntries(p.categories.map((c) => [c.id, c]));
    const cell = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const rows = [["Date", "Category", "Description", "Amount", "Type"]];
    [...p.transactions]
      .sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id))
      .forEach((t) => {
        const c = catById[t.categoryId] || { name: "Uncategorized", fixed: false };
        rows.push([t.date, c.name, t.description || "", Number(t.amount).toFixed(2), c.fixed ? "Fixed" : "Spending"]);
      });
    return rows.map((r) => r.map(cell).join(",")).join("\r\n");
  }

  function exportCSV(p) {
    // Prepend a BOM so Excel reads UTF-8 (emoji, accents) correctly.
    const blob = new Blob(["﻿" + buildCSV(p)], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payday-budget-${p.startDate}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderReport() {
    // Newest first: active period, then closed periods.
    const periods = state.periods.slice().reverse();
    if (periods.length === 0) {
      main.innerHTML = `<div class="empty"><div class="big">📊</div><h2>No report yet</h2><p>Set up a pay period first, then come back to generate a summary you can email or message.</p></div>`;
      return;
    }

    // Which period to report on — default to the newest.
    if (!state._reportId || !periods.some((p) => p.id === state._reportId)) {
      state._reportId = periods[0].id;
    }
    const selected = periods.find((p) => p.id === state._reportId);
    const { subject, text } = buildReport(selected);
    const canShare = typeof navigator !== "undefined" && !!navigator.share;

    main.innerHTML = `
      <div class="card">
        <h2>Summary report</h2>
        <p class="sub">Auto-generated from your budget. Send it however you like.</p>
        <div class="field">
          <label>Which pay period?</label>
          <select id="rp-period">
            ${periods
              .map(
                (p) =>
                  `<option value="${p.id}" ${p.id === selected.id ? "selected" : ""}>${esc(fmtDateLong(p.startDate))}${p.closed ? "" : " (current)"}</option>`
              )
              .join("")}
          </select>
        </div>

        <div class="report-preview">${esc(text)}</div>

        ${canShare ? `<button class="btn btn-primary btn-block" id="rp-share">📤 Share…</button>` : ""}
        <div class="field-row" style="margin-top:${canShare ? "10px" : "0"};">
          <button class="btn btn-ghost" id="rp-email" style="flex:1;">✉️ Email report</button>
          <button class="btn btn-ghost" id="rp-copy" style="flex:1;">📋 Copy</button>
        </div>
        <button class="btn btn-ghost btn-block" id="rp-csv" style="margin-top:10px;">⬇️ Export CSV</button>
        <p class="footer-note">"Email report" opens a draft to ${esc(REPORT_EMAILS.join(" and "))}. "Export CSV" downloads this period's transactions.</p>
      </div>
    `;

    document.getElementById("rp-period").addEventListener("change", (e) => {
      state._reportId = e.target.value;
      render();
    });

    const shareBtn = document.getElementById("rp-share");
    if (shareBtn) {
      shareBtn.addEventListener("click", async () => {
        try {
          await navigator.share({ title: subject, text });
        } catch (e) {
          /* user cancelled — ignore */
        }
      });
    }

    document.getElementById("rp-email").addEventListener("click", () => {
      // Comma-separated recipients go in the mailto path (not percent-encoded).
      const href =
        "mailto:" +
        REPORT_EMAILS.join(",") +
        "?subject=" +
        encodeURIComponent(subject) +
        "&body=" +
        encodeURIComponent(text);
      window.location.href = href;
    });

    document.getElementById("rp-copy").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Fallback for insecure contexts / older browsers.
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch {}
        document.body.removeChild(ta);
      }
      const orig = btn.textContent;
      btn.textContent = "✓ Copied";
      setTimeout(() => (btn.textContent = orig), 1500);
    });

    document.getElementById("rp-csv").addEventListener("click", () => {
      exportCSV(selected);
      showToast("CSV downloaded ✓");
    });
  }

  /* ------------------------------------------------------------------ *
   * Shared Results — combined monthly totals + category breakdown
   * ------------------------------------------------------------------ */
  function monthLabel(mk) {
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const parts = String(mk).split("-");
    return (names[Number(parts[1]) - 1] || "") + " " + parts[0];
  }

  function renderResults() {
    if (!cloudOn()) {
      main.innerHTML = `<div class="card"><h2>Shared results</h2><p class="sub">Cloud sync isn't available right now — reconnect to see combined monthly results.</p></div>`;
      return;
    }
    if (!cloudUser) {
      main.innerHTML = `<div class="card"><h2>Shared results</h2><p class="sub">Sign in to see your and ${esc(PARTNER_NAME)}'s combined monthly results.</p><button class="btn btn-primary btn-block" id="rs-signin">☁️ Sign in to sync</button></div>`;
      const b = document.getElementById("rs-signin");
      if (b) b.addEventListener("click", () => openLogin(false));
      return;
    }

    const k = resultsCache.kelly;
    const d = resultsCache.derek;
    const monthSet = {};
    [k, d].forEach((doc) => {
      if (doc && doc.months) doc.months.forEach((m) => (monthSet[m.month] = true));
    });
    const months = Object.keys(monthSet).sort().reverse();

    if (!months.length) {
      main.innerHTML = `<div class="card"><h2>Shared results</h2><p class="sub">No results yet. Once you both have a budget going, each month's totals show up here.</p></div>`;
      return;
    }

    const sel = state._resultsMonth && monthSet[state._resultsMonth] ? state._resultsMonth : months[0];
    // Show the selected month for each person, or fall back to their own latest month —
    // pay cycles don't always line up to the same calendar month.
    const pick = (doc) => {
      if (!doc || !doc.months || !doc.months.length) return null;
      return doc.months.find((m) => m.month === sel) || doc.months[0];
    };
    const km = pick(k);
    const dm = pick(d);
    const combinedSaved = (km ? km.saved : 0) + (dm ? dm.saved : 0);

    const personCard = (title, m) => {
      if (!m)
        return `<div class="card"><h3>${esc(title)}</h3><p class="sub">No budget recorded yet — nothing has synced from them.</p></div>`;
      const monthTag = `<span class="rs-month-tag">${monthLabel(m.month)}</span>`;
      const cats = m.categories
        .slice()
        .sort((a, b) => b.spent - a.spent)
        .map(
          (c) => `
            <div class="rs-cat">
              <span class="rs-cat-name">${esc(c.emoji || "")} ${esc(c.name)}</span>
              <span class="rs-cat-amt">${fmt(c.spent)} <span class="rs-of">of ${fmt(c.budgeted)}</span></span>
            </div>`
        )
        .join("");
      return `
        <div class="card">
          <h3 style="margin-bottom:6px;">${esc(title)} ${monthTag}</h3>
          <div class="rs-grid">
            <div><span class="rs-k">Income</span><b>${fmt(m.income)}</b></div>
            <div><span class="rs-k">Spent</span><b>${fmt(m.spent)}</b></div>
            <div><span class="rs-k">Saved</span><b class="${m.saved >= 0 ? "rs-pos" : "rs-neg"}">${fmt(m.saved)}</b></div>
          </div>
          <div class="rs-cats">${cats || '<p class="sub">No categories.</p>'}</div>
        </div>`;
    };

    main.innerHTML = `
      <div class="card">
        <h2>Shared results</h2>
        <div class="field" style="margin-bottom:10px;">
          <select id="rs-month">
            ${months.map((mk) => `<option value="${mk}" ${mk === sel ? "selected" : ""}>${monthLabel(mk)}</option>`).join("")}
          </select>
        </div>
        <div class="rs-combined">Combined saved <b class="${combinedSaved >= 0 ? "rs-pos" : "rs-neg"}">${fmt(combinedSaved)}</b></div>
      </div>
      ${personCard((k && k.name) || "Kelly", km)}
      ${personCard((d && d.name) || "Derek", dm)}
    `;

    const monthSel = document.getElementById("rs-month");
    if (monthSel)
      monthSel.addEventListener("change", (e) => {
        state._resultsMonth = e.target.value;
        renderResults();
      });
  }

  /* ------------------------------------------------------------------ *
   * Settings — back up (export) and restore (import) all data
   * ------------------------------------------------------------------ */
  function exportData() {
    const payload = JSON.stringify(state, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payday-budget-backup-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    try {
      localStorage.setItem(STORAGE_KEY + "-lastbackup", String(Date.now()));
    } catch (e) {}
  }

  // Human-friendly "last backup" line for Settings.
  function lastBackupLabel() {
    const ts = Number(localStorage.getItem(STORAGE_KEY + "-lastbackup") || 0);
    if (!ts) return "No backup downloaded yet";
    const days = Math.floor((Date.now() - ts) / 86400000);
    if (days <= 0) return "Last backup: today";
    if (days === 1) return "Last backup: yesterday";
    return `Last backup: ${days} days ago`;
  }

  function isValidBackup(obj) {
    return obj && typeof obj === "object" && Array.isArray(obj.periods);
  }

  function importData(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      showToast("That file isn't a valid backup.");
      return;
    }
    if (!isValidBackup(parsed)) {
      showToast("That file doesn't look like a Yosan backup.");
      return;
    }
    const periods = parsed.periods.length;
    if (
      !confirm(
        `Restore this backup? It has ${periods} pay period${periods === 1 ? "" : "s"} and will REPLACE everything currently in the app.`
      )
    )
      return;
    state = migrateState(Object.assign(defaultState(), parsed));
    state.view = "dashboard";
    save();
    render();
    showToast("Backup restored ✓");
  }

  function openSettings() {
    const periods = state.periods.length;
    const txns = state.periods.reduce((s, p) => s + p.transactions.length, 0);
    const cloudBlock = !cloudOn()
      ? ""
      : cloudUser
      ? `<div class="settings-stat">☁️ Synced as ${esc(currentEmail())}</div>
         <button class="btn btn-ghost btn-block btn-sm" id="set-signout">Sign out</button>
         <div class="divider"></div>`
      : `<button class="btn btn-primary btn-block" id="set-signin">☁️ Sign in to sync</button>
         <p class="footer-note" style="margin:8px 0 16px;">Sync this budget across devices and share monthly results.</p>`;
    const { close } = mountModal(`
      <div class="modal-overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Settings and backup">
          <h2>Settings &amp; backup</h2>
          <p class="sub">Your budget lives only on this device. Back it up so you never lose it if you clear your browser or switch phones.</p>

          <div class="settings-stat">${periods} pay period${periods === 1 ? "" : "s"} · ${txns} transaction${txns === 1 ? "" : "s"} stored</div>
          ${cloudBlock}

          <div class="vac-row">
            <div class="vac-copy">
              <div class="vac-title">🏖️ Vacation Mode</div>
              <div class="vac-note">Run a separate vacation budget alongside your pay period.</div>
            </div>
            <label class="switch" title="Toggle Vacation Mode">
              <input type="checkbox" id="set-vacation" ${state.vacationMode ? "checked" : ""} />
              <span class="switch-track" aria-hidden="true"></span>
            </label>
          </div>
          <div class="divider"></div>

          <button class="btn btn-primary btn-block" id="set-export">⬇️ Download backup</button>
          <p class="footer-note" style="margin:8px 0 16px;">${esc(lastBackupLabel())} · saves a <code>.json</code> file you can keep safe or move to another device.</p>

          <label class="btn btn-ghost btn-block" for="set-import-file" style="cursor:pointer;">⬆️ Restore from backup</label>
          <input type="file" id="set-import-file" accept="application/json,.json" style="position:absolute;width:1px;height:1px;opacity:0;" />
          <p class="footer-note" style="margin:8px 0 16px;">Restoring replaces everything currently in the app.</p>

          <div class="divider"></div>
          <button class="btn btn-danger btn-block btn-sm" id="set-reset">Erase all data</button>
          <button class="btn btn-ghost btn-block" id="set-close" style="margin-top:8px;">Close</button>
          <p class="footer-note" style="margin-top:14px;">Version ${esc(APP_VERSION)}</p>
        </div>
      </div>
    `);

    const signInBtn = document.getElementById("set-signin");
    if (signInBtn)
      signInBtn.addEventListener("click", () => {
        close();
        openLogin(false);
      });
    const signOutBtn = document.getElementById("set-signout");
    if (signOutBtn)
      signOutBtn.addEventListener("click", () => {
        Cloud.signOut();
        close();
        showToast("Signed out — syncing off");
      });

    const vacToggle = document.getElementById("set-vacation");
    if (vacToggle)
      vacToggle.addEventListener("change", () => {
        state.vacationMode = vacToggle.checked;
        if (!state.vacationMode) state.activeBudget = "payday";
        save();
        render();
        showToast(state.vacationMode ? "Vacation Mode on 🏖️" : "Vacation Mode off");
      });

    document.getElementById("set-export").addEventListener("click", exportData);

    document.getElementById("set-import-file").addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        close();
        importData(String(reader.result));
      };
      reader.onerror = () => showToast("Couldn't read that file.");
      reader.readAsText(file);
    });

    document.getElementById("set-reset").addEventListener("click", () => {
      if (
        confirm(
          "Erase ALL data permanently? This can't be undone. Download a backup first if you're not sure."
        )
      ) {
        state = defaultState();
        save();
        close();
        render();
        showToast("All data erased.");
      }
    });

    document.getElementById("set-close").addEventListener("click", close);
  }

  /* ------------------------------------------------------------------ *
   * Cloud sync (Firebase) — optional; app works fully without it.
   * ------------------------------------------------------------------ */
  const cloudOn = () => !!(window.Cloud && Cloud.available);
  const currentEmail = () => (cloudUser && cloudUser.email ? cloudUser.email : null);

  function initCloud() {
    if (!cloudOn()) return; // SDK didn't load (e.g. offline) → stay local
    Cloud.init();
    Cloud.onAuth((user) => {
      cloudUser = user || null;
      if (user) startSync();
      else stopSync();
      if (firstAuth) {
        firstAuth = false;
        // Prompt new visitors to sign in once; returning users are auto-signed-in.
        if (!user && !localStorage.getItem("pb-login-prompted")) {
          localStorage.setItem("pb-login-prompted", "1");
          openLogin(true);
        }
      }
    });
  }

  function startSync() {
    if (cloudUnsub) return;
    cloudUnsub = Cloud.watchBudget(BUDGET_KEY, onRemoteBudget);
    ["kelly", "derek"].forEach((who) => {
      resultsUnsub.push(
        Cloud.watchResults(who, (doc) => {
          resultsCache[who] = doc;
          if (state.view === "results") renderResults();
        })
      );
    });
  }

  function stopSync() {
    if (cloudUnsub) {
      cloudUnsub();
      cloudUnsub = null;
    }
    resultsUnsub.forEach((fn) => fn && fn());
    resultsUnsub = [];
    resultsCache.kelly = null;
    resultsCache.derek = null;
  }

  function publishOwnResults() {
    if (cloudUser) Cloud.saveResults(BUDGET_KEY, computeResults());
  }

  // A remote budget doc arrived (initial load or the other person edited).
  function onRemoteBudget(remote) {
    const localAt = state.updatedAt || 0;
    if (!remote) {
      pushCloud(); // cloud is empty — seed it from this device (also publishes results)
      resultsSeeded = true;
      return;
    }
    const remoteAt = remote.updatedAt || 0;
    if (remoteAt > localAt && remote.data) {
      adoptRemote(remote);
    } else if (localAt > remoteAt) {
      pushCloud(); // our local copy is newer — push it up
    }
    // Make sure our results summary is published at least once after first sync,
    // even if the budget was already up to date (no edit to trigger a push).
    if (!resultsSeeded) {
      publishOwnResults();
      resultsSeeded = true;
    }
  }

  function adoptRemote(remote) {
    const localState = state;
    const keepView = state.view;
    const keepReport = state._reportId;
    const merged = migrateState(Object.assign(defaultState(), remote.data));
    mergePeriods(localState, merged); // union periods + merge transactions (no lost logs)
    merged.view = keepView; // don't yank the other person's tab around
    if (keepReport) merged._reportId = keepReport;
    merged.updatedAt = remote.updatedAt;
    state = merged;
    persistLocal();
    render();
    if (remote.updatedBy && remote.updatedBy !== currentEmail()) {
      showToast("☁️ Budget updated from the cloud");
    }
  }

  function pushCloud() {
    if (!cloudUser) return;
    if (!state.updatedAt) state.updatedAt = Date.now();
    const data = JSON.parse(JSON.stringify(state));
    delete data.view; // per-device UI, not shared
    delete data._reportId;
    delete data._resultsMonth;
    delete data._spendFilter;
    Cloud.saveBudget(BUDGET_KEY, {
      data: data,
      updatedAt: state.updatedAt,
      updatedBy: currentEmail() || "",
    });
    Cloud.saveResults(BUDGET_KEY, computeResults());
  }

  function schedulePush() {
    if (!cloudUser) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushCloud, 700);
  }

  function friendlyAuthError(e) {
    const code = (e && e.code) || "";
    if (code === "auth/invalid-email") return "That doesn't look like a valid email.";
    if (code === "auth/user-not-found" || code === "auth/wrong-password" || code === "auth/invalid-credential")
      return "Email or password isn't right.";
    if (code === "auth/too-many-requests") return "Too many tries — wait a minute and retry.";
    if (code === "auth/network-request-failed") return "Network problem — check your connection.";
    return "Couldn't sign in. Please try again.";
  }

  function openLogin(firstTime) {
    const { close } = mountModal(`
      <div class="modal-overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Sign in to sync">
          <h2>${firstTime ? "Sync across devices" : "Sign in"}</h2>
          <p class="sub">Sign in to sync this budget between phones and share monthly results. It keeps working offline either way.</p>
          <div class="field">
            <label for="lg-email">Email</label>
            <input id="lg-email" type="email" autocomplete="username" placeholder="you@example.com" />
          </div>
          <div class="field">
            <label for="lg-pass">Password</label>
            <input id="lg-pass" type="password" autocomplete="current-password" placeholder="Your password" />
          </div>
          <div id="lg-err" class="field-error" style="display:none;"></div>
          <button class="btn btn-primary btn-block" id="lg-go">Sign in</button>
          <button class="btn btn-ghost btn-block" id="lg-skip" style="margin-top:8px;">Not now — use only on this device</button>
        </div>
      </div>
    `);
    const err = document.getElementById("lg-err");
    const go = document.getElementById("lg-go");
    const emailEl = document.getElementById("lg-email");
    const passEl = document.getElementById("lg-pass");

    document.getElementById("lg-skip").addEventListener("click", close);

    const submit = () => {
      const email = emailEl.value.trim();
      const pass = passEl.value;
      if (!email || !pass) {
        err.style.display = "block";
        err.textContent = "Enter your email and password.";
        return;
      }
      go.disabled = true;
      go.textContent = "Signing in…";
      err.style.display = "none";
      Cloud.signIn(email, pass)
        .then(() => {
          close();
          showToast("☁️ Signed in — syncing on");
        })
        .catch((e) => {
          go.disabled = false;
          go.textContent = "Sign in";
          err.style.display = "block";
          err.textContent = friendlyAuthError(e);
        });
    };
    go.addEventListener("click", submit);
    passEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
  }

  /* ------------------------------------------------------------------ *
   * Tab navigation
   * ------------------------------------------------------------------ */
  document.getElementById("tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    state.view = tab.dataset.view;
    render();
  });

  const settingsBtn = document.getElementById("settings-btn");
  if (settingsBtn) settingsBtn.addEventListener("click", openSettings);

  const budgetSwitchEl = document.getElementById("budget-switch");
  if (budgetSwitchEl)
    budgetSwitchEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-bud]");
      if (!btn) return;
      state.activeBudget = btn.dataset.bud === "vacation" ? "vacation" : "payday";
      state.view = "dashboard";
      save();
      render();
    });

  const headerLogBtn = document.getElementById("header-log");
  if (headerLogBtn)
    headerLogBtn.addEventListener("click", () => {
      const p = activePeriod();
      if (p) openSpendModal(p);
    });

  const headerAddBtn = document.getElementById("header-add");
  if (headerAddBtn)
    headerAddBtn.addEventListener("click", () => {
      const p = activePeriod();
      if (p) openQuickAdd(p);
    });

  /* Boot */
  render();
  initCloud();
})();
