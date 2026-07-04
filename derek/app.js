/* Payday Budget — set your budget once each time you're paid.
 * Pure vanilla JS. State persists in localStorage. No backend. */

(function () {
  "use strict";

  const STORAGE_KEY = "payday-budget-derek-v1";

  /* Default recipients for the "Email report" button. Change anytime. */
  const REPORT_EMAILS = ["derekchu12@gmail.com"];

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

  // Set of category ids currently spent over their (non-zero) budget.
  function overBudgetIds(p) {
    return new Set(
      p.categories
        .filter((c) => c.budgeted > 0 && catSpent(p, c.id) > c.budgeted + 0.005)
        .map((c) => c.id)
    );
  }

  const freqLabel = (f) =>
    ({ weekly: "Weekly", biweekly: "Every 2 weeks", semimonthly: "Twice a month", monthly: "Monthly" }[f] || f);

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  /* Default categories offered on first setup. */
  const STARTER_CATEGORIES = [
    { emoji: "🏠", name: "Rent / Mortgage", budgeted: "", fixed: true },
    { emoji: "💡", name: "Utilities", budgeted: "", fixed: true },
    { emoji: "📱", name: "Phone", budgeted: "", fixed: true },
    { emoji: "📶", name: "Internet", budgeted: "", fixed: true },
    { emoji: "🎬", name: "Subscriptions", budgeted: "", fixed: true },
    { emoji: "🚗", name: "Car / Transport", budgeted: "" },
    { emoji: "🛒", name: "Groceries", budgeted: "" },
    { emoji: "🍽️", name: "Restaurants", budgeted: "" },
    { emoji: "🥡", name: "Take-Out", budgeted: "" },
    { emoji: "☕", name: "Coffee", budgeted: "" },
    { emoji: "🛍️", name: "Shopping", budgeted: "" },
    { emoji: "🏋️", name: "Gym / Health", budgeted: "" },
    { emoji: "🎉", name: "Fun", budgeted: "" },
    { emoji: "📦", name: "Miscellaneous", budgeted: "" },
    { emoji: "💰", name: "Savings", budgeted: "" },
  ];

  /* Editable category row, shared by the setup and Manage editors.
   * `id` is the identity used by the surrounding editor (row id or key). */
  function catEditRow(r, id, opts) {
    opts = opts || {};
    const note = opts.note ? `<div class="mc-spent">${esc(opts.note)}</div>` : "";
    const label = r.name || "category";
    return `
      <div class="cat-edit-row" data-row="${esc(id)}">
        <div class="alloc-item">
          <input class="emoji-in" data-f="emoji" value="${esc(r.emoji)}" maxlength="2" aria-label="Emoji" />
          <input class="name-in" data-f="name" placeholder="Category" value="${esc(r.name)}" aria-label="Category name" />
          <div class="money-input amt-in">
            <input data-f="budgeted" type="number" inputmode="decimal" placeholder="0" step="0.01" value="${esc(r.budgeted)}" aria-label="Budget amount" />
          </div>
          <button type="button" class="rm" data-rm="${esc(id)}" title="Remove ${esc(label)}" aria-label="Remove ${esc(label)}">×</button>
        </div>
        <label class="fixed-toggle">
          <input type="checkbox" data-f="fixed" ${r.fixed ? "checked" : ""} />
          📌 Fixed bill — auto-logged each payday
        </label>
        ${note}
      </div>`;
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
    // Sync tab highlight
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.view === state.view)
    );

    const period = activePeriod();

    // History and Report stay reachable even between paychecks (no active period).
    if (state.view === "history") return renderHistory();
    if (state.view === "report") return renderReport();

    if (!period) {
      // No active budget — force setup for the budgeting tabs.
      renderSetup();
      return;
    }

    if (state.view === "dashboard") renderDashboard(period);
    else if (state.view === "spend") renderSpend(period);
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

    // Working copy of allocation rows
    let rows = template.categories.map((c) => ({
      id: uid(),
      emoji: c.emoji || "💵",
      name: c.name || "",
      budgeted: c.budgeted != null ? String(c.budgeted) : "",
      fixed: !!c.fixed,
    }));

    const listEl = document.getElementById("alloc-list");
    const paycheckEl = document.getElementById("paycheck");

    function drawRows() {
      listEl.innerHTML = rows.map((r) => catEditRow(r, r.id)).join("");
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
          });
        }
      });
      state.periods.push(period);
      // Remember layout (names/emojis/amounts/fixed) for next payday.
      state.template = {
        frequency: period.frequency,
        categories: cats.map((c) => ({ emoji: c.emoji, name: c.name, budgeted: c.budgeted, fixed: c.fixed })),
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
    const saved = p.paycheckAmount - budgeted;
    const dl = daysLeft(p);
    const perDay = dl > 0 ? remaining / dl : remaining;

    const cats = p.categories
      .map((c) => {
        const cs = catSpent(p, c.id);
        const pct = c.budgeted > 0 ? (cs / c.budgeted) * 100 : 0;
        const cls = pct > 100 ? "over" : pct > 85 ? "warn" : "ok";
        const over = cs > c.budgeted + 0.005;
        const fixedTag = c.fixed ? `<span class="cat-fixed" title="Fixed bill">📌</span>` : "";
        const remainAmt = over ? fmt(cs - c.budgeted) : fmt(c.budgeted - cs);
        const remainLabel = over ? "over" : "left";
        return `
        <button type="button" class="cat-row cat-row-tap" data-cat="${c.id}"
          aria-label="Log spending for ${esc(c.name)}">
          <div class="cat-name"><span class="cat-emoji">${esc(c.emoji)}</span>${esc(c.name)}${fixedTag}</div>
          <div class="cat-figures">
            <span class="cat-spent">${fmt(cs)} of ${fmt(c.budgeted)}</span>
            <span class="cat-left ${over ? "over" : ""}"><b>${remainAmt}</b> <span class="cat-left-label">${remainLabel}</span></span>
          </div>
          <div class="bar"><div class="bar-fill ${cls}" style="width:${Math.min(100, pct)}%"></div></div>
        </button>`;
      })
      .join("");

    main.innerHTML = `
      <div class="card hero">
        <div class="label">Left to spend</div>
        <div class="amount">${fmt(remaining)}</div>
        <div class="hero-grid">
          <div class="hstat"><div class="hk">Spent</div><div class="hv">${fmt(spent)}</div></div>
          <div class="hstat"><div class="hk">${saved >= 0 ? "Saved" : "Over"}</div><div class="hv">${fmt(Math.abs(saved))}</div></div>
          <div class="hstat"><div class="hk">Budgeted</div><div class="hv">${fmt(budgeted)}</div></div>
        </div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;">
          <h2 style="margin:0;">Categories</h2>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-ghost btn-sm" id="manage-cats">✏️ Manage</button>
            <button class="btn btn-primary btn-sm" id="quick-add">+ Log spend</button>
          </div>
        </div>
        ${cats}
      </div>

      <button class="btn btn-ghost btn-block" id="new-payday">💵 Got paid? Start a new pay period</button>
      <p class="footer-note">Starting a new period saves this one to your history.</p>
    `;

    document.getElementById("quick-add").addEventListener("click", () => openSpendModal(p));
    document.getElementById("manage-cats").addEventListener("click", () => openManageCategories(p));
    document.getElementById("new-payday").addEventListener("click", () => confirmNewPayday(p));
    main.querySelectorAll(".cat-row-tap").forEach((el) =>
      el.addEventListener("click", () => openSpendModal(p, el.dataset.cat))
    );
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

    function spentFor(rowId) {
      return rowId ? catSpent(p, rowId) : 0;
    }

    function drawRows() {
      listEl.innerHTML = rows
        .map((r) => {
          const spent = spentFor(r.id);
          const note = spent > 0 ? `${fmt(spent)} already logged here` : "";
          return catEditRow(r, r._key, { note });
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
      rows.push({ id: null, emoji: "💵", name: "", budgeted: "", fixed: false, _key: uid() });
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
        }));

      if (kept.length === 0) {
        showToast("Keep at least one category.");
        return;
      }

      // Any transactions whose category was removed get dropped along with it.
      const keptIds = new Set(kept.map((c) => c.id));
      p.transactions = p.transactions.filter((t) => keptIds.has(t.categoryId));
      p.categories = kept;

      // Remember the new layout for the next payday.
      state.template = {
        frequency: p.frequency,
        categories: kept.map((c) => ({ emoji: c.emoji, name: c.name, budgeted: c.budgeted, fixed: c.fixed })),
      };

      save();
      close();
      render();
    });

    drawRows();
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
            <button type="button" class="txn-left txn-edit" data-edit="${t.id}" aria-label="Edit ${esc(t.description || c.name)}">
              <div class="txn-emoji">${esc(c.emoji)}</div>
              <div>
                <div class="txn-desc">${esc(t.description || c.name)}</div>
                <div class="txn-meta">${esc(c.name)} · ${esc(t.date)}</div>
              </div>
            </button>
            <div style="display:flex;align-items:center;">
              <span class="txn-amt">${fmt(t.amount)}</span>
              <button class="rm" data-rm="${t.id}" title="Delete" aria-label="Delete ${esc(t.description || c.name)}">🗑</button>
            </div>
          </div>`;
          })
          .join("")
      : `<div class="empty"><div class="big">🧾</div><p>No spending logged yet this period.</p></div>`;

    main.innerHTML = `
      <button class="btn btn-primary btn-block" id="add-spend" style="margin-bottom:14px;">+ Log spending</button>
      <div class="card">
        <h2>This period's spending</h2>
        <p class="sub">${txns.length} ${txns.length === 1 ? "transaction" : "transactions"} · ${fmt(totalSpent(p))} total${txns.length ? " · tap one to edit" : ""}</p>
        ${list}
      </div>
    `;

    document.getElementById("add-spend").addEventListener("click", () => openSpendModal(p));

    main.querySelectorAll("[data-edit]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const t = p.transactions.find((x) => x.id === btn.dataset.edit);
        if (t) openSpendModal(p, null, t);
      })
    );

    main.querySelectorAll("[data-rm]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const id = btn.dataset.rm;
        const idx = p.transactions.findIndex((t) => t.id === id);
        if (idx === -1) return;
        const [removed] = p.transactions.splice(idx, 1);
        save();
        render();
        showToast("Transaction deleted", "Undo", () => {
          // Restore at its original position.
          p.transactions.splice(Math.min(idx, p.transactions.length), 0, removed);
          save();
          render();
        });
      })
    );
  }

  // editTxn: pass an existing transaction to edit it instead of adding a new one.
  function openSpendModal(p, presetCatId, editTxn) {
    const cats = p.categories;
    const editing = !!editTxn;
    let selectedCat =
      (editTxn && editTxn.categoryId) || presetCatId || cats[0].id;
    if (!cats.some((c) => c.id === selectedCat)) selectedCat = cats[0].id;

    const { close } = mountModal(`
      <div class="modal-overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="${editing ? "Edit spending" : "Log spending"}">
          <h2>${editing ? "Edit spending" : "Log spending"}</h2>
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
      const before = overBudgetIds(p);
      if (editing) {
        Object.assign(editTxn, fields);
      } else {
        p.transactions.push({ id: uid(), ...fields });
      }
      save();
      const after = overBudgetIds(p);
      const newlyOver = p.categories.filter((c) => after.has(c.id) && !before.has(c.id));
      close();
      render();
      if (newlyOver.length) openOverBudgetAlert(p, newlyOver);
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
      `You've exceeded the budget in the following categor${plural ? "ies" : "y"}:\n\n` +
      cats
        .map((c) => {
          const cs = catSpent(p, c.id);
          return `• ${c.name}: spent ${fmt(cs)} of ${fmt(c.budgeted)} — over by ${fmt(cs - c.budgeted)}`;
        })
        .join("\n") +
      `\n\nPay period starting ${fmtDateLong(p.startDate)}.` +
      `\n\n— sent from Payday Budget`;

    const { close } = mountModal(`
      <div class="modal-overlay">
        <div class="modal" role="alertdialog" aria-modal="true" aria-label="Over budget alert">
          <div class="ob-head">⚠️</div>
          <h2 style="text-align:center;">Over budget</h2>
          <p class="sub" style="text-align:center;">Heads up — this spending puts ${plural ? "these categories" : "this category"} over budget.</p>
          <ul class="ob-list">${detail}</ul>
          <button class="btn btn-primary btn-block" id="ob-email">✉️ Email this alert</button>
          <p class="footer-note" style="margin:8px 0 14px;">Opens a pre-filled message to ${esc(REPORT_EMAILS.join(" and "))}.</p>
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

    const { close } = mountModal(`
      <div class="modal-overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Pay period details">
          <h2>${esc(fmtDateLong(p.startDate))}</h2>
          <p class="sub">Paid ${fmt(p.paycheckAmount)} · ${freqLabel(p.frequency)} · spent ${fmt(spent)}</p>
          ${cats}
          <div class="divider"></div>
          <button class="btn btn-danger btn-block btn-sm" id="hist-del">Delete this record</button>
          <button class="btn btn-ghost btn-block" id="hist-close" style="margin-top:8px;">Close</button>
        </div>
      </div>
    `);
    document.getElementById("hist-close").addEventListener("click", close);
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
    const saved = p.paycheckAmount - spent;
    const unbudgeted = p.paycheckAmount - budgeted;
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
      "🐵 Derek's Payday Budget — Summary",
      `Pay period starting ${fmtDateLong(p.startDate)}`,
      `${freqLabel(p.frequency)}${active ? ` · ${dl} ${dl === 1 ? "day" : "days"} left` : " · closed"}`,
      "",
      pad("Paycheck", fmt(p.paycheckAmount)),
      pad("Budgeted", fmt(budgeted)),
      pad("Spent", fmt(spent)),
      pad(active ? "Remaining" : "Left over", `${fmt(active ? remaining : saved)}  ${status}`),
      pad(unbudgeted >= 0 ? "Saved" : "Over-budget", fmt(Math.abs(unbudgeted))),
      "",
      "By category (most spent first):",
      catLines || "  (no spending yet)",
      "",
      `Generated ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`,
    ];

    const subject = `Budget summary — ${fmtDateLong(p.startDate)} (${fmt(spent)} spent)`;
    return { subject, text: lines.join("\n") };
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
        <p class="footer-note">"Email report" opens a draft to ${esc(REPORT_EMAILS.join(" and "))}.</p>
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
      showToast("That file doesn't look like a Payday Budget backup.");
      return;
    }
    const periods = parsed.periods.length;
    if (
      !confirm(
        `Restore this backup? It has ${periods} pay period${periods === 1 ? "" : "s"} and will REPLACE everything currently in the app.`
      )
    )
      return;
    state = Object.assign(defaultState(), parsed);
    state.view = "dashboard";
    save();
    render();
    showToast("Backup restored ✓");
  }

  function openSettings() {
    const periods = state.periods.length;
    const txns = state.periods.reduce((s, p) => s + p.transactions.length, 0);
    const { close } = mountModal(`
      <div class="modal-overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Settings and backup">
          <h2>Settings &amp; backup</h2>
          <p class="sub">Your budget lives only on this device. Back it up so you never lose it if you clear your browser or switch phones.</p>

          <div class="settings-stat">${periods} pay period${periods === 1 ? "" : "s"} · ${txns} transaction${txns === 1 ? "" : "s"} stored</div>

          <button class="btn btn-primary btn-block" id="set-export">⬇️ Download backup</button>
          <p class="footer-note" style="margin:8px 0 16px;">Saves a <code>.json</code> file you can keep safe or move to another device.</p>

          <label class="btn btn-ghost btn-block" for="set-import-file" style="cursor:pointer;">⬆️ Restore from backup</label>
          <input type="file" id="set-import-file" accept="application/json,.json" style="position:absolute;width:1px;height:1px;opacity:0;" />
          <p class="footer-note" style="margin:8px 0 16px;">Restoring replaces everything currently in the app.</p>

          <div class="divider"></div>
          <button class="btn btn-danger btn-block btn-sm" id="set-reset">Erase all data</button>
          <button class="btn btn-ghost btn-block" id="set-close" style="margin-top:8px;">Close</button>
        </div>
      </div>
    `);

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

  /* Boot */
  render();
})();
