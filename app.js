/* Payday Budget — set your budget once each time you're paid.
 * Pure vanilla JS. State persists in localStorage. No backend. */

(function () {
  "use strict";

  const STORAGE_KEY = "payday-budget-v1";

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  const defaultState = () => ({
    periods: [],          // list of pay periods, newest last
    template: null,       // remembered category layout for the next payday
    view: "dashboard",
  });

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return Object.assign(defaultState(), parsed);
    } catch (e) {
      console.warn("Failed to load state, starting fresh.", e);
      return defaultState();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error("Failed to save state", e);
    }
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */
  const uid = () =>
    Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const fmt = (n) =>
    "$" +
    Number(n || 0).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const fmtShort = (n) => {
    const v = Number(n || 0);
    return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  };

  const todayISO = () => new Date().toISOString().slice(0, 10);

  function parseDate(iso) {
    // Treat ISO date as local, not UTC, to avoid off-by-one.
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function frequencyDays(freq) {
    return { weekly: 7, biweekly: 14, semimonthly: 15, monthly: 30 }[freq] || 14;
  }

  function periodEnd(period) {
    const start = parseDate(period.startDate);
    const end = new Date(start);
    end.setDate(end.getDate() + frequencyDays(period.frequency));
    return end;
  }

  function daysLeft(period) {
    const end = periodEnd(period);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const ms = end - now;
    return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
  }

  function activePeriod() {
    const p = state.periods[state.periods.length - 1];
    return p && !p.closed ? p : null;
  }

  function catSpent(period, catId) {
    return period.transactions
      .filter((t) => t.categoryId === catId)
      .reduce((s, t) => s + Number(t.amount), 0);
  }

  const totalBudgeted = (p) => p.categories.reduce((s, c) => s + Number(c.budgeted), 0);
  const totalSpent = (p) => p.transactions.reduce((s, t) => s + Number(t.amount), 0);

  const freqLabel = (f) =>
    ({ weekly: "Weekly", biweekly: "Every 2 weeks", semimonthly: "Twice a month", monthly: "Monthly" }[f] || f);

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  /* Default categories offered on first setup. */
  const STARTER_CATEGORIES = [
    { emoji: "🏠", name: "Rent / Housing", budgeted: "" },
    { emoji: "🛒", name: "Groceries", budgeted: "" },
    { emoji: "🚗", name: "Transport", budgeted: "" },
    { emoji: "🍽️", name: "Eating out", budgeted: "" },
    { emoji: "💡", name: "Bills & utilities", budgeted: "" },
    { emoji: "🎉", name: "Fun", budgeted: "" },
    { emoji: "💰", name: "Savings", budgeted: "" },
  ];

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */
  const main = document.getElementById("main");
  const modalRoot = document.getElementById("modal-root");

  function render() {
    // Sync tab highlight
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.view === state.view)
    );

    const period = activePeriod();

    if (!period) {
      // No active budget — force setup regardless of tab.
      renderSetup();
      return;
    }

    if (state.view === "dashboard") renderDashboard(period);
    else if (state.view === "spend") renderSpend(period);
    else if (state.view === "history") renderHistory();
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
        <p class="sub">Decide now where every dollar goes until your next paycheck.</p>
        <div id="alloc-list"></div>
        <button class="btn btn-ghost btn-sm" id="add-cat">+ Add category</button>

        <div class="alloc-summary">
          <span>Paycheck <b id="sum-paycheck">$0.00</b></span>
          <span>Left to budget <b class="remaining" id="sum-remaining">$0.00</b></span>
        </div>

        <button class="btn btn-primary btn-block" id="start-period">Start this pay period</button>
      </div>

      ${
        isFirst
          ? `<p class="footer-note">Everything is stored privately on this device.</p>`
          : `<p class="footer-note">Your last budget layout is pre-filled — tweak the amounts.</p>`
      }
    `;

    // Working copy of allocation rows
    let rows = template.categories.map((c) => ({
      id: uid(),
      emoji: c.emoji || "💵",
      name: c.name || "",
      budgeted: c.budgeted != null ? String(c.budgeted) : "",
    }));

    const listEl = document.getElementById("alloc-list");
    const paycheckEl = document.getElementById("paycheck");

    function drawRows() {
      listEl.innerHTML = rows
        .map(
          (r) => `
        <div class="alloc-item" data-id="${r.id}">
          <input class="emoji-in" data-f="emoji" value="${esc(r.emoji)}" maxlength="2" />
          <input class="name-in" data-f="name" placeholder="Category" value="${esc(r.name)}" />
          <div class="money-input amt-in">
            <input data-f="budgeted" type="number" inputmode="decimal" placeholder="0" step="0.01" value="${esc(r.budgeted)}" />
          </div>
          <button class="rm" data-rm="${r.id}" title="Remove">×</button>
        </div>`
        )
        .join("");
      updateSummary();
    }

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
      const item = e.target.closest(".alloc-item");
      if (!item) return;
      const row = rows.find((r) => r.id === item.dataset.id);
      if (!row) return;
      row[e.target.dataset.f] = e.target.value;
      if (e.target.dataset.f === "budgeted") updateSummary();
    });

    listEl.addEventListener("click", (e) => {
      const rm = e.target.dataset.rm;
      if (!rm) return;
      rows = rows.filter((r) => r.id !== rm);
      drawRows();
    });

    document.getElementById("add-cat").addEventListener("click", () => {
      rows.push({ id: uid(), emoji: "💵", name: "", budgeted: "" });
      drawRows();
      const last = listEl.querySelector(".alloc-item:last-child .name-in");
      if (last) last.focus();
    });

    paycheckEl.addEventListener("input", updateSummary);

    document.getElementById("start-period").addEventListener("click", () => {
      const paycheck = Number(paycheckEl.value);
      if (!paycheck || paycheck <= 0) {
        alert("Enter the amount you were paid.");
        paycheckEl.focus();
        return;
      }
      const cats = rows
        .filter((r) => r.name.trim() && Number(r.budgeted) > 0)
        .map((r) => ({
          id: uid(),
          emoji: r.emoji.trim() || "💵",
          name: r.name.trim(),
          budgeted: Number(r.budgeted),
        }));
      if (cats.length === 0) {
        alert("Add at least one budget category with an amount.");
        return;
      }

      // Close any dangling active period defensively (shouldn't happen here).
      const period = {
        id: uid(),
        paycheckAmount: paycheck,
        startDate: document.getElementById("startDate").value || todayISO(),
        frequency: document.getElementById("frequency").value,
        categories: cats,
        transactions: [],
        closed: false,
        createdAt: new Date().toISOString(),
      };
      state.periods.push(period);
      // Remember layout (names/emojis, not amounts) for next payday.
      state.template = {
        frequency: period.frequency,
        categories: cats.map((c) => ({ emoji: c.emoji, name: c.name, budgeted: c.budgeted })),
      };
      state.view = "dashboard";
      save();
      render();
    });

    drawRows();
  }

  /* ---------- Dashboard ---------- */
  function renderDashboard(p) {
    const budgeted = totalBudgeted(p);
    const spent = totalSpent(p);
    const remaining = budgeted - spent;
    const unbudgeted = p.paycheckAmount - budgeted;
    const dl = daysLeft(p);
    const perDay = dl > 0 ? remaining / dl : remaining;

    const cats = p.categories
      .map((c) => {
        const cs = catSpent(p, c.id);
        const pct = c.budgeted > 0 ? (cs / c.budgeted) * 100 : 0;
        const cls = pct > 100 ? "over" : pct > 85 ? "warn" : "ok";
        const over = cs > c.budgeted + 0.005;
        return `
        <div class="cat-row">
          <div class="cat-top">
            <span class="cat-name"><span class="cat-emoji">${esc(c.emoji)}</span>${esc(c.name)}</span>
            <span class="cat-amounts ${over ? "over" : ""}">
              <b>${fmt(cs)}</b> of ${fmt(c.budgeted)}
              <br />${over ? fmt(cs - c.budgeted) + " over" : fmt(c.budgeted - cs) + " left"}
            </span>
          </div>
          <div class="bar"><div class="bar-fill ${cls}" style="width:${Math.min(100, pct)}%"></div></div>
        </div>`;
      })
      .join("");

    main.innerHTML = `
      <div class="card hero">
        <div class="label">Left to spend</div>
        <div class="amount">${fmt(remaining)}</div>
        <div class="period-meta">of ${fmt(budgeted)} budgeted · paid ${fmtShort(p.paycheckAmount)} ${freqLabel(p.frequency).toLowerCase()}</div>
        <span class="days-pill">${dl} ${dl === 1 ? "day" : "days"} left · ${fmt(Math.max(0, perDay))}/day</span>
        <div class="hero-stats">
          <div class="hero-stat"><div class="k">Spent</div><div class="v">${fmt(spent)}</div></div>
          <div class="hero-stat"><div class="k">Budgeted</div><div class="v">${fmt(budgeted)}</div></div>
          <div class="hero-stat"><div class="k">${unbudgeted >= 0 ? "Unbudgeted" : "Over-budgeted"}</div><div class="v">${fmt(Math.abs(unbudgeted))}</div></div>
        </div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <h2 style="margin:0;">Categories</h2>
          <button class="btn btn-primary btn-sm" id="quick-add">+ Log spend</button>
        </div>
        ${cats}
      </div>

      <button class="btn btn-ghost btn-block" id="new-payday">💵 Got paid? Start a new pay period</button>
      <p class="footer-note">Starting a new period saves this one to your history.</p>
    `;

    document.getElementById("quick-add").addEventListener("click", () => openSpendModal(p));
    document.getElementById("new-payday").addEventListener("click", () => confirmNewPayday(p));
  }

  /* ---------- Spend view (log + list transactions) ---------- */
  function renderSpend(p) {
    const txns = [...p.transactions].sort((a, b) =>
      (b.date + b.id).localeCompare(a.date + a.id)
    );

    const catById = Object.fromEntries(p.categories.map((c) => [c.id, c]));

    const list = txns.length
      ? txns
          .map((t) => {
            const c = catById[t.categoryId] || { emoji: "❓", name: "Uncategorized" };
            return `
          <div class="txn" data-id="${t.id}">
            <div class="txn-left">
              <div class="txn-emoji">${esc(c.emoji)}</div>
              <div>
                <div class="txn-desc">${esc(t.description || c.name)}</div>
                <div class="txn-meta">${esc(c.name)} · ${esc(t.date)}</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;">
              <span class="txn-amt">${fmt(t.amount)}</span>
              <button class="rm" data-rm="${t.id}" title="Delete">🗑</button>
            </div>
          </div>`;
          })
          .join("")
      : `<div class="empty"><div class="big">🧾</div><p>No spending logged yet this period.</p></div>`;

    main.innerHTML = `
      <button class="btn btn-primary btn-block" id="add-spend" style="margin-bottom:14px;">+ Log spending</button>
      <div class="card">
        <h2>This period's spending</h2>
        <p class="sub">${txns.length} ${txns.length === 1 ? "transaction" : "transactions"} · ${fmt(totalSpent(p))} total</p>
        ${list}
      </div>
    `;

    document.getElementById("add-spend").addEventListener("click", () => openSpendModal(p));
    main.querySelectorAll("[data-rm]").forEach((btn) =>
      btn.addEventListener("click", () => {
        p.transactions = p.transactions.filter((t) => t.id !== btn.dataset.rm);
        save();
        render();
      })
    );
  }

  function openSpendModal(p, presetCatId) {
    const cats = p.categories;
    let selectedCat = presetCatId || cats[0].id;

    modalRoot.innerHTML = `
      <div class="modal-overlay" id="ov">
        <div class="modal" role="dialog" aria-modal="true">
          <h2>Log spending</h2>
          <div class="field money-input">
            <label>Amount</label>
            <input id="sp-amount" type="number" inputmode="decimal" placeholder="0.00" step="0.01" autofocus />
          </div>
          <div class="field">
            <label>Category</label>
            <div class="chips" id="sp-chips">
              ${cats
                .map(
                  (c) =>
                    `<button class="chip ${c.id === selectedCat ? "active" : ""}" data-cat="${c.id}">${esc(c.emoji)} ${esc(c.name)}</button>`
                )
                .join("")}
            </div>
          </div>
          <div class="field">
            <label>Note (optional)</label>
            <input id="sp-desc" placeholder="e.g. Groceries at Loblaws" />
          </div>
          <div class="field">
            <label>Date</label>
            <input id="sp-date" type="date" value="${todayISO()}" />
          </div>
          <div class="field-row">
            <button class="btn btn-ghost" id="sp-cancel" style="flex:1;">Cancel</button>
            <button class="btn btn-primary" id="sp-save" style="flex:2;">Save</button>
          </div>
        </div>
      </div>
    `;

    const amountEl = document.getElementById("sp-amount");
    setTimeout(() => amountEl.focus(), 50);

    document.getElementById("sp-chips").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-cat]");
      if (!btn) return;
      selectedCat = btn.dataset.cat;
      document.querySelectorAll("#sp-chips .chip").forEach((c) =>
        c.classList.toggle("active", c.dataset.cat === selectedCat)
      );
    });

    const close = () => (modalRoot.innerHTML = "");
    document.getElementById("sp-cancel").addEventListener("click", close);
    document.getElementById("ov").addEventListener("click", (e) => {
      if (e.target.id === "ov") close();
    });

    document.getElementById("sp-save").addEventListener("click", () => {
      const amount = Number(amountEl.value);
      if (!amount || amount <= 0) {
        alert("Enter an amount.");
        return;
      }
      p.transactions.push({
        id: uid(),
        categoryId: selectedCat,
        amount,
        description: document.getElementById("sp-desc").value.trim(),
        date: document.getElementById("sp-date").value || todayISO(),
      });
      save();
      close();
      render();
    });
  }

  /* ---------- New payday confirmation ---------- */
  function confirmNewPayday(p) {
    const remaining = totalBudgeted(p) - totalSpent(p);
    modalRoot.innerHTML = `
      <div class="modal-overlay" id="ov">
        <div class="modal" role="dialog" aria-modal="true">
          <h2>Start a new pay period?</h2>
          <p class="sub">This closes your current budget and saves it to history. You had
            <b>${fmt(remaining)}</b> left across all categories.</p>
          <div class="field-row">
            <button class="btn btn-ghost" id="np-cancel" style="flex:1;">Not yet</button>
            <button class="btn btn-primary" id="np-go" style="flex:2;">Yes, I got paid</button>
          </div>
        </div>
      </div>
    `;
    const close = () => (modalRoot.innerHTML = "");
    document.getElementById("np-cancel").addEventListener("click", close);
    document.getElementById("ov").addEventListener("click", (e) => {
      if (e.target.id === "ov") close();
    });
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
    const closed = state.periods.filter((p) => p.closed).slice().reverse();

    if (closed.length === 0) {
      main.innerHTML = `<div class="empty"><div class="big">📚</div><h2>No history yet</h2><p>Finished pay periods will show up here so you can see how you did over time.</p></div>`;
      return;
    }

    const items = closed
      .map((p) => {
        const budgeted = totalBudgeted(p);
        const spent = totalSpent(p);
        const saved = p.paycheckAmount - spent;
        return `
        <div class="hist-item" data-id="${p.id}">
          <div>
            <div class="hist-date">${esc(fmtDateLong(p.startDate))}</div>
            <div class="hist-sub">Paid ${fmt(p.paycheckAmount)} · spent ${fmt(spent)}</div>
          </div>
          <div class="hist-right">
            <div class="hist-saved ${saved >= 0 ? "pos" : "neg"}">${saved >= 0 ? "+" : ""}${fmt(saved)}</div>
            <div class="hist-sub">${saved >= 0 ? "left over" : "overspent"}</div>
          </div>
        </div>`;
      })
      .join("");

    main.innerHTML = `
      <div class="card">
        <h2>Past pay periods</h2>
        <p class="sub">Tap one to see the details.</p>
        ${items}
      </div>
    `;

    main.querySelectorAll(".hist-item").forEach((el) =>
      el.addEventListener("click", () => openHistoryDetail(el.dataset.id))
    );
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
    const cats = p.categories
      .map((c) => {
        const cs = catSpent(p, c.id);
        const over = cs > c.budgeted + 0.005;
        return `<div class="cat-row"><div class="cat-top">
          <span class="cat-name"><span class="cat-emoji">${esc(c.emoji)}</span>${esc(c.name)}</span>
          <span class="cat-amounts ${over ? "over" : ""}"><b>${fmt(cs)}</b> of ${fmt(c.budgeted)}</span>
        </div></div>`;
      })
      .join("");

    modalRoot.innerHTML = `
      <div class="modal-overlay" id="ov">
        <div class="modal" role="dialog" aria-modal="true">
          <h2>${esc(fmtDateLong(p.startDate))}</h2>
          <p class="sub">Paid ${fmt(p.paycheckAmount)} · ${freqLabel(p.frequency)} · spent ${fmt(spent)}</p>
          ${cats}
          <div class="divider"></div>
          <button class="btn btn-danger btn-block btn-sm" id="hist-del">Delete this record</button>
          <button class="btn btn-ghost btn-block" id="hist-close" style="margin-top:8px;">Close</button>
        </div>
      </div>
    `;
    const close = () => (modalRoot.innerHTML = "");
    document.getElementById("hist-close").addEventListener("click", close);
    document.getElementById("ov").addEventListener("click", (e) => {
      if (e.target.id === "ov") close();
    });
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
   * Tab navigation
   * ------------------------------------------------------------------ */
  document.getElementById("tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    state.view = tab.dataset.view;
    render();
  });

  /* Boot */
  render();
})();
