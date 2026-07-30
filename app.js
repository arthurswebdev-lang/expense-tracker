"use strict";

/* ---------------------------------------------------------------------
 * Storage: IndexedDB, used purely as a JSON document store.
 * Every record is a plain JSON object; transactions are tagged with a
 * "month" field ("YYYY-MM") so a single month can be queried/exported
 * in isolation, per requirements. Categories embed their own
 * subcategories array (no separate store needed).
 * ------------------------------------------------------------------- */

const DB_NAME = "spend-tracker-db-v3";
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("accounts")) {
        db.createObjectStore("accounts", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("categories")) {
        db.createObjectStore("categories", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("tags")) {
        db.createObjectStore("tags", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("transactions")) {
        const store = db.createObjectStore("transactions", { keyPath: "id" });
        store.createIndex("month", "month", { unique: false });
        store.createIndex("accountId", "accountId", { unique: false });
        store.createIndex("toAccountId", "toAccountId", { unique: false });
        store.createIndex("categoryId", "categoryId", { unique: false });
        store.createIndex("subcategoryId", "subcategoryId", { unique: false });
        store.createIndex("tagIds", "tagIds", { unique: false, multiEntry: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const DB = {
  async getAll(storeName) {
    const store = await tx(storeName, "readonly");
    return reqToPromise(store.getAll());
  },
  async getAllByIndex(storeName, indexName, value) {
    const store = await tx(storeName, "readonly");
    return reqToPromise(store.index(indexName).getAll(value));
  },
  async put(storeName, value) {
    const store = await tx(storeName, "readwrite");
    return reqToPromise(store.put(value));
  },
  async delete(storeName, id) {
    const store = await tx(storeName, "readwrite");
    return reqToPromise(store.delete(id));
  },
};

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

/* ---------------------------------------------------------------------
 * Seed data
 * ------------------------------------------------------------------- */

const SEED_CATEGORIES = [
  { name: "Տուն", icon: "🏠", color: "#007aff", subs: ["Սնունդ", "տնտեսական", "ծախսի համար", "դեղորայք", "կոմունալ"] },
  { name: "Սնունդ", icon: "🍔", color: "#ff9500", subs: ["Չիփսեր", "ռեստորան"] },
  { name: "Արշավներ", icon: "🥾", color: "#34c759", subs: ["սնունդ", "տրանսպորտ"] },
  { name: "Տրանսպորտ", icon: "🚗", color: "#ff3b30", subs: ["տաքսի", "երթուղային"] },
  { name: "Վերանորոգում", icon: "🔧", color: "#8e8e93", subs: [] },
  { name: "Վարկեր", icon: "🏦", color: "#5856d6", subs: [] },
  { name: "Հարկեր", icon: "🧾", color: "#af52de", subs: ["ԱՁ"] },
  { name: "Մուտքեր", icon: "💰", color: "#30d158", subs: ["աշխատավարձ", "խնայողական", "պարտքի վերադարձ"] },
  { name: "Առողջություն", icon: "🩺", color: "#ff2d55", subs: [] },
  { name: "Վճարովի ծառայություններ", icon: "📱", color: "#00c7be", subs: ["software", "phone"] },
  { name: "Անձնական առևտուր", icon: "🛍️", color: "#ffcc00", subs: ["Տեխնիկա", "ուսում", "հոբբի", "հագուստ"] },
  { name: "Չնախատեսված", icon: "❓", color: "#ff9500", subs: ["պարտք", "օգնություն"] },
  { name: "Հանգիստ", icon: "🎬", color: "#30b0c7", subs: ["Կինո", "հյուրանոց"] },
  { name: "Երեխաներին", icon: "🧸", color: "#ff2d55", subs: ["հագուստ", "սնունդ", "խաղեր"] },
];

async function seedDefaultCategoriesIfEmpty() {
  const existing = await DB.getAll("categories");
  if (existing.length > 0) return;
  for (const c of SEED_CATEGORIES) {
    await DB.put("categories", {
      id: uid(),
      name: c.name,
      icon: c.icon,
      color: c.color,
      usageCount: 0,
      subcategories: c.subs.map((name) => ({ id: uid(), name, usageCount: 0, createdAt: Date.now() })),
      createdAt: Date.now(),
    });
  }
}

/* ---------------------------------------------------------------------
 * In-memory state
 * ------------------------------------------------------------------- */

const OUT_OF_WALLET_ID = "out-of-wallet";

const state = {
  view: "spends",
  month: currentMonthStr(),
  weekMode: false, // true = record list is filtered to the current calendar week instead of state.month
  dayMode: false, // true = record list is filtered to just today, instead of state.month
  selectedAccountId: null, // null = account grid; set = drilled into that account's activity
  accounts: [],
  categories: [],
  tags: [],
  transactions: [], // current month only
  allTransactions: [], // every month, used for account balances
  reportRange: "month", // "month" | "today" | "week" | "custom"
  reportFrom: "",
  reportTo: "",
  reportFilterMode: "include", // "include" | "exclude" — only one is active/applied at a time
  reportIncludeIds: [], // category ids to include; remembered even while exclude mode is active
  reportExcludeIds: [], // category ids to exclude; remembered even while include mode is active
  reportTagFilterMode: "include", // "include" | "exclude" — independent of the category filter above
  reportTagIncludeIds: [], // tag ids; a record matches if it has ANY of these
  reportTagExcludeIds: [], // tag ids; a record is dropped if it has ANY of these
};

function currentMonthStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function shiftMonth(monthStr, delta) {
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function monthLabel(monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function currentWeekRange() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sun .. 6 = Sat
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const toISO = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  return { start: toISO(monday), end: toISO(sunday) };
}

function weekRangeLabel(start, end) {
  const fmt = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  return `${fmt(start)} – ${fmt(end)}`;
}

function weekTransactions() {
  const { start, end } = currentWeekRange();
  return state.allTransactions
    .filter((t) => t.date >= start && t.date <= end)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
}

function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function todayLabel() {
  return new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dayTransactions() {
  const today = todayISO();
  return state.allTransactions
    .filter((t) => t.date === today)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function reportRangeDates() {
  if (state.reportRange === "today") {
    const iso = todayISO();
    return { start: iso, end: iso };
  }
  if (state.reportRange === "week") return currentWeekRange();
  if (state.reportRange === "last30") {
    const end = new Date();
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 29);
    const toISO = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    return { start: toISO(start), end: toISO(end) };
  }
  if (state.reportRange === "custom") {
    const from = state.reportFrom || todayISO();
    const to = state.reportTo || todayISO();
    return from <= to ? { start: from, end: to } : { start: to, end: from };
  }
  const monthStr = currentMonthStr();
  const [y, m] = monthStr.split("-").map(Number);
  const lastDay = String(new Date(y, m, 0).getDate()).padStart(2, "0");
  return { start: `${monthStr}-01`, end: `${monthStr}-${lastDay}` };
}

function reportRangeTransactions() {
  const { start, end } = reportRangeDates();
  return state.allTransactions
    .filter((t) => t.date >= start && t.date <= end)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
}

// Only the active mode's list is applied — switching modes doesn't discard
// the other list, it just stops using it, so flipping back keeps your picks.
// Transfers have no category, so in include mode they only pass through
// when the include list is empty (an include list can never match one).
function reportFilteredTransactions() {
  let records = reportRangeTransactions();

  const catIds = state.reportFilterMode === "exclude" ? state.reportExcludeIds : state.reportIncludeIds;
  if (catIds.length) {
    records = records.filter((t) =>
      state.reportFilterMode === "exclude" ? !catIds.includes(t.categoryId) : catIds.includes(t.categoryId)
    );
  }

  // Tag filter matches if the record has ANY of the selected tags (OR, not
  // AND) — records with no tags at all can never match an include filter.
  const tagIds = state.reportTagFilterMode === "exclude" ? state.reportTagExcludeIds : state.reportTagIncludeIds;
  if (tagIds.length) {
    records = records.filter((t) => {
      const hasAny = (t.tagIds || []).some((id) => tagIds.includes(id));
      return state.reportTagFilterMode === "exclude" ? !hasAny : hasAny;
    });
  }

  return records;
}

function toggleId(list, id) {
  const i = list.indexOf(id);
  if (i === -1) list.push(id);
  else list.splice(i, 1);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parseAmountInput(value) {
  return parseFloat(String(value).trim().replace(",", "."));
}

function fmtAmount(n) {
  return round2(n).toLocaleString("en-US", { maximumFractionDigits: 2 }) + " ֏";
}

function fmtSigned(n, type) {
  const sign = type === "expense" ? "−" : type === "income" ? "+" : "";
  return sign + fmtAmount(Math.abs(n));
}

const ACCOUNT_TYPES = [
  { value: "saving", label: "Saving" },
  { value: "regular", label: "Regular" },
  { value: "cash", label: "Cash" },
  { value: "digital", label: "Digital" },
];

const TX_TYPES = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
  { value: "transfer", label: "Transfer" },
];

const ACCOUNT_ICONS = ["🏦", "💳", "💵", "💰", "🐷", "📱", "🏧", "💎", "👛", "📈", "🪙", "🧾", "🌐", "🔒"];
const CATEGORY_ICONS = ["🍔", "🛒", "🚗", "🏠", "💡", "🎬", "🩺", "✈️", "🎓", "🎁", "🐾", "☕", "👕", "📱", "⚽", "🍺", "💊", "🔧", "📚", "🎮", "🥾", "🧾", "🛍️", "🧸", "❓"];
const COLOR_PALETTE = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#00c7be", "#30b0c7", "#007aff", "#5856d6", "#af52de", "#ff2d55", "#8e8e93"];

/* ---------------------------------------------------------------------
 * Bootstrap
 * ------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", init);

async function init() {
  wireNav();
  wireModal();
  wireFab();
  wireExport();
  wireReports();
  await ensureOutOfWalletAccount();
  await seedDefaultCategoriesIfEmpty();
  await reloadReferenceData();
  await reloadTransactions();
  render();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      reg.update().catch(() => {});
    }).catch(() => {});

    // iOS home-screen apps in particular won't pick up a new version just by
    // reopening — the old service worker keeps serving the page it already
    // controls. Once a new worker activates (sw.js already calls
    // skipWaiting/clients.claim on install/activate) this reloads the page
    // once so the update actually takes effect instead of sitting stale.
    let reloadedForUpdate = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadedForUpdate) return;
      reloadedForUpdate = true;
      window.location.reload();
    });
  }
}

async function ensureOutOfWalletAccount() {
  const existing = await tx("accounts", "readonly").then((store) => reqToPromise(store.get(OUT_OF_WALLET_ID)));
  if (existing) return;
  await DB.put("accounts", {
    id: OUT_OF_WALLET_ID,
    name: "Out of Wallet",
    type: "system",
    icon: "🌫️",
    color: "#8e8e93",
    initialBalance: null,
    isSystem: true,
    createdAt: Date.now(),
  });
}

async function reloadReferenceData() {
  [state.accounts, state.categories, state.tags] = await Promise.all([
    DB.getAll("accounts"),
    DB.getAll("categories"),
    DB.getAll("tags"),
  ]);
  state.accounts.sort((a, b) => (a.isSystem ? 1 : b.isSystem ? -1 : a.name.localeCompare(b.name)));
  state.categories.forEach((c) => { if (!c.subcategories) c.subcategories = []; });
  state.categories.sort((a, b) => a.name.localeCompare(b.name));
  state.tags.forEach((t) => { if (!t.color) t.color = COLOR_PALETTE[0]; });
  state.tags.sort((a, b) => a.name.localeCompare(b.name));
}

async function reloadTransactions() {
  const [monthTx, allTx] = await Promise.all([
    DB.getAllByIndex("transactions", "month", state.month),
    DB.getAll("transactions"),
  ]);
  state.transactions = monthTx.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
  state.allTransactions = allTx;
}

function realAccounts() {
  return state.accounts.filter((a) => !a.isSystem);
}

function computeBalances() {
  const map = {};
  for (const a of state.accounts) map[a.id] = a.isSystem ? null : a.initialBalance || 0;
  for (const t of state.allTransactions) {
    if (t.type === "income") { if (map[t.accountId] != null) map[t.accountId] += t.amount; }
    else if (t.type === "expense") { if (map[t.accountId] != null) map[t.accountId] -= t.amount; }
    else if (t.type === "transfer") {
      if (map[t.accountId] != null) map[t.accountId] -= t.amount;
      if (map[t.toAccountId] != null) map[t.toAccountId] += t.amount;
    }
  }
  return map;
}

// Shared In/Out logic: money is "In" when it lands in one of accountIds
// from outside that set, "Out" when it leaves one of accountIds to outside
// that set. Same rule for a single account (per-account view) or the full
// set of real accounts (all-accounts view) — a transfer between two
// accounts that are BOTH in accountIds (e.g. moving cash between your own
// accounts in the all-accounts view) nets to zero and isn't counted as
// either, since no money actually entered or left the tracked set; only a
// transfer crossing the boundary (e.g. to/from Out of Wallet) counts.
// Balance-adjustment transfers are bookkeeping corrections, not real cash
// flow, so they're excluded.
function computeInOut(transactions, accountIds) {
  const idSet = new Set(accountIds);
  let moneyIn = 0, moneyOut = 0;
  for (const t of transactions) {
    if (t.isAdjustment) continue;
    if (t.type === "income") { if (idSet.has(t.accountId)) moneyIn += t.amount; }
    else if (t.type === "expense") { if (idSet.has(t.accountId)) moneyOut += t.amount; }
    else if (t.type === "transfer") {
      if (idSet.has(t.toAccountId) && !idSet.has(t.accountId)) moneyIn += t.amount;
      if (idSet.has(t.accountId) && !idSet.has(t.toAccountId)) moneyOut += t.amount;
    }
  }
  return { moneyIn, moneyOut };
}

async function createBalanceAdjustment(accountId, delta) {
  if (Math.abs(delta) < 1) return;
  const adjustment = {
    id: uid(),
    month: currentMonthStr(),
    date: new Date().toISOString().slice(0, 10),
    type: "transfer",
    amount: Math.abs(delta),
    accountId: delta > 0 ? OUT_OF_WALLET_ID : accountId,
    toAccountId: delta > 0 ? accountId : OUT_OF_WALLET_ID,
    categoryId: null,
    subcategoryId: null,
    tagIds: [],
    notes: "Balance adjustment",
    isAdjustment: true,
    createdAt: Date.now(),
  };
  await DB.put("transactions", adjustment);
}

function subcategoryById(cat, subId) {
  return cat ? (cat.subcategories || []).find((s) => s.id === subId) : null;
}
function findSubcategory(subId) {
  for (const c of state.categories) {
    const s = subcategoryById(c, subId);
    if (s) return { category: c, subcategory: s };
  }
  return null;
}

// Usage is tracked as a simple running counter on each category/subcategory
// (not derived from scanning transactions) — cheap to read, and doesn't
// grow the amount of work needed as history grows. Counters are rebased
// (median subtracted, floored at 0) once any of them hits 1000, so they
// stay small forever while keeping relative "most used" ordering intact.
const USAGE_REBASE_LIMIT = 1000;

function medianOf(numbers) {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function rebaseCategoryUsage() {
  const med = medianOf(state.categories.map((c) => c.usageCount || 0));
  if (med <= 0) return;
  for (const c of state.categories) {
    c.usageCount = Math.max(0, (c.usageCount || 0) - med);
    await DB.put("categories", c);
  }
}

async function rebaseSubcategoryUsage() {
  const allSubs = state.categories.flatMap((c) => c.subcategories || []);
  const med = medianOf(allSubs.map((s) => s.usageCount || 0));
  if (med <= 0) return;
  for (const c of state.categories) {
    let changed = false;
    for (const s of c.subcategories || []) {
      const next = Math.max(0, (s.usageCount || 0) - med);
      if (next !== s.usageCount) { s.usageCount = next; changed = true; }
    }
    if (changed) await DB.put("categories", c);
  }
}

async function incrementCategoryUsage(categoryId, subcategoryId) {
  const cat = categoryById(categoryId);
  if (!cat) return;
  cat.usageCount = (cat.usageCount || 0) + 1;
  const sub = subcategoryId ? subcategoryById(cat, subcategoryId) : null;
  if (sub) sub.usageCount = (sub.usageCount || 0) + 1;
  await DB.put("categories", cat);

  if (cat.usageCount >= USAGE_REBASE_LIMIT) await rebaseCategoryUsage();
  if (sub && sub.usageCount >= USAGE_REBASE_LIMIT) await rebaseSubcategoryUsage();
}

/* ---------------------------------------------------------------------
 * Nav / tabs / month switching
 * ------------------------------------------------------------------- */

function wireNav() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.view = btn.dataset.view;
      state.selectedAccountId = null;
      render();
    });
  });

  document.getElementById("back-btn").addEventListener("click", () => {
    if (state.view !== "spends") state.view = "spends";
    state.selectedAccountId = null;
    render();
  });

  document.getElementById("month-prev").addEventListener("click", async () => {
    state.weekMode = false;
    state.dayMode = false;
    state.month = shiftMonth(state.month, -1);
    await reloadTransactions();
    render();
  });
  document.getElementById("month-next").addEventListener("click", async () => {
    state.weekMode = false;
    state.dayMode = false;
    state.month = shiftMonth(state.month, 1);
    await reloadTransactions();
    render();
  });
  document.getElementById("month-label").addEventListener("click", async () => {
    state.weekMode = false;
    state.dayMode = false;
    state.month = currentMonthStr();
    await reloadTransactions();
    render();
  });
  document.getElementById("today-btn").addEventListener("click", () => {
    state.dayMode = !state.dayMode;
    state.weekMode = false;
    render();
  });
  document.getElementById("week-btn").addEventListener("click", () => {
    state.weekMode = !state.weekMode;
    state.dayMode = false;
    render();
  });
}

function wireFab() {
  document.getElementById("fab").addEventListener("click", () => {
    if (state.view === "spends") openTransactionForm(null, state.selectedAccountId);
    else if (state.view === "accounts") openAccountForm();
    else if (state.view === "categories") openCategoryForm();
    else if (state.view === "tags") openTagForm();
  });
  document.getElementById("menu-fab").addEventListener("click", openEntityMenu);
}

function openEntityMenu() {
  openModal(`
    <div class="modal-header">
      <h2>Manage</h2>
      <button class="modal-close" id="modal-close-btn">✕</button>
    </div>
    <button type="button" class="secondary-btn" id="menu-accounts-btn">🏦 Accounts</button>
    <button type="button" class="secondary-btn" id="menu-categories-btn">🏷️ Categories</button>
    <button type="button" class="secondary-btn" id="menu-tags-btn">#️⃣ Tags</button>
    <button type="button" class="secondary-btn" id="menu-reports-btn">📊 Reports</button>
    <button type="button" class="secondary-btn" id="menu-export-btn">⬇️ Export This Month</button>
  `);
  document.getElementById("modal-close-btn").addEventListener("click", closeModal);
  document.getElementById("menu-accounts-btn").addEventListener("click", () => {
    closeModal();
    state.view = "accounts";
    state.selectedAccountId = null;
    render();
  });
  document.getElementById("menu-categories-btn").addEventListener("click", () => {
    closeModal();
    state.view = "categories";
    state.selectedAccountId = null;
    render();
  });
  document.getElementById("menu-tags-btn").addEventListener("click", () => {
    closeModal();
    state.view = "tags";
    state.selectedAccountId = null;
    render();
  });
  document.getElementById("menu-reports-btn").addEventListener("click", () => {
    closeModal();
    state.view = "reports";
    state.selectedAccountId = null;
    render();
  });
  document.getElementById("menu-export-btn").addEventListener("click", () => {
    closeModal();
    exportCurrentMonth();
  });
}

const VIEW_TITLES = {
  spends: "Expenses",
  accounts: "Accounts",
  categories: "Categories",
  tags: "Tags",
  export: "Export",
  reports: "Reports",
};

function render() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === state.view);
  });
  document.querySelectorAll(".view").forEach((el) => {
    el.hidden = el.id !== "view-" + state.view;
  });

  const inAccountDetail = state.view === "spends" && !!state.selectedAccountId;
  const onActivityGrid = state.view === "spends" && !inAccountDetail;
  const selectedAccount = inAccountDetail ? accountById(state.selectedAccountId) : null;

  document.getElementById("header-title").textContent = selectedAccount ? selectedAccount.name : VIEW_TITLES[state.view];
  document.getElementById("back-btn").hidden = !(inAccountDetail || state.view !== "spends");
  document.getElementById("menu-fab").hidden = !onActivityGrid;

  if (!onActivityGrid) { state.weekMode = false; state.dayMode = false; }

  const monthNav = document.getElementById("month-nav");
  if (inAccountDetail) {
    document.getElementById("spend-list").before(monthNav);
    monthNav.hidden = false;
  } else if (onActivityGrid) {
    document.getElementById("all-record-list").before(monthNav);
    monthNav.hidden = false;
  } else if (state.view === "export") {
    document.querySelector(".app-header").appendChild(monthNav);
    monthNav.hidden = false;
  } else {
    monthNav.hidden = true;
  }
  document.getElementById("today-btn").hidden = !onActivityGrid;
  document.getElementById("week-btn").hidden = !onActivityGrid;
  document.getElementById("today-btn").classList.toggle("active", onActivityGrid && state.dayMode);
  document.getElementById("week-btn").classList.toggle("active", onActivityGrid && state.weekMode);
  document.getElementById("month-pill").classList.toggle("active", onActivityGrid && !state.weekMode && !state.dayMode);
  const { start: weekStart, end: weekEnd } = currentWeekRange();
  document.getElementById("month-label").textContent =
    onActivityGrid && state.dayMode ? todayLabel()
    : onActivityGrid && state.weekMode ? weekRangeLabel(weekStart, weekEnd)
    : monthLabel(state.month);
  document.getElementById("export-month-label").textContent = monthLabel(state.month);
  document.getElementById("fab").hidden = state.view === "export" || state.view === "reports";

  if (state.view === "spends") renderActivity();
  if (state.view === "accounts") renderAccounts();
  if (state.view === "categories") renderCategories();
  if (state.view === "tags") renderTags();
  if (state.view === "reports") renderReports();
}

/* ---------------------------------------------------------------------
 * Lookups
 * ------------------------------------------------------------------- */

function accountById(id) { return state.accounts.find((a) => a.id === id); }
function categoryById(id) { return state.categories.find((c) => c.id === id); }
function tagById(id) { return state.tags.find((t) => t.id === id); }

function tagChipsHtml(tagIds) {
  return (tagIds || [])
    .map((tid) => tagById(tid))
    .filter(Boolean)
    .map((tg) => `<span class="tag-chip" style="background:${tg.color}33;color:${tg.color}">#${escapeHtml(tg.name)}</span>`)
    .join("");
}

// Toggleable pill for tag pickers (record tag picker, report tag filter) —
// colored by the tag's own color instead of the generic accent fill.
function tagToggleStyle(tag, selected) {
  return selected
    ? `background:${tag.color};border-color:${tag.color};color:#fff;`
    : `border-color:${tag.color}66;color:${tag.color};`;
}

function tagToggleChipHtml(tag, selected) {
  return `<button type="button" class="chip-option" data-tag-id="${tag.id}" style="${tagToggleStyle(tag, selected)}">#${escapeHtml(tag.name)}</button>`;
}

/* ---------------------------------------------------------------------
 * ACTIVITY (transactions: expense / income / transfer)
 * ------------------------------------------------------------------- */

function renderActivity() {
  if (!state.selectedAccountId) {
    renderAccountGrid();
  } else if (accountById(state.selectedAccountId)) {
    renderAccountDetail(state.selectedAccountId);
  } else {
    state.selectedAccountId = null;
    renderAccountGrid();
  }
}

function renderAccountGrid() {
  document.getElementById("activity-detail").hidden = true;
  document.getElementById("all-records-section").hidden = false;
  const grid = document.getElementById("account-grid");
  const empty = document.getElementById("account-grid-empty");
  grid.hidden = false;
  grid.innerHTML = "";
  const gridAccounts = realAccounts();
  empty.hidden = gridAccounts.length !== 0;

  if (gridAccounts.length > 0) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(gridAccounts.length)));
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

    const balances = computeBalances();
    for (const acc of gridAccounts) {
      const tile = document.createElement("div");
      tile.className = "account-tile";
      tile.setAttribute("role", "button");
      const balance = balances[acc.id];
      tile.innerHTML = `
        <button type="button" class="account-tile-menu-btn" aria-label="Account options">⋯</button>
        <div class="account-tile-icon" style="background:${acc.color}33">${acc.icon}</div>
        <div class="account-tile-info">
          <div class="account-tile-name">${escapeHtml(acc.name)}</div>
          <div class="account-tile-balance">${fmtAmount(balance)}</div>
        </div>
      `;
      tile.addEventListener("click", () => {
        state.selectedAccountId = acc.id;
        render();
      });
      tile.querySelector(".account-tile-menu-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        openAccountActionsMenu(acc);
      });
      grid.appendChild(tile);
    }
  }

  renderAllRecords();
}

// Shared row renderer for any record list that spans multiple accounts
// (main activity list, reports) — shows the account inline since it isn't
// implied by context, unlike the single-account detail list.
function createRecordListItem(t) {
  const li = document.createElement("li");
  li.className = "list-item";

  let icon, iconBg, title, sub;
  if (t.type === "transfer") {
    const from = accountById(t.accountId);
    const to = accountById(t.toAccountId);
    icon = "🔁";
    iconBg = "var(--border)";
    title = "Transfer";
    sub = `${from ? from.icon + " " + escapeHtml(from.name) : "—"} → ${to ? to.icon + " " + escapeHtml(to.name) : "—"}`;
  } else {
    const cat = categoryById(t.categoryId);
    const sub_ = subcategoryById(cat, t.subcategoryId);
    const acc = accountById(t.accountId);
    icon = cat ? cat.icon : "❓";
    iconBg = cat ? cat.color + "33" : "var(--border)";
    title = cat ? cat.name + (sub_ ? " · " + sub_.name : "") : "Uncategorized";
    sub = `${t.date} · ${acc ? acc.icon + " " + escapeHtml(acc.name) : "—"}`;
  }
  if (t.notes) sub += " · " + escapeHtml(t.notes);

  const tagsHtml = tagChipsHtml(t.tagIds);

  li.innerHTML = `
    <div class="item-icon" style="background:${iconBg}">${icon}</div>
    <div class="item-body">
      <div class="item-title">${escapeHtml(title)}</div>
      <div class="item-sub">${sub}</div>
      ${tagsHtml ? `<div style="margin-top:4px">${tagsHtml}</div>` : ""}
    </div>
    <div class="item-amount amount-${t.type}">${fmtSigned(t.amount, t.type)}</div>
  `;
  li.addEventListener("click", () => openTransactionForm(t));
  return li;
}

function renderAllRecords() {
  const list = document.getElementById("all-record-list");
  const empty = document.getElementById("all-record-empty");
  list.innerHTML = "";

  const records = state.dayMode ? dayTransactions() : state.weekMode ? weekTransactions() : state.transactions;

  const { moneyIn, moneyOut } = computeInOut(records, realAccounts().map((a) => a.id));
  document.getElementById("all-stat-income").textContent = fmtAmount(moneyIn);
  document.getElementById("all-stat-expense").textContent = fmtAmount(moneyOut);
  document.getElementById("all-stat-net").textContent = fmtAmount(moneyIn - moneyOut);
  document.getElementById("all-record-count").textContent = records.length + (records.length === 1 ? " record" : " records");

  empty.hidden = records.length !== 0;

  for (const t of records) {
    list.appendChild(createRecordListItem(t));
  }
}

function renderAccountDetail(accountId) {
  document.getElementById("account-grid").hidden = true;
  document.getElementById("account-grid-empty").hidden = true;
  document.getElementById("all-records-section").hidden = true;
  document.getElementById("activity-detail").hidden = false;

  const acc = accountById(accountId);
  const balances = computeBalances();
  document.getElementById("account-detail-header").innerHTML = `
    <div class="account-detail-card">
      <div class="item-icon" style="background:${acc.color}33">${acc.icon}</div>
      <div class="account-detail-info">
        <div class="account-detail-name">${escapeHtml(acc.name)}</div>
        <div class="account-detail-balance">${acc.isSystem ? "System account — no balance" : fmtAmount(balances[acc.id])}</div>
      </div>
      ${acc.isSystem ? "" : `<button type="button" class="adjust-balance-btn" id="adjust-balance-btn" title="Adjust balance">✎</button>`}
    </div>
  `;
  document.getElementById("adjust-balance-btn")?.addEventListener("click", () => openAdjustBalanceModal(accountId));

  const list = document.getElementById("spend-list");
  const empty = document.getElementById("spend-empty");
  list.innerHTML = "";

  const scoped = state.transactions.filter((t) => t.accountId === accountId || t.toAccountId === accountId);

  const { moneyIn, moneyOut } = computeInOut(scoped, [accountId]);
  document.getElementById("stat-income").textContent = fmtAmount(moneyIn);
  document.getElementById("stat-expense").textContent = fmtAmount(moneyOut);
  document.getElementById("stat-net").textContent = fmtAmount(moneyIn - moneyOut);
  document.getElementById("spend-count").textContent = scoped.length + (scoped.length === 1 ? " record" : " records");

  empty.hidden = scoped.length !== 0;

  for (const t of scoped) {
    const li = document.createElement("li");
    li.className = "list-item";

    let icon, iconBg, title, sub, amountClass, amountText;
    if (t.type === "transfer") {
      const outgoing = t.accountId === accountId;
      const other = accountById(outgoing ? t.toAccountId : t.accountId);
      icon = "🔁";
      iconBg = "var(--border)";
      title = outgoing ? "Transfer out" : "Transfer in";
      sub = `${outgoing ? "To" : "From"} ${other ? other.icon + " " + escapeHtml(other.name) : "—"}`;
      amountClass = outgoing ? "amount-expense" : "amount-income";
      amountText = (outgoing ? "−" : "+") + fmtAmount(t.amount);
    } else {
      const cat = categoryById(t.categoryId);
      const sub_ = subcategoryById(cat, t.subcategoryId);
      icon = cat ? cat.icon : "❓";
      iconBg = cat ? cat.color + "33" : "var(--border)";
      title = cat ? cat.name + (sub_ ? " · " + sub_.name : "") : "Uncategorized";
      sub = t.date;
      amountClass = "amount-" + t.type;
      amountText = fmtSigned(t.amount, t.type);
    }
    if (t.notes) sub += " · " + escapeHtml(t.notes);

    const tagsHtml = tagChipsHtml(t.tagIds);

    li.innerHTML = `
      <div class="item-icon" style="background:${iconBg}">${icon}</div>
      <div class="item-body">
        <div class="item-title">${escapeHtml(title)}</div>
        <div class="item-sub">${sub}</div>
        ${tagsHtml ? `<div style="margin-top:4px">${tagsHtml}</div>` : ""}
      </div>
      <div class="item-amount ${amountClass}">${amountText}</div>
    `;
    li.addEventListener("click", () => openTransactionForm(t, accountId));
    list.appendChild(li);
  }
}

function openAdjustBalanceModal(accountId) {
  const acc = accountById(accountId);
  const balances = computeBalances();
  const currentBalance = balances[accountId];

  openModal(`
    <div class="modal-header">
      <h2>Adjust Balance</h2>
      <button class="modal-close" id="modal-close-btn">✕</button>
    </div>
    <form id="adjust-balance-form">
      <div class="field">
        <label>${escapeHtml(acc.name)} — Current Balance (֏)</label>
        <input type="text" id="f-new-balance" inputmode="decimal" pattern="-?[0-9]*[.,]?[0-9]*" value="${round2(currentBalance)}" required>
        <p style="color:var(--text-dim); font-size:12px; margin-top:6px;">A Transfer record to/from Out of Wallet will be created automatically for the difference.</p>
      </div>
      <button type="submit" class="primary-btn">Save</button>
    </form>
  `);

  document.getElementById("modal-close-btn").addEventListener("click", closeModal);

  document.getElementById("adjust-balance-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const newBalance = round2(parseAmountInput(document.getElementById("f-new-balance").value));
    await createBalanceAdjustment(accountId, newBalance - currentBalance);
    closeModal();
    await reloadTransactions();
    render();
    toast("Balance adjusted");
  });
}

function openTransactionForm(existing, defaultAccountId) {
  if (realAccounts().length === 0) {
    toast("Add an account first");
    return;
  }

  const isEdit = !!existing;
  const type = existing ? existing.type : "expense";
  const defaultDate = existing ? existing.date : suggestedDateForMonth(state.month);

  const realAccountOptions = (selectedId) =>
    `<option value="" disabled ${selectedId ? "" : "selected"}>Select account</option>` +
    realAccounts().map((a) => `<option value="${a.id}" ${selectedId === a.id ? "selected" : ""}>${a.icon} ${escapeHtml(a.name)}</option>`).join("");
  const transferAccountOptions = (selectedId, excludeId) =>
    `<option value="" disabled ${selectedId ? "" : "selected"}>Select account</option>` +
    state.accounts
      .filter((a) => a.id !== excludeId)
      .map((a) => `<option value="${a.id}" ${selectedId === a.id ? "selected" : ""}>${a.icon} ${escapeHtml(a.name)}</option>`)
      .join("");
  const sortedCategories = [...state.categories].sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));
  const categoryOptions = sortedCategories.length
    ? `<option value="" disabled ${existing ? "" : "selected"}>Select category</option>` +
      sortedCategories.map((c) => `<option value="${c.id}" ${existing && existing.categoryId === c.id ? "selected" : ""}>${c.icon} ${escapeHtml(c.name)}</option>`).join("")
    : `<option value="" disabled selected>No categories — add one first</option>`;
  const tagChips = state.tags
    .map((t) => tagToggleChipHtml(t, existing && (existing.tagIds || []).includes(t.id)))
    .join("");

  openModal(`
    <div class="modal-header">
      <h2>${isEdit ? "Edit Record" : "Add Record"}</h2>
      <button class="modal-close" id="modal-close-btn">✕</button>
    </div>
    <form id="tx-form">
      <div class="field">
        <label>Type</label>
        <div class="segmented" id="f-type">
          ${TX_TYPES.map((t) => `<button type="button" class="segment ${type === t.value ? "active" : ""}" data-type="${t.value}">${t.label}</button>`).join("")}
        </div>
      </div>
      <div class="field">
        <label>Amount (֏)</label>
        <input type="text" id="f-amount" inputmode="decimal" pattern="[0-9]*[.,]?[0-9]*" placeholder="0" value="${existing ? existing.amount : ""}" required>
      </div>

      <div class="field" data-role="single-account">
        <label id="f-account-label">Account</label>
        <select id="f-account" required>${realAccountOptions(existing ? existing.accountId : defaultAccountId)}</select>
      </div>

      <div class="field" data-role="transfer-accounts" hidden>
        <label>From Account</label>
        <select id="f-from-account">${transferAccountOptions(existing ? existing.accountId : defaultAccountId, existing ? existing.toAccountId : null)}</select>
      </div>
      <div class="field" data-role="transfer-accounts" hidden>
        <label>To Account</label>
        <select id="f-to-account">${transferAccountOptions(existing ? existing.toAccountId : null, existing ? existing.accountId : defaultAccountId)}</select>
      </div>

      <div class="field" data-role="category">
        <label>Category</label>
        <select id="f-category">${categoryOptions}</select>
      </div>
      <div class="field" data-role="subcategory" hidden>
        <label>Subcategory</label>
        <select id="f-subcategory"></select>
      </div>

      <div class="field">
        <label>Date</label>
        <input type="date" id="f-date" value="${defaultDate}" required>
      </div>

      ${state.tags.length ? `<div class="field"><label>Tags</label><div class="chip-grid" id="f-tags">${tagChips}</div></div>` : ""}
      <div class="field">
        <label>Notes</label>
        <textarea id="f-notes">${existing ? escapeHtml(existing.notes || "") : ""}</textarea>
      </div>
      <button type="submit" class="primary-btn">${isEdit ? "Save Changes" : "Add Record"}</button>
      ${isEdit ? `<button type="button" class="danger-btn" id="delete-tx-btn">Delete</button>` : ""}
    </form>
  `);

  if (!isEdit) document.getElementById("f-amount").focus();

  let currentType = type;
  function applyTypeVisibility() {
    const singleWrap = document.querySelector('[data-role="single-account"]');
    const transferWraps = document.querySelectorAll('[data-role="transfer-accounts"]');
    const categoryWrap = document.querySelector('[data-role="category"]');
    const isTransfer = currentType === "transfer";

    singleWrap.hidden = isTransfer;
    document.getElementById("f-account").required = !isTransfer;
    document.getElementById("f-account-label").textContent = currentType === "income" ? "To Account" : "Account";

    transferWraps.forEach((w) => (w.hidden = !isTransfer));
    document.getElementById("f-from-account").required = isTransfer;
    document.getElementById("f-to-account").required = isTransfer;

    categoryWrap.hidden = isTransfer;
    document.getElementById("f-category").required = !isTransfer;
    if (isTransfer) {
      document.querySelector('[data-role="subcategory"]').hidden = true;
      document.getElementById("f-subcategory").required = false;
    } else {
      updateSubcategoryOptions();
    }
  }

  function updateSubcategoryOptions() {
    const cat = categoryById(document.getElementById("f-category").value);
    const wrap = document.querySelector('[data-role="subcategory"]');
    const select = document.getElementById("f-subcategory");
    if (!cat || !cat.subcategories || cat.subcategories.length === 0) {
      wrap.hidden = true;
      select.innerHTML = "";
      return;
    }
    wrap.hidden = false;
    const preselect = existing && existing.categoryId === cat.id ? existing.subcategoryId : null;
    const sortedSubs = [...cat.subcategories].sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));
    select.innerHTML = `<option value="">None</option>` + sortedSubs.map(
      (s) => `<option value="${s.id}" ${preselect === s.id ? "selected" : ""}>${escapeHtml(s.name)}</option>`
    ).join("");
  }

  applyTypeVisibility();

  document.getElementById("f-type").addEventListener("click", (e) => {
    const btn = e.target.closest(".segment");
    if (!btn) return;
    currentType = btn.dataset.type;
    document.querySelectorAll("#f-type .segment").forEach((b) => b.classList.toggle("active", b === btn));
    applyTypeVisibility();
  });

  document.getElementById("f-category").addEventListener("change", updateSubcategoryOptions);

  document.getElementById("f-from-account").addEventListener("change", (e) => {
    const toSelect = document.getElementById("f-to-account");
    const keepTo = toSelect.value;
    toSelect.innerHTML = transferAccountOptions(keepTo, e.target.value);
  });
  document.getElementById("f-to-account").addEventListener("change", (e) => {
    const fromSelect = document.getElementById("f-from-account");
    const keepFrom = fromSelect.value;
    fromSelect.innerHTML = transferAccountOptions(keepFrom, e.target.value);
  });

  const selectedTagIds = new Set(existing ? existing.tagIds || [] : []);
  document.getElementById("f-tags")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip-option");
    if (!btn) return;
    const id = btn.dataset.tagId;
    const tag = tagById(id);
    const nowSelected = !selectedTagIds.has(id);
    if (nowSelected) selectedTagIds.add(id);
    else selectedTagIds.delete(id);
    if (tag) btn.setAttribute("style", tagToggleStyle(tag, nowSelected));
  });

  document.getElementById("modal-close-btn").addEventListener("click", closeModal);

  if (isEdit) {
    document.getElementById("delete-tx-btn").addEventListener("click", async () => {
      if (!confirm("Delete this record?")) return;
      await DB.delete("transactions", existing.id);
      closeModal();
      await reloadTransactions();
      render();
      toast("Record deleted");
    });
  }

  document.getElementById("tx-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const amount = round2(parseAmountInput(document.getElementById("f-amount").value));
    const date = document.getElementById("f-date").value;
    const notes = document.getElementById("f-notes").value.trim();
    if (!(amount > 0) || !date) return;

    let accountId, toAccountId = null, categoryId = null, subcategoryId = null;

    if (currentType === "transfer") {
      accountId = document.getElementById("f-from-account").value;
      toAccountId = document.getElementById("f-to-account").value;
      if (!accountId || !toAccountId || accountId === toAccountId) {
        toast("From and To accounts must be different");
        return;
      }
    } else {
      accountId = document.getElementById("f-account").value;
      categoryId = document.getElementById("f-category").value;
      if (!categoryId) {
        toast("Add a category first");
        return;
      }
      subcategoryId = document.getElementById("f-subcategory").value || null;
    }

    const record = {
      id: existing ? existing.id : uid(),
      month: date.slice(0, 7),
      date,
      type: currentType,
      amount,
      accountId,
      toAccountId,
      categoryId,
      subcategoryId,
      tagIds: Array.from(selectedTagIds),
      notes,
      createdAt: existing ? existing.createdAt : Date.now(),
    };
    await DB.put("transactions", record);
    if (!isEdit && categoryId) await incrementCategoryUsage(categoryId, subcategoryId);
    closeModal();
    state.month = record.month;
    await reloadTransactions();
    render();
    toast(isEdit ? "Record updated" : "Record added");
  });
}

function suggestedDateForMonth(monthStr) {
  const today = new Date();
  const todayMonth = currentMonthStr();
  if (monthStr === todayMonth) {
    return today.toISOString().slice(0, 10);
  }
  return monthStr + "-01";
}

/* ---------------------------------------------------------------------
 * ACCOUNTS
 * ------------------------------------------------------------------- */

function renderAccounts() {
  const list = document.getElementById("account-list");
  const empty = document.getElementById("account-empty");
  list.innerHTML = "";
  empty.hidden = state.accounts.length !== 0;

  const balances = computeBalances();

  for (const acc of state.accounts) {
    const li = document.createElement("li");
    li.className = "list-item";
    const balance = balances[acc.id];
    const balanceHtml = acc.isSystem
      ? `<div class="item-sub">—</div>`
      : `<div class="account-balance">${fmtAmount(balance)}</div>`;
    li.innerHTML = `
      <div class="item-icon" style="background:${acc.color}33">${acc.icon}</div>
      <div class="item-body">
        <div class="item-title">${escapeHtml(acc.name)}${acc.isSystem ? '<span class="system-badge">System</span>' : ""}</div>
        <div class="item-sub">${ACCOUNT_TYPES.find((t) => t.value === acc.type)?.label || ""}</div>
      </div>
      ${balanceHtml}
    `;
    li.addEventListener("click", () => (acc.isSystem ? openSystemAccountInfo(acc) : openAccountForm(acc)));
    list.appendChild(li);
  }
}

function openSystemAccountInfo(acc) {
  openModal(`
    <div class="modal-header">
      <h2>${acc.icon} ${escapeHtml(acc.name)}</h2>
      <button class="modal-close" id="modal-close-btn">✕</button>
    </div>
    <p style="color:var(--text-dim); font-size:14px; line-height:1.5;">
      This is a fixed system account used as the counterpart for transfers you don't want to track
      elsewhere — and for balance corrections. It has no balance of its own, can't be edited, and can't be deleted.
    </p>
  `);
  document.getElementById("modal-close-btn").addEventListener("click", closeModal);
}

async function deleteAccountWithGuard(acc) {
  const [asAccount, asToAccount] = await Promise.all([
    DB.getAllByIndex("transactions", "accountId", acc.id),
    DB.getAllByIndex("transactions", "toAccountId", acc.id),
  ]);
  const usageCount = asAccount.length + asToAccount.length;
  if (usageCount > 0) {
    toast(`Can't delete: used by ${usageCount} record${usageCount === 1 ? "" : "s"}`);
    return;
  }
  if (!confirm("Delete this account?")) return;
  await DB.delete("accounts", acc.id);
  closeModal();
  await reloadReferenceData();
  render();
  toast("Account deleted");
}

function openAccountActionsMenu(acc) {
  openModal(`
    <div class="modal-header">
      <h2>${acc.icon} ${escapeHtml(acc.name)}</h2>
      <button class="modal-close" id="modal-close-btn">✕</button>
    </div>
    <button type="button" class="secondary-btn" id="menu-edit-btn">Edit Account</button>
    <button type="button" class="danger-btn" id="menu-delete-btn">Delete Account</button>
  `);
  document.getElementById("modal-close-btn").addEventListener("click", closeModal);
  document.getElementById("menu-edit-btn").addEventListener("click", () => openAccountForm(acc));
  document.getElementById("menu-delete-btn").addEventListener("click", () => deleteAccountWithGuard(acc));
}

function openAccountForm(existing) {
  const isEdit = !!existing;
  const typeOptions = ACCOUNT_TYPES.map(
    (t) => `<option value="${t.value}" ${existing && existing.type === t.value ? "selected" : ""}>${t.label}</option>`
  ).join("");
  const iconGrid = ACCOUNT_ICONS.map(
    (icon) => `<button type="button" class="icon-option ${existing && existing.icon === icon ? "selected" : ""}" data-icon="${icon}">${icon}</button>`
  ).join("");
  const colorSwatches = COLOR_PALETTE.map(
    (color) => `<button type="button" class="icon-option ${existing && existing.color === color ? "selected" : ""}" data-color="${color}" style="background:${color}"></button>`
  ).join("");

  openModal(`
    <div class="modal-header">
      <h2>${isEdit ? "Edit Account" : "Add Account"}</h2>
      <button class="modal-close" id="modal-close-btn">✕</button>
    </div>
    <form id="account-form">
      <div class="field">
        <label>Name</label>
        <input type="text" id="f-name" value="${existing ? escapeHtml(existing.name) : ""}" placeholder="e.g. Main Card" required>
      </div>
      <div class="field">
        <label>Type</label>
        <select id="f-type">${typeOptions}</select>
      </div>
      <div class="field">
        <label>Color</label>
        <div class="icon-grid" id="f-color">${colorSwatches}</div>
      </div>
      <div class="field">
        <label>Icon</label>
        <div class="icon-grid" id="f-icon">${iconGrid}</div>
      </div>
      <div class="field">
        <label>Initial Balance (֏)</label>
        <input type="text" id="f-balance" inputmode="decimal" pattern="-?[0-9]*[.,]?[0-9]*" value="${isEdit ? round2(existing.initialBalance || 0) : 0}" required>
        ${isEdit ? `<p style="color:var(--text-dim); font-size:12px; margin-top:6px;">Directly edits the starting balance — no transaction is created. To correct the current balance instead, use Adjust Balance in the account view.</p>` : ""}
      </div>
      <button type="submit" class="primary-btn">${isEdit ? "Save Changes" : "Add Account"}</button>
      ${isEdit ? `<button type="button" class="danger-btn" id="delete-account-btn">Delete</button>` : ""}
    </form>
  `);

  let selectedIcon = existing ? existing.icon : ACCOUNT_ICONS[0];
  let selectedColor = existing ? existing.color : COLOR_PALETTE[0];
  document.getElementById("f-icon").addEventListener("click", (e) => {
    const btn = e.target.closest(".icon-option");
    if (!btn) return;
    selectedIcon = btn.dataset.icon;
    document.querySelectorAll("#f-icon .icon-option").forEach((b) => b.classList.toggle("selected", b === btn));
  });
  document.getElementById("f-color").addEventListener("click", (e) => {
    const btn = e.target.closest(".icon-option");
    if (!btn) return;
    selectedColor = btn.dataset.color;
    document.querySelectorAll("#f-color .icon-option").forEach((b) => b.classList.toggle("selected", b === btn));
  });
  if (!existing) {
    document.querySelector("#f-icon .icon-option")?.classList.add("selected");
    document.querySelector("#f-color .icon-option")?.classList.add("selected");
  }

  document.getElementById("modal-close-btn").addEventListener("click", closeModal);

  if (isEdit) {
    document.getElementById("delete-account-btn").addEventListener("click", () => deleteAccountWithGuard(existing));
  }

  document.getElementById("account-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("f-name").value.trim();
    const type = document.getElementById("f-type").value;
    const balanceInput = round2(parseAmountInput(document.getElementById("f-balance").value));
    if (!name) return;

    if (isEdit) {
      const record = {
        ...existing,
        name,
        type,
        icon: selectedIcon,
        color: selectedColor,
        initialBalance: balanceInput,
      };
      await DB.put("accounts", record);
    } else {
      const record = {
        id: uid(),
        name,
        type,
        icon: selectedIcon,
        color: selectedColor,
        initialBalance: balanceInput,
        isSystem: false,
        createdAt: Date.now(),
      };
      await DB.put("accounts", record);
    }

    closeModal();
    await reloadReferenceData();
    await reloadTransactions();
    render();
    toast(isEdit ? "Account updated" : "Account added");
  });
}

/* ---------------------------------------------------------------------
 * CATEGORIES (with embedded subcategories)
 * ------------------------------------------------------------------- */

function renderCategories() {
  const list = document.getElementById("category-list");
  const empty = document.getElementById("category-empty");
  list.innerHTML = "";
  empty.hidden = state.categories.length !== 0;

  for (const cat of state.categories) {
    const li = document.createElement("li");
    li.className = "list-item";
    const subs = cat.subcategories || [];
    const subsHtml = subs.length
      ? `<div style="margin-top:4px">${subs.map((s) => `<span class="tag-chip">${escapeHtml(s.name)}</span>`).join("")}</div>`
      : "";
    li.innerHTML = `
      <div class="item-icon" style="background:${cat.color}33">${cat.icon}</div>
      <div class="item-body">
        <div class="item-title">${escapeHtml(cat.name)}</div>
        ${subsHtml}
      </div>
      <div class="item-chevron">›</div>
    `;
    li.addEventListener("click", () => openCategoryForm(cat));
    list.appendChild(li);
  }
}

function openCategoryForm(existing) {
  const isEdit = !!existing;
  const iconGrid = CATEGORY_ICONS.map(
    (icon) => `<button type="button" class="icon-option ${existing && existing.icon === icon ? "selected" : ""}" data-icon="${icon}">${icon}</button>`
  ).join("");
  const colorSwatches = COLOR_PALETTE.map(
    (color) => `<button type="button" class="icon-option ${existing && existing.color === color ? "selected" : ""}" data-color="${color}" style="background:${color}"></button>`
  ).join("");

  openModal(`
    <div class="modal-header">
      <h2>${isEdit ? "Edit Category" : "Add Category"}</h2>
      <button class="modal-close" id="modal-close-btn">✕</button>
    </div>
    <form id="category-form">
      <div class="field">
        <label>Name</label>
        <input type="text" id="f-name" value="${existing ? escapeHtml(existing.name) : ""}" placeholder="e.g. Groceries" required>
      </div>
      <div class="field">
        <label>Color</label>
        <div class="icon-grid" id="f-color">${colorSwatches}</div>
      </div>
      <div class="field">
        <label>Icon</label>
        <div class="icon-grid" id="f-icon">${iconGrid}</div>
      </div>
      <div class="field">
        <label>Subcategories</label>
        <div id="subcat-list"></div>
        <div class="subcat-add-row">
          <input type="text" id="subcat-new-name" placeholder="New subcategory">
          <button type="button" class="secondary-btn subcat-add-btn" id="subcat-add-btn">Add</button>
        </div>
      </div>
      <button type="submit" class="primary-btn">${isEdit ? "Save Changes" : "Add Category"}</button>
      ${isEdit ? `<button type="button" class="danger-btn" id="delete-category-btn">Delete</button>` : ""}
    </form>
  `);

  let selectedIcon = existing ? existing.icon : CATEGORY_ICONS[0];
  let selectedColor = existing ? existing.color : COLOR_PALETTE[0];
  let localSubcats = existing ? (existing.subcategories || []).map((s) => ({ ...s })) : [];

  function renderSubcatRows() {
    const container = document.getElementById("subcat-list");
    container.innerHTML = localSubcats.map((s) => `
      <div class="subcat-row" data-id="${s.id}">
        <input type="text" class="subcat-name-input" value="${escapeHtml(s.name)}">
        <button type="button" class="subcat-delete-btn" title="Delete">✕</button>
      </div>
    `).join("");
  }
  renderSubcatRows();

  document.getElementById("subcat-list").addEventListener("click", async (e) => {
    const row = e.target.closest(".subcat-row");
    if (!row) return;
    const id = row.dataset.id;

    if (e.target.classList.contains("subcat-delete-btn")) {
      const usage = await DB.getAllByIndex("transactions", "subcategoryId", id);
      if (usage.length > 0) {
        toast(`Can't delete: used by ${usage.length} record${usage.length === 1 ? "" : "s"}`);
        return;
      }
      localSubcats = localSubcats.filter((s) => s.id !== id);
      renderSubcatRows();
    }
  });
  document.getElementById("subcat-list").addEventListener("input", (e) => {
    const row = e.target.closest(".subcat-row");
    if (!row || !e.target.classList.contains("subcat-name-input")) return;
    const sub = localSubcats.find((s) => s.id === row.dataset.id);
    if (sub) sub.name = e.target.value;
  });

  document.getElementById("subcat-add-btn").addEventListener("click", () => {
    const input = document.getElementById("subcat-new-name");
    const name = input.value.trim();
    if (!name) return;
    localSubcats.push({ id: uid(), name, usageCount: 0, createdAt: Date.now() });
    input.value = "";
    renderSubcatRows();
  });

  document.getElementById("f-icon").addEventListener("click", (e) => {
    const btn = e.target.closest(".icon-option");
    if (!btn) return;
    selectedIcon = btn.dataset.icon;
    document.querySelectorAll("#f-icon .icon-option").forEach((b) => b.classList.toggle("selected", b === btn));
  });
  document.getElementById("f-color").addEventListener("click", (e) => {
    const btn = e.target.closest(".icon-option");
    if (!btn) return;
    selectedColor = btn.dataset.color;
    document.querySelectorAll("#f-color .icon-option").forEach((b) => b.classList.toggle("selected", b === btn));
  });
  if (!existing) {
    document.querySelector("#f-icon .icon-option")?.classList.add("selected");
    document.querySelector("#f-color .icon-option")?.classList.add("selected");
  }

  document.getElementById("modal-close-btn").addEventListener("click", closeModal);

  if (isEdit) {
    document.getElementById("delete-category-btn").addEventListener("click", async () => {
      const subIds = (existing.subcategories || []).map((s) => s.id);
      const [byCategory, allTx] = await Promise.all([
        DB.getAllByIndex("transactions", "categoryId", existing.id),
        subIds.length ? DB.getAll("transactions") : Promise.resolve([]),
      ]);
      const bySubcategory = allTx.filter((t) => subIds.includes(t.subcategoryId));
      const usageCount = byCategory.length + bySubcategory.length;
      if (usageCount > 0) {
        toast(`Can't delete: used by ${usageCount} record${usageCount === 1 ? "" : "s"}`);
        return;
      }
      if (!confirm("Delete this category?")) return;
      await DB.delete("categories", existing.id);
      closeModal();
      await reloadReferenceData();
      render();
      toast("Category deleted");
    });
  }

  document.getElementById("category-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("f-name").value.trim();
    if (!name) return;
    const record = {
      id: existing ? existing.id : uid(),
      name,
      color: selectedColor,
      icon: selectedIcon,
      usageCount: existing ? existing.usageCount || 0 : 0,
      subcategories: localSubcats.map((s) => ({ ...s, name: s.name.trim() })).filter((s) => s.name),
      createdAt: existing ? existing.createdAt : Date.now(),
    };
    await DB.put("categories", record);
    closeModal();
    await reloadReferenceData();
    render();
    toast(isEdit ? "Category updated" : "Category added");
  });
}

/* ---------------------------------------------------------------------
 * TAGS
 * ------------------------------------------------------------------- */

function renderTags() {
  const list = document.getElementById("tag-list");
  const empty = document.getElementById("tag-empty");
  list.innerHTML = "";
  empty.hidden = state.tags.length !== 0;

  for (const tag of state.tags) {
    const li = document.createElement("li");
    li.className = "list-item";
    li.innerHTML = `
      <div class="item-body">
        <span class="tag-chip" style="background:${tag.color}33;color:${tag.color}">#${escapeHtml(tag.name)}</span>
      </div>
      <div class="item-chevron">›</div>
    `;
    li.addEventListener("click", () => openTagForm(tag));
    list.appendChild(li);
  }
}

function openTagForm(existing) {
  const isEdit = !!existing;
  const colorSwatches = COLOR_PALETTE.map(
    (color) => `<button type="button" class="icon-option ${existing && existing.color === color ? "selected" : ""}" data-color="${color}" style="background:${color}"></button>`
  ).join("");

  openModal(`
    <div class="modal-header">
      <h2>${isEdit ? "Edit Tag" : "Add Tag"}</h2>
      <button class="modal-close" id="modal-close-btn">✕</button>
    </div>
    <form id="tag-form">
      <div class="field">
        <label>Name</label>
        <input type="text" id="f-name" value="${existing ? escapeHtml(existing.name) : ""}" placeholder="e.g. trip-italy" required>
      </div>
      <div class="field">
        <label>Color</label>
        <div class="icon-grid" id="f-color">${colorSwatches}</div>
      </div>
      <button type="submit" class="primary-btn">${isEdit ? "Save Changes" : "Add Tag"}</button>
      ${isEdit ? `<button type="button" class="danger-btn" id="delete-tag-btn">Delete</button>` : ""}
    </form>
  `);

  let selectedColor = existing ? existing.color : COLOR_PALETTE[0];
  document.getElementById("f-color").addEventListener("click", (e) => {
    const btn = e.target.closest(".icon-option");
    if (!btn) return;
    selectedColor = btn.dataset.color;
    document.querySelectorAll("#f-color .icon-option").forEach((b) => b.classList.toggle("selected", b === btn));
  });
  if (!existing) {
    document.querySelector("#f-color .icon-option")?.classList.add("selected");
  }

  document.getElementById("modal-close-btn").addEventListener("click", closeModal);

  if (isEdit) {
    document.getElementById("delete-tag-btn").addEventListener("click", async () => {
      const usage = await DB.getAllByIndex("transactions", "tagIds", existing.id);
      if (usage.length > 0) {
        toast(`Can't delete: used by ${usage.length} record${usage.length === 1 ? "" : "s"}`);
        return;
      }
      if (!confirm("Delete this tag?")) return;
      await DB.delete("tags", existing.id);
      closeModal();
      await reloadReferenceData();
      render();
      toast("Tag deleted");
    });
  }

  document.getElementById("tag-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("f-name").value.trim();
    if (!name) return;
    const record = {
      id: existing ? existing.id : uid(),
      name,
      color: selectedColor,
      createdAt: existing ? existing.createdAt : Date.now(),
    };
    await DB.put("tags", record);
    closeModal();
    await reloadReferenceData();
    render();
    toast(isEdit ? "Tag updated" : "Tag added");
  });
}

/* ---------------------------------------------------------------------
 * REPORTS
 * ------------------------------------------------------------------- */

function wireReports() {
  document.getElementById("report-range-btns").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    state.reportRange = btn.dataset.range;
    if (state.reportRange === "custom" && !state.reportFrom && !state.reportTo) {
      const { start, end } = reportRangeDates();
      state.reportFrom = start;
      state.reportTo = end;
    }
    render();
  });
  document.getElementById("report-from").addEventListener("change", (e) => {
    state.reportFrom = e.target.value;
    render();
  });
  document.getElementById("report-to").addEventListener("change", (e) => {
    state.reportTo = e.target.value;
    render();
  });
  document.getElementById("report-filter-mode-btns").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    state.reportFilterMode = btn.dataset.mode;
    render();
  });
  document.getElementById("report-category-chips").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip-option");
    if (!btn) return;
    const activeIds = state.reportFilterMode === "exclude" ? state.reportExcludeIds : state.reportIncludeIds;
    toggleId(activeIds, btn.dataset.catId);
    render();
  });
  document.getElementById("report-tag-mode-btns").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    state.reportTagFilterMode = btn.dataset.mode;
    render();
  });
  document.getElementById("report-tag-chips").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip-option");
    if (!btn) return;
    const activeIds = state.reportTagFilterMode === "exclude" ? state.reportTagExcludeIds : state.reportTagIncludeIds;
    toggleId(activeIds, btn.dataset.tagId);
    render();
  });
}

function renderCategoryChipGroup(containerId, selectedIds) {
  document.getElementById(containerId).innerHTML = state.categories.map((c) =>
    `<button type="button" class="chip-option ${selectedIds.includes(c.id) ? "selected" : ""}" data-cat-id="${c.id}">${c.icon} ${escapeHtml(c.name)}</button>`
  ).join("");
}

function renderTagChipGroup(containerId, selectedIds) {
  document.getElementById(containerId).innerHTML = state.tags
    .map((t) => tagToggleChipHtml(t, selectedIds.includes(t.id)))
    .join("");
}

function renderCategoryChart(records) {
  const donut = document.getElementById("category-donut");
  const legend = document.getElementById("category-legend");
  const empty = document.getElementById("category-chart-empty");

  const totals = new Map(); // categoryId -> amount
  for (const t of records) {
    if (t.type !== "expense") continue;
    totals.set(t.categoryId, (totals.get(t.categoryId) || 0) + t.amount);
  }
  const total = [...totals.values()].reduce((a, b) => a + b, 0);

  if (total <= 0) {
    donut.hidden = true;
    legend.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  donut.hidden = false;

  const entries = [...totals.entries()]
    .map(([catId, amount]) => ({ cat: categoryById(catId), amount }))
    .sort((a, b) => b.amount - a.amount);

  let cursor = 0;
  const stops = entries.map(({ cat, amount }) => {
    const color = cat ? cat.color : "var(--text-dim)";
    const from = (cursor / total) * 100;
    cursor += amount;
    const to = (cursor / total) * 100;
    return `${color} ${from}% ${to}%`;
  });
  donut.style.background = `conic-gradient(${stops.join(", ")})`;
  document.getElementById("category-donut-total").textContent = fmtAmount(total);

  legend.innerHTML = entries.map(({ cat, amount }) => `
    <div class="category-legend-row">
      <span class="category-legend-dot" style="background:${cat ? cat.color : "var(--text-dim)"}"></span>
      <span class="category-legend-name">${cat ? cat.icon + " " + escapeHtml(cat.name) : "❓ Uncategorized"}</span>
      <span class="category-legend-pct">${Math.round((amount / total) * 100)}%</span>
      <span class="category-legend-amount">${fmtAmount(amount)}</span>
    </div>
  `).join("");
}

function renderReports() {
  document.querySelectorAll("#report-range-btns button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.range === state.reportRange);
  });
  document.getElementById("report-custom-range").hidden = state.reportRange !== "custom";

  const { start, end } = reportRangeDates();
  document.getElementById("report-from").value = state.reportRange === "custom" ? state.reportFrom || start : start;
  document.getElementById("report-to").value = state.reportRange === "custom" ? state.reportTo || end : end;

  document.querySelectorAll("#report-filter-mode-btns button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === state.reportFilterMode);
  });
  const activeIds = state.reportFilterMode === "exclude" ? state.reportExcludeIds : state.reportIncludeIds;
  renderCategoryChipGroup("report-category-chips", activeIds);

  document.querySelectorAll("#report-tag-mode-btns button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === state.reportTagFilterMode);
  });
  const activeTagIds = state.reportTagFilterMode === "exclude" ? state.reportTagExcludeIds : state.reportTagIncludeIds;
  renderTagChipGroup("report-tag-chips", activeTagIds);

  const records = reportFilteredTransactions();

  const list = document.getElementById("report-record-list");
  const empty = document.getElementById("report-record-empty");
  list.innerHTML = "";

  const { moneyIn, moneyOut } = computeInOut(records, realAccounts().map((a) => a.id));
  document.getElementById("report-stat-income").textContent = fmtAmount(moneyIn);
  document.getElementById("report-stat-expense").textContent = fmtAmount(moneyOut);
  document.getElementById("report-stat-net").textContent = fmtAmount(moneyIn - moneyOut);
  document.getElementById("report-record-count").textContent = records.length + (records.length === 1 ? " record" : " records");

  empty.hidden = records.length !== 0;

  for (const t of records) {
    list.appendChild(createRecordListItem(t));
  }

  renderCategoryChart(records);
}

/* ---------------------------------------------------------------------
 * EXPORT
 * ------------------------------------------------------------------- */

function wireExport() {
  document.getElementById("export-btn").addEventListener("click", exportCurrentMonth);
}

async function exportCurrentMonth() {
  const records = await DB.getAllByIndex("transactions", "month", state.month);
  const payload = {
    month: state.month,
    currency: "AMD",
    exportedAt: new Date().toISOString(),
    records: records.map((t) => {
      const acc = accountById(t.accountId);
      const toAcc = accountById(t.toAccountId);
      const cat = categoryById(t.categoryId);
      const sub = subcategoryById(cat, t.subcategoryId);
      return {
        id: t.id,
        date: t.date,
        type: t.type,
        amount: t.amount,
        account: acc ? acc.name : null,
        toAccount: t.type === "transfer" ? (toAcc ? toAcc.name : null) : undefined,
        category: cat ? cat.name : null,
        subcategory: sub ? sub.name : null,
        tags: (t.tagIds || []).map((tid) => tagById(tid)?.name).filter(Boolean),
        notes: t.notes || "",
        isAdjustment: !!t.isAdjustment,
      };
    }),
  };

  const json = JSON.stringify(payload, null, 2);
  const filename = `spends-${state.month}.json`;
  const blob = new Blob([json], { type: "application/json" });

  if (navigator.canShare && navigator.canShare({ files: [new File([blob], filename, { type: "application/json" })] })) {
    try {
      await navigator.share({ files: [new File([blob], filename, { type: "application/json" })], title: filename });
      toast(`Shared ${records.length} record(s)`);
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
      // fall through to download
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(`Downloaded ${records.length} record(s) as ${filename}`);
}

/* ---------------------------------------------------------------------
 * Modal / toast helpers
 * ------------------------------------------------------------------- */

function wireModal() {
  document.getElementById("modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "modal-backdrop") closeModal();
  });
}

let modalScrollY = 0;

function openModal(html) {
  document.getElementById("modal-sheet").innerHTML = html;
  document.getElementById("modal-backdrop").hidden = false;
  modalScrollY = window.scrollY;
  document.body.style.position = "fixed";
  document.body.style.top = `-${modalScrollY}px`;
  document.body.style.left = "0";
  document.body.style.right = "0";
}

function closeModal() {
  document.getElementById("modal-backdrop").hidden = true;
  document.getElementById("modal-sheet").innerHTML = "";
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";
  window.scrollTo(0, modalScrollY);
}

let toastTimer = null;
function toast(message) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2200);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
