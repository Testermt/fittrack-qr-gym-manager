/**
 * FitTrack QR Gym Manager — Firebase configuration & shared helpers
 */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAJ9L0CZF-wST70GQlxqO7g89ExDQkJkGw",
  authDomain: "fittrack-gym-9d2a2.firebaseapp.com",
  projectId: "fittrack-gym-9d2a2",
  storageBucket: "fittrack-gym-9d2a2.firebasestorage.app",
  messagingSenderId: "12572347727",
  appId: "1:12572347727:web:8fc708a4cebfa3d1f5893a",
  measurementId: "G-XGQ8Q3J78Z"
};

// ---- Gym-level settings ------------------------------------------------
// These two objects are now LIVE CONFIG, sourced from Firestore
// (settings/gymConfig) and only *seeded* with the values below as a
// last-resort fallback (used if this is the very first load with no
// cached copy yet, and the network/Firestore read fails).
//
// IMPORTANT: kept as `let` + mutated IN PLACE (not reassigned) via
// Object.assign so every existing `GYM_SETTINGS.name` / `PLANS[id]`
// reference across member.js/admin.js keeps working untouched — they
// hold a reference to these same objects, so once loadGymConfig()
// populates them, every call site sees the live values automatically.
let GYM_SETTINGS = {
  name: "Iron Pulse Fitness",
  currencySymbol: "₹",
  defaultCountryCode: "91",
};

// Membership plans: id -> { label, months, price }
let PLANS = {
  "1m": { label: "1 Month", months: 1, price: 1200 },
  "3m": { label: "3 Months", months: 3, price: 3300 },
  "6m": { label: "6 Months", months: 6, price: 6000 },
  "12m": { label: "12 Months", months: 12, price: 10800 },
};

// ---- Firebase init (uses the compat SDK loaded via <script> tags) -----
firebase.initializeApp(FIREBASE_CONFIG);

// ---- App Check (reCAPTCHA Enterprise) -----------------------------------
// Blocks direct/scripted calls to Firestore that don't come from this real
// app (e.g. someone hitting the Firestore REST API from a script/console
// with a guessed memberId/phone). Must run BEFORE firebase.firestore()/
// firebase.auth() are touched below, so every subsequent read/write already
// carries a valid App Check token.
// Site key is public (safe to ship in client code, like the Firebase config
// above) — it identifies the site, it doesn't grant access by itself.
const appCheck = firebase.appCheck();
appCheck.activate(
  new firebase.appCheck.ReCaptchaEnterpriseProvider("6LdYObUtAAAAAAS-O-plYyZW7wCsQOMco76JykW4"),
  true // isTokenAutoRefreshEnabled
);

// activate() only *starts* fetching the first App Check token — it doesn't
// wait for it. Without this promise, whichever Firestore call fires first on
// page load (loadGymConfig below) races the token fetch and goes out
// unverified almost every time. Every place below that touches Firestore
// before the user has done anything (i.e. loadGymConfig) awaits this first.
const appCheckReady = appCheck.getToken().catch((err) => {
  console.warn("Initial App Check token fetch failed:", err);
});

const db = firebase.firestore();
const auth = firebase.auth();

// ---- Offline persistence -------------------------------------------------
// Caches every doc this device has successfully read (admins/{email},
// members, checkins, payments…) in IndexedDB. This means:
//  1. onSnapshot() listeners in admin.js/member.js fire instantly with the
//     last-synced data even with zero connection, then auto-reconcile once
//     back online — this is what makes "offline, show cached data" work.
//  2. A one-off `.get()` (like the admin-allowlist check in admin.js) also
//     falls back to this cache when the live request can't reach the
//     server, instead of just failing — so an admin who was already
//     verified on this device isn't forced to sign out every time their
//     connection drops, only when they're signing in fresh with no cache.
// Fails silently (falls back to memory-only cache, which is still fine for
// the current tab) in the rare cases it can't attach — multiple tabs open,
// or a browser without IndexedDB support.
db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  console.warn("Firestore offline persistence not enabled:", err.code || err);
});

// ---- Dynamic gym config (settings/gymConfig) ---------------------------
//
// Firestore is the source of truth for gym name / currency / country code
// / plan pricing & durations. This lets an admin change prices or add a
// plan from the Firebase Console (or a future in-app settings screen)
// with zero redeploy. Every page (member.js, admin.js) must `await
// gymConfigReady` before it renders anything that reads GYM_SETTINGS or
// PLANS — see the loader below.
//
// Caching strategy (offline/cold-start robustness):
//   1. GYM_SETTINGS/PLANS above are pre-seeded with hardcoded defaults —
//      the UI is never fully broken, even on a first-ever load with no
//      network at all.
//   2. On every successful fetch, the result is mirrored into
//      localStorage, so the *next* load (even offline) restores the last
//      known-good config instead of falling back to stale hardcoded
//      defaults.
//   3. The live Firestore fetch always races against a short timeout —
//      a slow/offline network degrades to cached/default config rather
//      than hanging page load.
const GYM_CONFIG_CACHE_KEY = "fittrack:gymConfig:v1";
const GYM_CONFIG_FETCH_TIMEOUT_MS = 4000;

function applyGymConfig(data) {
  if (!data || typeof data !== "object") return;
  if (data.name || data.currencySymbol || data.defaultCountryCode) {
    Object.assign(GYM_SETTINGS, {
      name: data.name ?? GYM_SETTINGS.name,
      currencySymbol: data.currencySymbol ?? GYM_SETTINGS.currencySymbol,
      defaultCountryCode: data.defaultCountryCode ?? GYM_SETTINGS.defaultCountryCode,
    });
  }
  if (data.plans && typeof data.plans === "object" && Object.keys(data.plans).length > 0) {
    // Replace wholesale (not merge) so a plan removed in Firestore
    // actually disappears from the picker instead of lingering from the
    // hardcoded default.
    for (const key of Object.keys(PLANS)) delete PLANS[key];
    Object.assign(PLANS, data.plans);
  }
}

function loadCachedGymConfig() {
  try {
    const raw = localStorage.getItem(GYM_CONFIG_CACHE_KEY);
    if (raw) applyGymConfig(JSON.parse(raw));
  } catch (err) {
    console.warn("Could not read cached gym config:", err);
  }
}

function cacheGymConfig(data) {
  try {
    localStorage.setItem(GYM_CONFIG_CACHE_KEY, JSON.stringify(data));
  } catch (err) {
    // Non-fatal (private browsing, storage full, etc.) — just means the
    // next cold load falls back one step further, to hardcoded defaults.
    console.warn("Could not cache gym config:", err);
  }
}

function timeoutAfter(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

/**
 * Loads settings/gymConfig from Firestore and mutates GYM_SETTINGS/PLANS
 * in place. Never throws and never blocks longer than
 * GYM_CONFIG_FETCH_TIMEOUT_MS — always resolves, so callers can safely
 * `await gymConfigReady` without a try/catch of their own.
 *
 * Load order applied: hardcoded defaults (already in the objects above)
 * -> last cached copy (if any) -> live Firestore value (if it arrives
 * in time). Each step only overwrites fields that are actually present,
 * so a partial/slow read never wipes out good data with blanks.
 */
async function loadGymConfig() {
  loadCachedGymConfig(); // best-effort synchronous upgrade over hardcoded defaults
  await appCheckReady; // don't let this be the request that races the App Check token

  try {
    const snap = await Promise.race([
      db.collection("settings").doc("gymConfig").get(),
      timeoutAfter(GYM_CONFIG_FETCH_TIMEOUT_MS),
    ]);
    if (snap && snap.exists) {
      const data = snap.data();
      applyGymConfig(data);
      cacheGymConfig(data);
    }
  } catch (err) {
    // Offline, permission hiccup, doc not created yet, etc. — the
    // already-applied defaults/cache stand, app stays usable.
    console.warn("Gym config fetch failed, using cached/default values:", err);
  }
}

// Kicked off immediately at script load; every page's DOMContentLoaded
// handler should `await gymConfigReady` before building any UI that
// reads GYM_SETTINGS or PLANS (plan pickers, gym name labels, etc.).
const gymConfigReady = loadGymConfig();

// ---- Shared helpers -----------------------------------------------------

function normalizePhone(raw) {
  return String(raw || "").replace(/\D/g, "");
}

function toWhatsAppNumber(rawPhone) {
  const digits = normalizePhone(rawPhone);
  if (digits.length === 10) return GYM_SETTINGS.defaultCountryCode + digits;
  return digits;
}

function toDateKey(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addMonthsToDateKey(dateKey, months) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setMonth(date.getMonth() + months);
  return toDateKey(date);
}

function daysUntil(dateKey) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = dateKey.split("-").map(Number);
  const target = new Date(y, m - 1, d);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

function formatDate(dateKey) {
  if (!dateKey) return "—";
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

function formatCurrency(amount) {
  return `${GYM_SETTINGS.currencySymbol}${Number(amount || 0).toLocaleString("en-IN")}`;
}

// ---- Payment settings (UPI ID) — fetched from Firestore, never hardcoded --
//
// The gym's official UPI ID lives in a single Firestore document:
//   settings/config  ->  { upiId: "gymowner@okaxis", payeeName: "..." (optional) }
//
// This keeps the payment destination out of the client source code, so
// changing it (or rotating it) never requires a redeploy — just edit the
// document in the Firebase Console → Firestore Database → "settings"
// collection → "config" document. `firestore.rules` restricts writes to
// that document to signed-in admins only; the public portal is only ever
// granted read access, so a member can look up where to pay but can never
// change it.
let _paymentSettingsCache = null;

/** Fetches (and caches) { upiId, payeeName } from settings/config. */
async function getPaymentSettings() {
  if (_paymentSettingsCache) return _paymentSettingsCache;
  await appCheckReady;
  try {
    const snap = await db.collection("settings").doc("config").get();
    const data = snap.exists ? snap.data() : {};
    _paymentSettingsCache = {
      upiId: (data.upiId || "").trim(),
      payeeName: (data.payeeName || GYM_SETTINGS.name).trim(),
    };
  } catch (err) {
    console.error("Failed to load payment settings:", err);
    _paymentSettingsCache = { upiId: "", payeeName: GYM_SETTINGS.name };
  }
  return _paymentSettingsCache;
}

/**
 * Builds a standard UPI deep link (upi://pay?...) that opens the user's
 * installed UPI app (GPay, PhonePe, Paytm, BHIM, etc.) pre-filled with the
 * payee, amount, and a note. Every value is percent-encoded individually
 * (rather than relying on URLSearchParams' '+' for spaces) since some UPI
 * apps parse the payee-name field strictly.
 */
function buildUpiLink({ upiId, payeeName, amount, note, transactionRef }) {
  const parts = [
    `pa=${encodeURIComponent(upiId)}`,
    `pn=${encodeURIComponent(payeeName)}`,
    `am=${encodeURIComponent(Number(amount).toFixed(2))}`,
    `cu=INR`,
  ];
  if (note) parts.push(`tn=${encodeURIComponent(note)}`);
  if (transactionRef) parts.push(`tr=${encodeURIComponent(transactionRef)}`);
  return `upi://pay?${parts.join("&")}`;
}
