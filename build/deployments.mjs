/* Single source of per-deployment configuration.
 *
 * The shared app is one file — src/app.js — and this describes how the three
 * live deployments (Kelly at repo root, Derek, and the public Beta) differ from
 * it: cloud budget key, owner/partner names, report recipients, and each app's
 * starter category layout. `npm run build` regenerates every deployment's
 * app.js + sw.js from src + this config; `npm run build:check` fails if the
 * committed output has drifted from what the build would produce.
 *
 * Bump VERSION here (not by hand across files) to cut a release.
 *
 * Derek's build additionally has a dual-workspace layer (he can view Kelly's
 * budget too) that isn't config — it's applied from build/patches/derek.patch.
 */

export const VERSION = "122";

export const deployments = [
  {
    id: "kelly",
    dir: ".",
    cachePrefix: "payday-kelly",
    storageKey: "payday-budget-v1",
    reportEmails: ["Kellyseadreams@gmail.com", "derekchu12@gmail.com"],
    budgetKey: "kelly",
    personName: "Kelly",
    partnerName: "Derek",
    patch: null,
    starter: [
      { emoji: "🐕", name: "Toro Insurance", fixed: true },
      { emoji: "🐕", name: "Haku Insurance", fixed: true },
      { emoji: "💍", name: "Kelly · Oura Ring", fixed: true },
      { emoji: "📺", name: "Kelly · Netflix", fixed: true },
      { emoji: "📱", name: "Kelly · Phone", fixed: true },
      { emoji: "☁️", name: "Kelly · Apple Storage", fixed: true },
      { emoji: "🛒", name: "Groceries" },
      { emoji: "🍽️", name: "Restaurants" },
      { emoji: "🥡", name: "Take-Out" },
      { emoji: "🚗", name: "Ride-Share" },
      { emoji: "🚇", name: "TTC" },
      { emoji: "🦴", name: "Dog Essentials" },
      { emoji: "🛍️", name: "Shopping" },
      { emoji: "📦", name: "Miscellaneous" },
      { emoji: "💆", name: "Facial" },
      { emoji: "🧑‍⚕️", name: "Chiro" },
    ],
  },
  {
    id: "derek",
    dir: "derek",
    cachePrefix: "payday-derek",
    storageKey: "payday-budget-derek-v1",
    reportEmails: ["derekchu12@gmail.com"],
    budgetKey: "derek",
    personName: "Derek",
    partnerName: "Kelly",
    patch: "build/patches/derek.patch",
    starter: [
      { emoji: "🏠", name: "Rent / Mortgage", fixed: true },
      { emoji: "💡", name: "Utilities", fixed: true },
      { emoji: "📱", name: "Phone", fixed: true },
      { emoji: "📶", name: "Internet", fixed: true },
      { emoji: "🎬", name: "Subscriptions", fixed: true },
      { emoji: "🚗", name: "Car / Transport" },
      { emoji: "🛒", name: "Groceries" },
      { emoji: "🍽️", name: "Restaurants" },
      { emoji: "🥡", name: "Take-Out" },
      { emoji: "☕", name: "Coffee" },
      { emoji: "🛍️", name: "Shopping" },
      { emoji: "🏋️", name: "Gym / Health" },
      { emoji: "🎉", name: "Fun" },
      { emoji: "📦", name: "Miscellaneous" },
      { emoji: "💰", name: "Savings" },
    ],
  },
  {
    id: "beta",
    dir: "beta",
    cachePrefix: "payday-beta",
    storageKey: "payday-budget-beta-v1",
    reportEmails: [],
    budgetKey: "beta",
    personName: "You",
    partnerName: "Partner",
    patch: "build/patches/beta.patch",
    starter: [
      { emoji: "🏠", name: "Rent", fixed: true },
      { emoji: "📱", name: "Phone", fixed: true },
      { emoji: "🌐", name: "Internet", fixed: true },
      { emoji: "📺", name: "Streaming", fixed: true },
      { emoji: "🏋️", name: "Gym", fixed: true },
      { emoji: "🛒", name: "Groceries" },
      { emoji: "🍽️", name: "Restaurants" },
      { emoji: "🥡", name: "Take-Out" },
      { emoji: "☕", name: "Coffee" },
      { emoji: "⛽", name: "Gas" },
      { emoji: "🚌", name: "Transit" },
      { emoji: "🛍️", name: "Shopping" },
      { emoji: "🎬", name: "Entertainment" },
      { emoji: "📦", name: "Miscellaneous" },
    ],
  },
];
