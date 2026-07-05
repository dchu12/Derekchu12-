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
  };

  window.Cloud = Cloud;
})();
