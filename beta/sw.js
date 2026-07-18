/* Payday Budget service worker — offline support + fresh updates.
 * Network-first: online always gets the latest; offline falls back to cache. */
const CACHE = "payday-beta-v126";
const CORE = ["./", "./index.html", "./styles.css", "./app.js", "./cloud.js", "./manifest.json", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  // Don't skipWaiting automatically: a new version WAITS so the app can offer an
  // "Update available — tap to refresh" prompt. The page posts SKIP_WAITING when
  // the user accepts (see initSWUpdates in app.js).
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}));
});

self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING" || (e.data && e.data.type === "SKIP_WAITING")) self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // fonts etc. go straight to network
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(req).then((r) => r || (req.mode === "navigate" ? caches.match("./index.html") : undefined))
      )
  );
});

/* ---- Reminders (Path A background firing) -------------------------------- *
 * The page writes a date-stamped schedule to IndexedDB (it can't schedule a
 * future notification directly). Periodic Background Sync (Android/Chrome,
 * installed PWA, best-effort ~daily) wakes us to fire anything now due. */
function remIdb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("yosan-reminders", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function remGet(key) {
  return remIdb().then((db) => new Promise((res) => {
    const q = db.transaction("kv", "readonly").objectStore("kv").get(key);
    q.onsuccess = () => res(q.result);
    q.onerror = () => res(undefined);
  })).catch(() => undefined);
}
function remSet(key, val) {
  return remIdb().then((db) => new Promise((res) => {
    const q = db.transaction("kv", "readwrite").objectStore("kv").put(val, key);
    q.onsuccess = () => res();
    q.onerror = () => res();
  })).catch(() => {});
}
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
async function runDueReminders() {
  const schedule = (await remGet("schedule")) || [];
  const fired = (await remGet("fired")) || {};
  const t = todayLocal();
  let changed = false;
  for (const r of schedule) {
    if (r.fireOn <= t && fired[r.tag] !== t) {
      await self.registration.showNotification(r.title, { body: r.body, tag: r.tag, icon: "./icon-192.png", badge: "./icon-192.png" });
      fired[r.tag] = t;
      changed = true;
    }
  }
  if (changed) await remSet("fired", fired);
}
self.addEventListener("periodicsync", (e) => {
  if (e.tag === "yosan-reminders") e.waitUntil(runDueReminders());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) if ("focus" in c) return c.focus();
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});
