// FitTrack QR Gym Manager — Admin Dashboard logic (admin.html)

const membersCol = db.collection("members");
const checkinsCol = db.collection("checkins");
const paymentsCol = db.collection("payments");

let allMembers = [];
let unsubMembers = null;
let unsubCheckins = null;
let unsubPayments = null;

// ------------------------------------------------ Firestore admin check --
// Google Sign-In lets ANY Google account complete Firebase authentication —
// so without this check, a stranger who clicks "Sign in with Google" would
// pass Firebase auth entirely. No emails are hardcoded here: whether an
// account is allowed through is looked up live in Firestore, in the
// `admins` collection, keyed by the (lowercased) email address as the
// document ID. Add or remove admins by adding/deleting a document there —
// no redeploy needed.
//
// ⚠️ IMPORTANT — this client-side check is only a UX gate. It must be
// backed by matching firestore.rules, or a user could still read/write
// data directly through the SDK without ever opening this page. Add rules
// along these lines (adjust to your existing rules file):
//
//   match /admins/{adminEmail} {
//     // Only readable by the signed-in user checking THEIR OWN admin doc —
//     // "get" (single doc), not "list" (the whole collection), so nobody
//     // can enumerate the admin list.
//     allow get: if request.auth != null
//                  && request.auth.token.email.lower() == adminEmail;
//     allow write: if false; // manage admins from the Firebase Console only
//   }
//
//   match /members/{doc=**} {
//     allow read, write: if request.auth != null
//       && exists(/databases/$(database)/documents/admins/$(request.auth.token.email.lower()));
//   }
//   // repeat the exists(...) check for checkins/, payments/, settings/, etc.
//
// Always create admin docs with a lowercase email as the ID (e.g.
// "owner@gym.com"), since this function normalizes to lowercase too.
async function isVerifiedAdmin(email) {
  if (!email) return false;
  const docId = email.trim().toLowerCase();
  const doc = await db.collection("admins").doc(docId).get();
  return doc.exists;
}

const SCREENS = ["loginScreen", "deviceVerifyScreen", "biometricSetupScreen", "dashboardScreen"];

function showScreen(idToShow) {
  SCREENS.forEach((id) => {
    document.getElementById(id).classList.toggle("hidden", id !== idToShow);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("gymNameLabelAdmin").textContent = GYM_SETTINGS.name;

  document.getElementById("loginForm").addEventListener("submit", handleLogin);
  document.getElementById("googleSignInBtn").addEventListener("click", handleGoogleSignIn);
  document.getElementById("forgotPasswordBtn").addEventListener("click", handleForgotPassword);
  document.getElementById("logoutBtn").addEventListener("click", () => auth.signOut());
  document.getElementById("memberSearch").addEventListener("input", renderMemberTable);

  document.getElementById("deviceVerifyRetryBtn").addEventListener("click", () => {
    const user = auth.currentUser;
    if (user) runDeviceVerification(user, getStoredCredentialId(user.uid));
  });
  document.getElementById("deviceVerifyResetBtn").addEventListener("click", handleDeviceVerifyReset);
  document.getElementById("deviceVerifySignOutBtn").addEventListener("click", () => auth.signOut());
  document.getElementById("biometricSetupEnableBtn").addEventListener("click", handleBiometricSetup);
  document.getElementById("biometricSetupSkipBtn").addEventListener("click", handleBiometricSkip);
  document.getElementById("deviceLockToggleBtn").addEventListener("click", handleDeviceLockToggle);

  auth.onAuthStateChanged((user) => {
    if (user) {
      handleAuthenticatedUser(user);
    } else {
      showLogin();
    }
  });
});

/**
 * Runs on every sign-in AND on every page load that restores an existing
 * session (not just fresh logins) — this is what stops the device gate
 * from being skipped by simply refreshing the page.
 *
 * Google-linked accounts go through the whitelist + biometric device gate.
 * Email/password-only accounts (the emergency backup path) go straight to
 * the dashboard — they were only ever created deliberately in the Firebase
 * Console, so they don't need the extra Google-specific checks.
 */
async function handleAuthenticatedUser(user) {
  const signedInWithGoogle = user.providerData.some((p) => p.providerId === "google.com");

  if (signedInWithGoogle) {
    // Show a "checking" state on the device-verify screen while we hit
    // Firestore — this also covers page refreshes that restore a session,
    // so revoking a Firestore admin doc takes effect on the very next load,
    // not just at the next fresh sign-in.
    showScreen("deviceVerifyScreen");
    setDeviceVerifyStage("checkingAdmin");

    let isAdmin = false;
    try {
      isAdmin = await isVerifiedAdmin(user.email);
    } catch (err) {
      console.error("Admin verification lookup failed:", err);
      showAuthGateError("Couldn't verify admin access right now. Please check your connection and try again.");
      await auth.signOut();
      return;
    }

    if (!isAdmin) {
      showAuthGateError(`This Google account (${user.email}) isn't authorized as a gym admin.`);
      await auth.signOut();
      return;
    }

    const biometricSupported = await isPlatformAuthenticatorAvailable();
    if (biometricSupported) {
      const storedCredentialId = getStoredCredentialId(user.uid);
      if (storedCredentialId) {
        setDeviceVerifyStage("biometric");
        await runDeviceVerification(user, storedCredentialId);
        return;
      }
      if (!hasSkippedBiometricSetup(user.uid)) {
        showScreen("biometricSetupScreen");
        return;
      }
    }
  }

  showDashboard(user);
}

/** Switches the copy on the shared deviceVerifyScreen between its two uses. */
function setDeviceVerifyStage(stage) {
  const titleEl = document.getElementById("deviceVerifyTitle");
  const subEl = document.getElementById("deviceVerifySub");
  const errorEl = document.getElementById("deviceVerifyError");
  const retryBtn = document.getElementById("deviceVerifyRetryBtn");
  const resetBtn = document.getElementById("deviceVerifyResetBtn");

  errorEl.classList.add("hidden");
  retryBtn.classList.add("hidden");
  resetBtn.classList.add("hidden");

  if (stage === "checkingAdmin") {
    titleEl.textContent = "Verifying admin access…";
    subEl.textContent = "Checking your account against the gym's admin list in Firestore.";
  } else {
    titleEl.textContent = "Verifying this device…";
    subEl.textContent = "Confirm with your fingerprint, face, or screen lock to continue.";
  }
}

function showAuthGateError(message) {
  const el = document.getElementById("googleSignInError");
  el.textContent = message;
  el.classList.remove("hidden");
}

// ------------------------------------------------------------------ auth --
async function handleLogin(e) {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector("button[type=submit]");
  const errorEl = document.getElementById("loginError");
  errorEl.classList.add("hidden");
  document.getElementById("googleSignInError").classList.add("hidden");
  hideResetMessage();

  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    await auth.signInWithEmailAndPassword(form.email.value.trim(), form.password.value);
  } catch (err) {
    errorEl.textContent = "Invalid email or password.";
    errorEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign In";
  }
}

// -------------------------------------------------------- Google sign-in --
async function handleGoogleSignIn() {
  const btn = document.getElementById("googleSignInBtn");
  const errorEl = document.getElementById("googleSignInError");
  errorEl.classList.add("hidden");
  document.getElementById("loginError").classList.add("hidden");
  hideResetMessage();

  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span>Signing in…</span>`;

  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    // Always show the account chooser — never silently reuse a cached
    // browser session without an explicit confirmation click.
    provider.setCustomParameters({ prompt: "select_account" });
    await auth.signInWithPopup(provider);
    // handleAuthenticatedUser (wired to onAuthStateChanged) takes it from
    // here — whitelist check, then the device biometric gate if available.
  } catch (err) {
    console.error(err);
    let message = "Something went wrong signing in with Google. Please try again.";
    if (err.code === "auth/popup-blocked") {
      message = "Your browser blocked the Google sign-in popup. Please allow popups for this site and try again.";
    } else if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") {
      message = "Sign-in window was closed before finishing. Please try again.";
    } else if (err.code === "auth/account-exists-with-different-credential") {
      message = "An admin account already exists with this email using a different sign-in method. Please use email/password instead.";
    } else if (err.code === "auth/network-request-failed") {
      message = "Network error — please check your connection and try again.";
    } else if (err.code === "auth/unauthorized-domain") {
      message = "This site's domain isn't authorized for Google sign-in yet. Ask the gym owner to add it in Firebase Console → Authentication → Settings → Authorized domains.";
    }
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHTML;
  }
}

// -------------------------------------------------------- password reset --
async function handleForgotPassword() {
  const form = document.getElementById("loginForm");
  const btn = document.getElementById("forgotPasswordBtn");
  const errorEl = document.getElementById("loginError");
  errorEl.classList.add("hidden");
  document.getElementById("googleSignInError").classList.add("hidden");

  const email = form.email.value.trim();

  if (!email) {
    form.email.focus();
    showResetMessage("Please type your admin email above first, then tap 'Forgot password?' again.", "error");
    return;
  }

  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Sending…";

  try {
    await auth.sendPasswordResetEmail(email);
    showResetMessage(
      `Password reset link sent to ${email}! Check your inbox (and spam folder) and follow the link to set a new password.`,
      "success"
    );
  } catch (err) {
    console.error(err);
    let message = "Something went wrong sending the reset email. Please try again in a moment.";
    if (err.code === "auth/invalid-email") {
      message = "That doesn't look like a valid email address. Please double-check it and try again.";
    } else if (err.code === "auth/user-not-found") {
      message = "We couldn't find an admin account with that email. Please check with the gym owner for the correct login email.";
    } else if (err.code === "auth/too-many-requests") {
      message = "Too many attempts. Please wait a few minutes before trying again.";
    }
    showResetMessage(message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

function showResetMessage(message, kind) {
  const el = document.getElementById("resetMessage");
  el.textContent = message;
  el.classList.remove(
    "hidden",
    "text-emerald-400",
    "bg-emerald-500/10",
    "border-emerald-500/30",
    "text-rose-400",
    "bg-rose-500/10",
    "border-rose-500/30"
  );
  if (kind === "success") {
    el.classList.add("text-emerald-400", "bg-emerald-500/10", "border-emerald-500/30");
  } else {
    el.classList.add("text-rose-400", "bg-rose-500/10", "border-rose-500/30");
  }
}

function hideResetMessage() {
  document.getElementById("resetMessage").classList.add("hidden");
}

function showLogin() {
  showScreen("loginScreen");
  if (unsubMembers) unsubMembers();
  if (unsubCheckins) unsubCheckins();
  if (unsubPayments) unsubPayments();
}

function showDashboard(user) {
  showScreen("dashboardScreen");
  document.getElementById("adminEmailLabel").textContent = user.email;
  updateDeviceLockToggle(user);

  subscribeMembers();
  subscribeTodayCheckins();
  subscribeMonthlyRevenue();
}

// ------------------------------------------------ device biometric gate --
// Genuine, real WebAuthn calls — but with no backend to cryptographically
// verify the signed assertion, this is a strong *local device* gate (a real
// OS fingerprint/Face ID/screen-lock prompt has to succeed on THIS device)
// rather than a formally server-verified passkey login. It stops someone
// who has your Google password — but not this device unlocked — from
// opening the dashboard.

async function isPlatformAuthenticatorAvailable() {
  try {
    if (!window.PublicKeyCredential || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
      return false;
    }
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch (err) {
    console.error("Platform authenticator check failed:", err);
    return false;
  }
}

/** Verifies the admin's fingerprint/face/screen-lock against a previously registered device credential. */
async function runDeviceVerification(user, storedCredentialId) {
  const titleEl = document.getElementById("deviceVerifyTitle");
  const subEl = document.getElementById("deviceVerifySub");
  const errorEl = document.getElementById("deviceVerifyError");
  const retryBtn = document.getElementById("deviceVerifyRetryBtn");
  const resetBtn = document.getElementById("deviceVerifyResetBtn");

  titleEl.textContent = "Verifying this device…";
  subEl.textContent = "Confirm with your fingerprint, face, or screen lock to continue.";
  errorEl.classList.add("hidden");
  retryBtn.classList.add("hidden");
  resetBtn.classList.add("hidden");

  if (!storedCredentialId) return; // nothing to verify against — caller shouldn't hit this

  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: base64urlToBuffer(storedCredentialId), type: "public-key" }],
        userVerification: "required",
        timeout: 60000,
      },
    });
    if (!assertion) throw new Error("No credential returned");
    showDashboard(user);
  } catch (err) {
    console.error("Device verification failed:", err);
    titleEl.textContent = "Device verification failed";
    subEl.textContent = "";
    let message = "We couldn't confirm your fingerprint, face, or screen lock on this device.";
    if (err.name === "NotAllowedError") {
      message = "Verification was cancelled or timed out. Please try again.";
    } else if (err.name === "SecurityError") {
      message = "This site must be served over HTTPS for device verification to work.";
    }
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
    retryBtn.classList.remove("hidden");
    resetBtn.classList.remove("hidden");
  }
}

function handleDeviceVerifyReset() {
  const user = auth.currentUser;
  if (!user) return;
  const confirmed = confirm(
    "Reset the device lock for this browser? You'll be asked to set it up again on this device."
  );
  if (!confirmed) return;
  clearStoredCredentialId(user.uid);
  showScreen("biometricSetupScreen");
}

/** One-time offer to register a platform passkey (fingerprint/face/screen-lock) for this device. */
async function handleBiometricSetup() {
  const user = auth.currentUser;
  if (!user) return;

  const btn = document.getElementById("biometricSetupEnableBtn");
  const errorEl = document.getElementById("biometricSetupError");
  errorEl.classList.add("hidden");

  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Setting up…";

  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userIdBytes = new TextEncoder().encode(user.uid);

    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: GYM_SETTINGS.name },
        user: {
          id: userIdBytes,
          name: user.email,
          displayName: user.displayName || user.email,
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 }, // ES256
          { type: "public-key", alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
          residentKey: "preferred",
        },
        timeout: 60000,
        attestation: "none",
      },
    });

    if (!credential) throw new Error("No credential created");

    storeCredentialId(user.uid, bufferToBase64url(credential.rawId));
    showDashboard(user);
  } catch (err) {
    console.error("Biometric setup failed:", err);
    const message =
      err.name === "NotAllowedError"
        ? "Setup was cancelled. You can try again anytime from the dashboard."
        : "Couldn't set up device lock. You can try again anytime from the dashboard.";
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

function handleBiometricSkip() {
  const user = auth.currentUser;
  if (user) markBiometricSetupSkipped(user.uid);
  showDashboard(user);
}

/** Toggle in the dashboard header — lets an admin enable/remove the device lock later. */
function updateDeviceLockToggle(user) {
  const btn = document.getElementById("deviceLockToggleBtn");
  const signedInWithGoogle = user.providerData.some((p) => p.providerId === "google.com");

  if (!signedInWithGoogle) {
    btn.classList.add("hidden");
    return;
  }
  btn.classList.remove("hidden");
  const enabled = !!getStoredCredentialId(user.uid);
  btn.textContent = enabled ? "🔓 Remove device lock" : "🔒 Enable device lock";
}

async function handleDeviceLockToggle() {
  const user = auth.currentUser;
  if (!user) return;

  if (getStoredCredentialId(user.uid)) {
    const confirmed = confirm(
      "Remove the device lock from this browser? You'll be able to open the dashboard here without a fingerprint/face/screen-lock check from now on."
    );
    if (confirmed) {
      clearStoredCredentialId(user.uid);
      updateDeviceLockToggle(user);
    }
    return;
  }

  showScreen("biometricSetupScreen");
}

// ---- localStorage helpers (per-browser/device, intentionally not synced) --
function credentialStorageKey(uid) {
  return `ft_biometric_cred_${uid}`;
}
function skippedStorageKey(uid) {
  return `ft_biometric_skipped_${uid}`;
}

function getStoredCredentialId(uid) {
  try {
    return localStorage.getItem(credentialStorageKey(uid));
  } catch (err) {
    console.error(err);
    return null;
  }
}
function storeCredentialId(uid, id) {
  try {
    localStorage.setItem(credentialStorageKey(uid), id);
    localStorage.removeItem(skippedStorageKey(uid));
  } catch (err) {
    console.error(err);
  }
}
function clearStoredCredentialId(uid) {
  try {
    localStorage.removeItem(credentialStorageKey(uid));
  } catch (err) {
    console.error(err);
  }
}
function hasSkippedBiometricSetup(uid) {
  try {
    return localStorage.getItem(skippedStorageKey(uid)) === "true";
  } catch (err) {
    console.error(err);
    return false;
  }
}
function markBiometricSetupSkipped(uid) {
  try {
    localStorage.setItem(skippedStorageKey(uid), "true");
  } catch (err) {
    console.error(err);
  }
}

// ---- ArrayBuffer <-> base64url helpers, for storing/reusing credential IDs --
function bufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = "";
  bytes.forEach((b) => (str += String.fromCharCode(b)));
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlToBuffer(base64url) {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

// --------------------------------------------------------------- members --
function subscribeMembers() {
  unsubMembers = membersCol.orderBy("name").onSnapshot(
    (snap) => {
      allMembers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderMemberTable();
      renderStats();
    },
    (err) => console.error("members listener error", err)
  );
}

function renderMemberTable() {
  const query = document.getElementById("memberSearch").value.trim().toLowerCase();
  const tbody = document.getElementById("memberTableBody");
  const emptyState = document.getElementById("memberEmptyState");

  const filtered = allMembers.filter((m) => {
    if (!query) return true;
    return m.name.toLowerCase().includes(query) || m.phone.includes(query);
  });

  tbody.innerHTML = "";
  emptyState.classList.toggle("hidden", filtered.length > 0);

  filtered.forEach((m) => {
    const days = daysUntil(m.expiryDate);
    const isActive = days >= 0;
    const plan = PLANS[m.plan] || { label: m.plan };
    const isPaid = m.paymentStatus === "paid";

    const tr = document.createElement("tr");
    tr.className = "border-b border-slate-800/70 hover:bg-slate-800/30 transition";
    tr.innerHTML = `
      <td class="py-3 pr-4">
        <p class="font-medium text-slate-100">${escapeHtml(m.name)}</p>
        <p class="text-xs text-slate-500">+${GYM_SETTINGS.defaultCountryCode} ${m.phone}</p>
      </td>
      <td class="py-3 pr-4 text-slate-300 max-w-[200px] truncate" title="${escapeHtml(m.address || "")}">${escapeHtml(m.address || "—")}</td>
      <td class="py-3 pr-4 text-slate-300">${plan.label}</td>
      <td class="py-3 pr-4 text-slate-300">${formatDate(m.expiryDate)}</td>
      <td class="py-3 pr-4">
        <span class="badge ${isActive ? "badge-success" : "badge-danger"}">${isActive ? "ACTIVE" : "EXPIRED"}</span>
        <p class="text-xs text-slate-500 mt-1">${isActive ? days + "d left" : Math.abs(days) + "d ago"}</p>
      </td>
      <td class="py-3 pr-4">
        <span class="badge ${isPaid ? "badge-success" : "badge-warning"}">${isPaid ? "PAID" : "PENDING"}</span>
      </td>
      <td class="py-3 pr-0">
        <div class="flex flex-wrap gap-2 justify-end">
          ${
            !isPaid
              ? `<button data-action="mark-paid" data-id="${m.id}" class="text-xs font-semibold rounded-md bg-success/15 text-success px-3 py-1.5 hover:bg-success/25 transition">Mark as Paid</button>`
              : ""
          }
          ${
            !isActive || !isPaid
              ? `<button data-action="whatsapp" data-id="${m.id}" class="text-xs font-semibold rounded-md bg-emerald-500/15 text-emerald-400 px-3 py-1.5 hover:bg-emerald-500/25 transition">Send WhatsApp</button>`
              : ""
          }
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById("memberTableBody").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const member = allMembers.find((m) => m.id === btn.dataset.id);
  if (!member) return;

  if (btn.dataset.action === "mark-paid") markAsPaid(member, btn);
  if (btn.dataset.action === "whatsapp") sendWhatsAppReminder(member);
});

async function markAsPaid(member, btn) {
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const plan = PLANS[member.plan] || { price: 0 };
    await membersCol.doc(member.id).update({
      paymentStatus: "paid",
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await paymentsCol.add({
      memberId: member.id,
      name: member.name,
      phone: member.phone,
      plan: member.plan,
      amount: plan.price,
      method: "cash",
      dateKey: toDateKey(new Date()),
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error(err);
    alert("Could not update payment status. Please try again.");
    btn.disabled = false;
    btn.textContent = "Mark as Paid";
  }
}

function sendWhatsAppReminder(member) {
  const number = toWhatsAppNumber(member.phone);
  const days = daysUntil(member.expiryDate);
  const message =
    days < 0
      ? `Hi ${member.name}, this is a reminder from ${GYM_SETTINGS.name} — your membership expired on ${formatDate(
          member.expiryDate
        )}. Please renew at your earliest convenience to continue your fitness journey with us! 💪`
      : `Hi ${member.name}, this is a friendly reminder from ${GYM_SETTINGS.name} that your payment is pending. Kindly complete it at the front desk or via the check-in portal. Thank you!`;

  const url = `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
  window.open(url, "_blank", "noopener");
}

// ------------------------------------------------------- today's check-ins --
function subscribeTodayCheckins() {
  const today = toDateKey(new Date());
  unsubCheckins = checkinsCol
    .where("dateKey", "==", today)
    .onSnapshot(
      (snap) => {
        const rows = snap.docs
          .map((d) => d.data())
          .sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));
        renderCheckinLog(rows);
        document.getElementById("statTodayCheckins").textContent = rows.length;
      },
      (err) => console.error("checkins listener error", err)
    );
}

function renderCheckinLog(rows) {
  const list = document.getElementById("checkinLog");
  const emptyState = document.getElementById("checkinEmptyState");
  list.innerHTML = "";
  emptyState.classList.toggle("hidden", rows.length > 0);

  rows.forEach((row) => {
    const time = row.timestamp?.toDate
      ? row.timestamp.toDate().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      : "—";
    const li = document.createElement("li");
    li.className = "flex items-center justify-between py-2.5 border-b border-slate-800/70 last:border-0";
    li.innerHTML = `
      <div class="flex items-center gap-3">
        <span class="w-2 h-2 rounded-full bg-success"></span>
        <div>
          <p class="text-sm font-medium text-slate-100">${escapeHtml(row.name)}</p>
          <p class="text-xs text-slate-500">+${GYM_SETTINGS.defaultCountryCode} ${row.phone}</p>
        </div>
      </div>
      <span class="text-xs text-slate-500">${time}</span>
    `;
    list.appendChild(li);
  });
}

// ------------------------------------------------------------ monthly revenue --
function subscribeMonthlyRevenue() {
  const now = new Date();
  const monthStart = toDateKey(new Date(now.getFullYear(), now.getMonth(), 1));
  const monthEnd = toDateKey(new Date(now.getFullYear(), now.getMonth() + 1, 0));

  unsubPayments = paymentsCol
    .where("dateKey", ">=", monthStart)
    .where("dateKey", "<=", monthEnd)
    .onSnapshot(
      (snap) => {
        const total = snap.docs.reduce((sum, d) => sum + (d.data().amount || 0), 0);
        document.getElementById("statRevenue").textContent = formatCurrency(total);
      },
      (err) => console.error("payments listener error", err)
    );
}

// ------------------------------------------------------------------ stats --
function renderStats() {
  const active = allMembers.filter((m) => daysUntil(m.expiryDate) >= 0).length;
  const pending = allMembers.filter((m) => m.paymentStatus !== "paid").length;
  document.getElementById("statActive").textContent = active;
  document.getElementById("statPending").textContent = pending;
  document.getElementById("statTotal").textContent = allMembers.length;
}

// ----------------------------------------------------------------- utils --
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
