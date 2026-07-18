/* cloud.js — optional Firebase sync layer for Payday Budget.
 *
 * Loads only if the Firebase compat SDK is present on the page; otherwise the
 * whole app keeps working fully offline/local and this is a no-op. Exposes a
 * small global `Cloud` API that app.js uses to sign in and sync a budget doc. */
(function () {
  "use strict";

  var firebaseConfig = {
    apiKey: "AIzaSyBYaea41M2oCNBInCiIGlxnJiCexai2mS4",
    authDomain: "payday-budget-496a1.firebaseapp.com",
    projectId: "payday-budget-496a1",
    storageBucket: "payday-budget-496a1.firebasestorage.app",
    messagingSenderId: "589469188392",
    appId: "1:589469188392:web:1237c616d01529a082901d",
  };

  var hasSDK =
    typeof firebase !== "undefined" && firebase && typeof firebase.initializeApp === "function";

  var auth = null;
  var db = null;
  var ready = false;

  function init() {
    if (!hasSDK || ready) return ready;
    try {
      firebase.initializeApp(firebaseConfig);
      auth = firebase.auth();
      db = firebase.firestore();
      // Stay signed in across visits.
      auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function () {});
      // Cache Firestore data so reads work offline once loaded.
      db.enablePersistence({ synchronizeTabs: true }).catch(function () {});
      ready = true;
    } catch (e) {
      ready = false;
    }
    return ready;
  }

  function budgetDoc(key) {
    return db.collection("budgets").doc(key);
  }
  function resultsDoc(key) {
    return db.collection("results").doc(key);
  }

  var Cloud = {
    get available() {
      return hasSDK;
    },
    get ready() {
      return ready;
    },
    init: init,

    onAuth: function (cb) {
      if (!ready) {
        cb(null);
        return function () {};
      }
      return auth.onAuthStateChanged(function (u) {
        cb(u || null);
      });
    },
    currentUser: function () {
      return ready && auth.currentUser ? auth.currentUser : null;
    },
    signIn: function (email, password) {
      if (!ready) return Promise.reject(new Error("Sync isn't available right now."));
      return auth.signInWithEmailAndPassword(String(email).trim(), password);
    },
    signOut: function () {
      return ready ? auth.signOut() : Promise.resolve();
    },

    // Realtime budget doc. cb(dataOrNull).
    watchBudget: function (key, cb) {
      if (!ready) return function () {};
      return budgetDoc(key).onSnapshot(
        function (snap) {
          cb(snap.exists ? snap.data() : null);
        },
        function () {}
      );
    },
    saveBudget: function (key, payload) {
      if (!ready) return Promise.resolve();
      return budgetDoc(key).set(payload).catch(function () {});
    },

    // Monthly results summary docs (used by the shared Results view).
    watchResults: function (key, cb) {
      if (!ready) return function () {};
      return resultsDoc(key).onSnapshot(
        function (snap) {
          cb(snap.exists ? snap.data() : null);
        },
        function () {}
      );
    },
    saveResults: function (key, payload) {
      if (!ready) return Promise.resolve();
      return resultsDoc(key).set(payload).catch(function () {});
    },

    /* ---- User directory (roles / admin) ------------------------------ *
     * Every signed-in user publishes a small profile to `users/{uid}` so an
     * admin can enumerate accounts. Admin-only fields (disabled) are written
     * by the admin; the security rules stop a user from setting their own. */
    saveUser: function (uid, payload) {
      if (!ready || !uid) return Promise.resolve();
      return db.collection("users").doc(uid).set(payload, { merge: true }).catch(function () {});
    },
    watchUser: function (uid, cb) {
      if (!ready || !uid) return function () {};
      return db.collection("users").doc(uid).onSnapshot(
        function (snap) { cb(snap.exists ? snap.data() : null); },
        function () {}
      );
    },
    watchUsers: function (cb) {
      // Admin-only in practice (rules gate the collection read).
      if (!ready) return function () {};
      return db.collection("users").onSnapshot(
        function (snap) {
          var out = [];
          snap.forEach(function (d) { out.push(d.data()); });
          cb(out);
        },
        function () { cb([]); }
      );
    },
    updateUser: function (uid, patch) {
      if (!ready || !uid) return Promise.reject(new Error("offline"));
      return db.collection("users").doc(uid).set(patch, { merge: true });
    },
    // One-shot reads so an admin can inspect another account's budget/results.
    getBudget: function (key) {
      if (!ready) return Promise.resolve(null);
      return budgetDoc(key).get().then(function (s) { return s.exists ? s.data() : null; }).catch(function () { return null; });
    },
    getResults: function (key) {
      if (!ready) return Promise.resolve(null);
      return resultsDoc(key).get().then(function (s) { return s.exists ? s.data() : null; }).catch(function () { return null; });
    },

    /* ---- App config: feature flags + broadcast banner ---------------- *
     * `app/config` is world-readable (so even signed-out visitors see a
     * broadcast) but admin-only writable. */
    watchConfig: function (cb) {
      if (!ready) return function () {};
      return db.collection("app").doc("config").onSnapshot(
        function (snap) { cb(snap.exists ? snap.data() : null); },
        function () {}
      );
    },
    saveConfig: function (payload) {
      if (!ready) return Promise.reject(new Error("offline"));
      return db.collection("app").doc("config").set(payload, { merge: true });
    },

    // Optional sign-UP (create account) — unlocks household linking for new users.
    signUp: function (email, password) {
      if (!ready) return Promise.reject(new Error("Sign-up isn't available right now."));
      return auth.createUserWithEmailAndPassword(String(email).trim(), password);
    },

    /* ---- Household linking (two-person couple; summaries only) -------- */
    createHousehold: function (hid, payload) {
      if (!ready) return Promise.reject(new Error("offline"));
      return db.collection("households").doc(hid).set(payload);
    },
    getHousehold: function (hid) {
      if (!ready) return Promise.resolve(null);
      return db.collection("households").doc(hid).get()
        .then(function (s) { return s.exists ? Object.assign({ id: s.id }, s.data()) : null; })
        .catch(function () { return null; });
    },
    watchHousehold: function (hid, cb) {
      if (!ready || !hid) return function () {};
      return db.collection("households").doc(hid).onSnapshot(
        function (s) { cb(s.exists ? Object.assign({ id: s.id }, s.data()) : null); },
        function () {}
      );
    },
    saveInvite: function (code, householdId) {
      if (!ready) return Promise.reject(new Error("offline"));
      return db.collection("inviteCodes").doc(code).set({ householdId: householdId });
    },
    resolveInvite: function (code) {
      if (!ready) return Promise.resolve(null);
      return db.collection("inviteCodes").doc(String(code).trim().toUpperCase()).get()
        .then(function (s) { return s.exists ? s.data().householdId : null; })
        .catch(function () { return null; });
    },
    // Add yourself as the 2nd member (rules cap the household at 2).
    joinHousehold: function (hid, uid) {
      if (!ready) return Promise.reject(new Error("offline"));
      return db.collection("households").doc(hid).update({
        members: firebase.firestore.FieldValue.arrayUnion(uid),
      });
    },
    leaveHousehold: function (hid, uid) {
      if (!ready) return Promise.reject(new Error("offline"));
      return db.collection("households").doc(hid).update({
        members: firebase.firestore.FieldValue.arrayRemove(uid),
      });
    },
    saveSummary: function (hid, uid, payload) {
      if (!ready) return Promise.resolve();
      return db.collection("households").doc(hid).collection("summaries").doc(uid).set(payload).catch(function () {});
    },
    watchSummaries: function (hid, cb) {
      if (!ready || !hid) return function () {};
      return db.collection("households").doc(hid).collection("summaries").onSnapshot(
        function (snap) {
          var out = [];
          snap.forEach(function (d) { out.push(Object.assign({ uid: d.id }, d.data())); });
          cb(out);
        },
        function () { cb([]); }
      );
    },
  };

  window.Cloud = Cloud;
})();
