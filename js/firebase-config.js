/**
 * FitTrack QR Gym Manager — Firebase configuration & shared helpers
 * -----------------------------------------------------------------
 * 1. Create a free project at https://console.firebase.google.com
 * 2. Add a "Web app" inside Project Settings → paste the config object
 *    Firebase gives you into FIREBASE_CONFIG below.
 * 3. Enable "Firestore Database" (production mode) in the console.
 * 4. Enable "Authentication" → Sign-in method → Email/Password (for admin.html).
 * 5. Create one admin user under Authentication → Users → Add user.
 * 6. Paste the Firestore security rules from firestore.rules into
 *    Firestore → Rules and publish.
 *
 * That's it — index.html and admin.html both read this file and need
 * no build step. Open them directly or deploy the folder to any static
 * host (Firebase Hosting, Netlify, Vercel, GitHub Pages, etc.).
 */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSy...",
  authDomain: "fittrack-gym-9d2a2.firebaseapp.com",
  projectId: "fittrack-gym-9d2a2",
  storageBucket: "fittrack-gym-9d2a2.appspot.com",
  messagingSenderId: "12572347727",
  appId: "1:12572347727:web:8fc788a4cebfa3d1f5893a",
  measurementId: "G-XGQ8Q3J78Z"
};


// ---- Gym-level settings — edit to match your gym ----------------------
const GYM_SETTINGS = {
  name: "Iron Pulse Fitness",
  currencySymbol: "₹",
  // Default country code used when a stored phone number is only 10 digits
  // (used to build correct wa.me WhatsApp links). Change "91" to your own
  // country's calling code if needed, e.g. "1" for US/Canada, "44" for UK.
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

/** Normalizes a phone number to digits only, used as the Firestore doc id. */
function normalizePhone(raw) {
  return String(raw || "").replace(/\D/g, "");
}

/** Formats a phone number for a wa.me link, prepending the default country code if needed. */
function toWhatsAppNumber(rawPhone) {
  const digits = normalizePhone(rawPhone);
  if (digits.length === 10) return GYM_SETTINGS.defaultCountryCode + digits;
  return digits;
}

/** Returns YYYY-MM-DD for a Date object, in local time. */
function toDateKey(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Adds N months to a date-key string (YYYY-MM-DD) and returns a new date-key string. */
function addMonthsToDateKey(dateKey, months) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setMonth(date.getMonth() + months);
  return toDateKey(date);
}

/** Days between today and a target date-key. Positive = future, negative = past. */
function daysUntil(dateKey) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = dateKey.split("-").map(Number);
  const target = new Date(y, m - 1, d);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

/** Human-friendly date, e.g. "9 Sep 2026". */
function formatDate(dateKey) {
  if (!dateKey) return "—";
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

function formatCurrency(amount) {
  return `${GYM_SETTINGS.currencySymbol}${Number(amount || 0).toLocaleString("en-IN")}`;
}
