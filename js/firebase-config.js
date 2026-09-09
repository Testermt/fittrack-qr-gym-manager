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

// ---- Gym-level settings — edit to match your gym ----------------------
const GYM_SETTINGS = {
  name: "Iron Pulse Fitness",
  currencySymbol: "₹",
  defaultCountryCode: "91",
};

// Membership plans: id -> { label, months, price }
const PLANS = {
  "1m": { label: "1 Month", months: 1, price: 1200 },
  "3m": { label: "3 Months", months: 3, price: 3300 },
  "6m": { label: "6 Months", months: 6, price: 6000 },
  "12m": { label: "12 Months", months: 12, price: 10800 },
};

// ---- Firebase init (uses the compat SDK loaded via <script> tags) -----
firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.firestore();
const auth = firebase.auth();

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
