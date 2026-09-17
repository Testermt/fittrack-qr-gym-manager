// FitTrack QR Gym Manager — Admin Dashboard logic (admin.html)

const membersCol = db.collection("members");
const checkinsCol = db.collection("checkins");
const paymentsCol = db.collection("payments");

let allMembers = [];
let unsubMembers = null;
let unsubCheckins = null;
let unsubPayments = null;

let currentMemberFilter = "all";
let todayCheckedInIds = new Set();

// Variable to track pending secure action for re-auth
let pendingReauthAction = null;

// Thrown only when we genuinely could NOT complete the admin check (network
// blip, or the ID-token-propagation race right after a popup sign-in) —
// never for "this account isn't an admin". Callers must treat this
// differently from a plain `false` result (see handleAuthenticatedUser).
class AdminVerificationError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "AdminVerificationError";
    this.cause = cause;
  }
}

/**
 * Checks the `admins/{email}` whitelist doc for the signed-in user.
 * Returns true/false once the check actually completes; throws
 * AdminVerificationError only after exhausting retries on a retryable
 * failure (never leaves the caller guessing, never crashes the UI).
 */
async function isVerifiedAdmin(email, { retries = 4, baseDelayMs = 600 } = {}) {
  if (!email) return false;
  const docId = email.trim().toLowerCase();

  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Only force a fresh ID token on a RETRY, not on the first attempt.
      // Right after signInWithPopup() resolves, the client already holds a
      // valid token — forcing a refresh immediately is what was causing the
      // occasional throw. If the first Firestore read comes back
      // permission-denied (token/rules propagation race), *then* we refresh
      // before trying again.
      if (attempt > 0) {
        const currentUser = auth.currentUser;
        if (!currentUser) {
          throw new AdminVerificationError("Session was lost while verifying admin access.");
        }
        await currentUser.getIdToken(true);
      }

      const doc = await db.collection("admins").doc(docId).get();
      return doc.exists;
    } catch (err) {
      lastErr = err;
      const code = err && err.code;

      // Retry only on failures that are plausibly transient:
      // - permission-denied: classic race right after sign-in, before the
      //   fresh ID token's claims have fully propagated to Firestore's
      //   rules engine.
      // - unavailable / internal / network errors: plain connectivity blips.
      // Anything else (e.g. a malformed request) is not worth retrying.
      const retryable =
        code === "permission-denied" ||
        code === "unavailable" ||
        code === "internal" ||
        code === "auth/network-request-failed";

      console.warn(`Admin verification attempt ${attempt + 1} failed:`, code || err.message);

      if (!retryable || attempt === retries) break;

      const delay = baseDelayMs * Math.pow(2, attempt); // 600ms, 1.2s, 2.4s, 4.8s
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new AdminVerificationError("Could not verify admin status after retries.", lastErr);
}






const SCREENS = ["loginScreen", "deviceVerifyScreen", "biometricSetupScreen", "dashboardScreen"];

function showScreen(idToShow) {
  SCREENS.forEach((id) => {
    document.getElementById(id).classList.toggle("hidden", id !== idToShow);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  // Same gymConfigReady gate as member.js — resolves fast (cache/defaults)
  // even offline, so this doesn't meaningfully delay the admin login screen.
  await gymConfigReady;
  await tierConfigReady;
  await pricingConfigReady;

  document.getElementById("gymNameLabelAdmin").textContent = GYM_SETTINGS.name;

  // Initial paint of the SaaS trial/plan-expiry notifications (new-member
  // notifications get added once subscribeMembers()'s listener fires) and
  // a periodic refresh so "expires in N days" rolls over correctly even on
  // a tab left open past midnight.
  renderNotifications();
  setInterval(renderNotifications, 5 * 60 * 1000);

  // Email/Password form listeners hata diye gaye hain kyunki form remove kar diya hai
  document.getElementById("googleSignInBtn").addEventListener("click", handleGoogleSignIn);
  document.getElementById("logoutBtn").addEventListener("click", () => auth.signOut());
  document.getElementById("memberSearch").addEventListener("input", renderMemberTable);

  // Status Filter Buttons listener
  const filterGroup = document.getElementById("memberFilterGroup");
  if (filterGroup) {
    filterGroup.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-filter]");
      if (!btn) return;
      currentMemberFilter = btn.dataset.filter;
      updateMemberFilterStyles();
      renderMemberTable();
    });
    updateMemberFilterStyles();
  }

  // Re-auth Modal Event Listeners
  document.getElementById("reauthCancelBtn").addEventListener("click", closeReauthModal);
  document.getElementById("reauthBackdrop").addEventListener("click", closeReauthModal);
  document.getElementById("reauthForm").addEventListener("submit", handleReauthSubmit);

  // Manual member registration modal
  document.getElementById("openAddMemberBtn").addEventListener("click", openAddMemberModal);
  document.getElementById("addMemberCancelBtn").addEventListener("click", closeAddMemberModal);
  document.getElementById("addMemberCloseBtn").addEventListener("click", closeAddMemberModal);
  document.getElementById("addMemberBackdrop").addEventListener("click", closeAddMemberModal);
  document.getElementById("addMemberForm").addEventListener("submit", handleAddMemberSubmit);

  // Gym Settings modal (name / currency / country code / plans) — lets the
  // owner change these themselves instead of needing someone to edit
  // Firestore directly.
  document.getElementById("gymSettingsBtn").addEventListener("click", openGymSettingsModal);
  document.getElementById("gymSettingsCancelBtn").addEventListener("click", closeGymSettingsModal);
  document.getElementById("gymSettingsCloseBtn").addEventListener("click", closeGymSettingsModal);
  document.getElementById("gymSettingsBackdrop").addEventListener("click", closeGymSettingsModal);
  document.getElementById("gymSettingsForm").addEventListener("submit", handleGymSettingsSubmit);
  document.getElementById("settingsAddPlanBtn").addEventListener("click", () => addPlanRow(generatePlanId(), { label: "", months: 1, price: 0 }));
  document.getElementById("settingsPlanRows").addEventListener("click", (e) => {
    const btn = e.target.closest('button[data-action="remove-plan-row"]');
    if (!btn) return;
    const rows = document.querySelectorAll("#settingsPlanRows .settings-plan-row");
    if (rows.length <= 1) {
      alert("At least one plan is required.");
      return;
    }
    btn.closest(".settings-plan-row").remove();
  });

  // Plan & Features modal (Basic/Prime/Advance tier + which features that
  // unlocks) — controls hasFeature() everywhere else in the app.
  document.getElementById("planFeaturesBtn").addEventListener("click", () => {
    toggleMoreMenu(true);
    openPlanFeaturesModal(false);
  });
  document.getElementById("exportCsvBtn").addEventListener("click", () => {
    toggleMoreMenu(true);
    exportMembersToCsv();
  });
  document.getElementById("gymSettingsBtn").addEventListener("click", () => toggleMoreMenu(true));

  // Round "more options" menu (Plan & Features / Gym Settings list)
  document.getElementById("moreMenuBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleNotifDropdown(true);
    toggleMoreMenu();
  });

  // Notification bell (new member / SaaS trial-plan expiry / custom broadcasts)
  document.getElementById("notifBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMoreMenu(true);
    toggleNotifDropdown();
  });
  document.getElementById("notifMarkAllReadBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    markAllNotificationsRead();
  });
  document.getElementById("notifClearAllBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    clearAllNotifications();
  });
  subscribeBroadcasts();

  // Profile menu (photo/name button -> Sign Out dropdown)
  document.getElementById("profileMenuBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMoreMenu(true);
    toggleNotifDropdown(true);
    toggleProfileMenu();
  });
  document.addEventListener("click", (e) => {
    const wrap = document.getElementById("profileMenuWrap");
    if (wrap && !wrap.contains(e.target)) toggleProfileMenu(true);
    const moreWrap = document.getElementById("moreMenuWrap");
    if (moreWrap && !moreWrap.contains(e.target)) toggleMoreMenu(true);
    const notifWrap = document.getElementById("notifWrap");
    if (notifWrap && !notifWrap.contains(e.target)) toggleNotifDropdown(true);
  });
  document.getElementById("planFeaturesCancelBtn").addEventListener("click", closePlanFeaturesModal);
  document.getElementById("planFeaturesCloseBtn").addEventListener("click", closePlanFeaturesModal);
  document.getElementById("planFeaturesBackdrop").addEventListener("click", closePlanFeaturesModal);
  document.getElementById("planFeaturesSaveBtn").addEventListener("click", handlePlanActionClick);
  document.getElementById("planTierOptions").addEventListener("change", () => {
    renderPlanFeaturesList();
    renderPlanActionButton();
  });



  document.getElementById("deviceVerifyRetryBtn").addEventListener("click", () => {
    const user = auth.currentUser;
    if (user) runDeviceVerification(user, getStoredCredentialId(user.uid));
  });
  document.getElementById("deviceVerifyResetBtn").addEventListener("click", handleDeviceVerifyReset);
  document.getElementById("deviceVerifySignOutBtn").addEventListener("click", () => auth.signOut());
  document.getElementById("biometricSetupEnableBtn").addEventListener("click", handleBiometricSetup);
  document.getElementById("biometricSetupSkipBtn").addEventListener("click", handleBiometricSkip);

  auth.onAuthStateChanged((user) => {
    if (user) {
      handleAuthenticatedUser(user);
    } else {
      showLogin();
    }
  });
});


async function handleAuthenticatedUser(user) {
  const signedInWithGoogle = user.providerData.some((p) => p.providerId === "google.com");

  if (signedInWithGoogle) {
    showScreen("deviceVerifyScreen");
    setDeviceVerifyStage("checkingAdmin");

    let isAdmin = false;
    try {
      // isVerifiedAdmin owns its own token-sync + retry/backoff internally.
      // It only throws when the check genuinely couldn't complete (network
      // blip or the post-popup token-propagation race) — never for a
      // legitimate "not an admin" result, which comes back as `false`.
      // Note: with Firestore offline persistence enabled (firebase-config.js),
      // this now resolves instantly from cache — with no throw at all — for
      // any admin who has successfully verified on this device before, even
      // with zero connection. This catch only fires for a device/account
      // that has never verified successfully before, so "connect to the
      // internet" is genuinely the right ask in that case.
      isAdmin = await isVerifiedAdmin(user.email);
    } catch (err) {
      console.error("Admin verification lookup failed:", err, err && err.cause ? err.cause : "");
      showAuthGateError(
        navigator.onLine
          ? "Couldn't verify admin access right now. Please try again in a moment."
          : "You're offline and this device hasn't verified admin access before — please connect to the internet once to finish setup."
      );
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
        // Device lock already registered — force fingerprint verification prompt!
        setDeviceVerifyStage("biometric");
        await runDeviceVerification(user, storedCredentialId);
        return;
      } else {
        // STRICT SECURITY: No fingerprint registered yet on this device.
        // Force them to set it up right now — no "Skip" / "Not now" allowed!
        showScreen("biometricSetupScreen");
        // Hide the skip button so they are forced to secure the device
        const skipBtn = document.getElementById("biometricSetupSkipBtn");
        if (skipBtn) skipBtn.classList.add("hidden");
        return;
      }
    }
  }

  showDashboard(user);
}



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



async function handleGoogleSignIn() {
  const btn = document.getElementById("googleSignInBtn");
  const errorEl = document.getElementById("googleSignInError");
  errorEl.classList.add("hidden");

  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span>Signing in…</span>`;

  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await auth.signInWithPopup(provider);
  } catch (err) {
    console.error(err);
    let message = "Something went wrong signing in with Google. Please try again.";
    if (err.code === "auth/popup-blocked") {
      message = "Your browser blocked the Google sign-in popup. Please allow popups for this site and try again.";
    } else if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") {
      message = "Sign-in window was closed before finishing. Please try again.";
    }
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHTML;
  }
}

// 🛑 Yeh beech ka sara orphaned/stray code yahan se hata dena hai!

function showLogin() {
  showScreen("loginScreen");
  toggleProfileMenu(true);
  if (unsubMembers) unsubMembers();
  if (unsubCheckins) unsubCheckins();
  if (unsubPayments) unsubPayments();
  if (unsubAllPayments) unsubAllPayments();   // <-- yeh line missing thi, add karo
  if (planLockCheckInterval) { clearInterval(planLockCheckInterval); planLockCheckInterval = null; }
  planModalLocked = false;
  closeReauthModal();
}


let planLockCheckInterval = null;

function showDashboard(user) {
  showScreen("dashboardScreen");
  document.getElementById("adminEmailLabel").textContent =
    user.displayName || (user.email ? user.email.split("@")[0] : "Admin");
  renderProfileMenu(user);

  subscribeMembers();
  subscribeWeeklyAndTodayCheckins(); // <-- Yeh dono cheezein ek sath handle karega (Chart + Today's List)
  subscribeMonthlyRevenue();
  subscribeMonthlyHistory();

  // Trial/plan gate — checked against the control project's live doc
  // (already fetched by tierConfigReady before this runs), so a cleared
  // cache + fresh login always re-checks the real status. Locks the
  // whole dashboard behind a non-dismissible plan picker if expired.
  enforcePlanLock();

  // Also re-check every minute while the session stays open — and this
  // is a LIVE re-fetch from the control project (not just re-reading
  // cached TIER_STATE), so if someone pokes TIER_STATE.expiresAt via the
  // browser console to fake an unlock, it gets overwritten with the real
  // server value on the very next tick instead of staying bypassed for
  // the rest of the session.
  if (planLockCheckInterval) clearInterval(planLockCheckInterval);
  planLockCheckInterval = setInterval(() => {
    loadTierConfig().then(enforcePlanLock);
  }, 60 * 1000);
}

// Shows the signed-in Google account's photo (or an initial-letter
// fallback if no photoURL) + display name in the header profile button.
function renderProfileMenu(user) {
  const img = document.getElementById("profileAvatarImg");
  const fallback = document.getElementById("profileAvatarFallback");
  const nameLabel = document.getElementById("profileNameLabel");
  const emailLabel = document.getElementById("profileEmailLabel");

  const name = user.displayName || (user.email ? user.email.split("@")[0] : "Admin");
  nameLabel.textContent = name;
  if (emailLabel) emailLabel.textContent = user.email || "";

  if (user.photoURL) {
    img.src = user.photoURL;
    img.classList.remove("hidden");
    fallback.classList.add("hidden");
  } else {
    img.classList.add("hidden");
    fallback.classList.remove("hidden");
    fallback.textContent = name.charAt(0).toUpperCase();
  }
}

// ----------------------------------------------------------------------
// Shared "fixed-position dropdown" helper for the header icon cluster
// (notifications / more-options / profile). Using position:fixed + a
// JS-computed top/right (instead of CSS `absolute right-0`) means each
// panel is always anchored to its own trigger button but clamped to the
// actual viewport — so it can never spill off the left edge on a narrow
// phone, and still lands in the right place on a tablet or a wide
// desktop window. Recomputed on open and on resize/orientation-change
// while a panel is open.
// ----------------------------------------------------------------------
const HEADER_DROPDOWN_IDS = ["notifDropdown", "moreMenuDropdown", "profileMenuDropdown"];

function positionHeaderDropdown(triggerBtn, dropdownEl) {
  const rect = triggerBtn.getBoundingClientRect();
  const margin = 12; // keep a small gap from the viewport edge
  const width = dropdownEl.offsetWidth || 320;
  let right = window.innerWidth - rect.right;
  if (right + width > window.innerWidth - margin) right = margin;
  if (right < margin) right = margin;
  dropdownEl.style.top = `${Math.round(rect.bottom + 8)}px`;
  dropdownEl.style.right = `${Math.round(right)}px`;
}

function repositionOpenHeaderDropdowns() {
  const map = { notifDropdown: "notifBtn", moreMenuDropdown: "moreMenuBtn", profileMenuDropdown: "profileMenuBtn" };
  HEADER_DROPDOWN_IDS.forEach((id) => {
    const dropdown = document.getElementById(id);
    const btn = document.getElementById(map[id]);
    if (dropdown && btn && !dropdown.classList.contains("hidden")) {
      positionHeaderDropdown(btn, dropdown);
    }
  });
}
window.addEventListener("resize", repositionOpenHeaderDropdowns);
window.addEventListener("orientationchange", repositionOpenHeaderDropdowns);

function toggleProfileMenu(forceClose) {
  const dropdown = document.getElementById("profileMenuDropdown");
  if (forceClose) {
    dropdown.classList.add("hidden");
  } else {
    const willOpen = dropdown.classList.contains("hidden");
    dropdown.classList.toggle("hidden");
    if (willOpen) positionHeaderDropdown(document.getElementById("profileMenuBtn"), dropdown);
  }
}

// Round "more options" menu — Plan & Features / Gym Settings list.
function toggleMoreMenu(forceClose) {
  const dropdown = document.getElementById("moreMenuDropdown");
  if (!dropdown) return;
  if (forceClose) {
    dropdown.classList.add("hidden");
  } else {
    const willOpen = dropdown.classList.contains("hidden");
    dropdown.classList.toggle("hidden");
    if (willOpen) positionHeaderDropdown(document.getElementById("moreMenuBtn"), dropdown);
  }
}

// Notification bell dropdown. Opening it doesn't silently mark everything
// read (same as Play Store) — that only happens on "Mark all read" or by
// tapping an individual notification.
function toggleNotifDropdown(forceClose) {
  const dropdown = document.getElementById("notifDropdown");
  if (!dropdown) return;
  if (forceClose) {
    dropdown.classList.add("hidden");
  } else {
    const willOpen = dropdown.classList.contains("hidden");
    dropdown.classList.toggle("hidden");
    if (willOpen) {
      positionHeaderDropdown(document.getElementById("notifBtn"), dropdown);
      renderNotifications();
    }
  }
}

// 🔥 Offline banner — reflects real connectivity, not just Firestore state,
// so it shows the moment wifi/data drops and clears the moment it's back.
function updateOfflineBanner() {
  const banner = document.getElementById("offlineBanner");
  if (banner) banner.classList.toggle("hidden", navigator.onLine);
}
window.addEventListener("online", updateOfflineBanner);
window.addEventListener("offline", updateOfflineBanner);
updateOfflineBanner(); // set correct initial state on page load

function subscribeWeeklyAndTodayCheckins() {
  // Pichhle 6 din pehle ka dateKey (yani last 7 days including today)
  const d = new Date();
  d.setDate(d.getDate() - 6);
  const weekAgoKey = toDateKey(d);

  unsubCheckins = checkinsCol
    .where("dateKey", ">=", weekAgoKey)
    .onSnapshot(
      (snap) => {
        const rows = snap.docs
          .map((d) => d.data())
          .sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));

        // 1. Aaj ke check-ins ko alag filter karo "Today's Check-Ins" list ke liye
        const today = toDateKey(new Date());
        const todayRows = rows.filter((r) => r.dateKey === today);

        todayCheckedInIds = new Set(todayRows.map((r) => r.memberId).filter(Boolean));
        renderCheckinLog(todayRows);
        renderMemberTable();
        document.getElementById("statTodayCheckins").textContent = todayRows.length;

        // 2. Poora 7 din ka data weekly chart ko pass karo
        renderWeeklyCheckinsChart(rows);
      },
      (err) => console.error("checkins listener error", err)
    );
}





async function isPlatformAuthenticatorAvailable() {
  try {
    if (!window.PublicKeyCredential || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
      return false;
    }
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch (err) {
    return false;
  }
}

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

  if (!storedCredentialId) return;

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
    titleEl.textContent = "Device verification failed";
    subEl.textContent = "";
    errorEl.textContent = "We couldn't confirm your fingerprint, face, or screen lock.";
    errorEl.classList.remove("hidden");
    retryBtn.classList.remove("hidden");
    resetBtn.classList.remove("hidden");
  }
}

function handleDeviceVerifyReset() {
  const user = auth.currentUser;
  if (!user) return;
  const confirmed = confirm("Reset the device lock for this browser?");
  if (!confirmed) return;
  clearStoredCredentialId(user.uid);
  showScreen("biometricSetupScreen");
}

async function handleBiometricSetup() {
  const user = auth.currentUser;
  if (!user) return;
  const btn = document.getElementById("biometricSetupEnableBtn");
  const errorEl = document.getElementById("biometricSetupError");
  errorEl.classList.add("hidden");
  btn.disabled = true;
  btn.textContent = "Setting up…";

  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userIdBytes = new TextEncoder().encode(user.uid);
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: GYM_SETTINGS.name },
        user: { id: userIdBytes, name: user.email, displayName: user.displayName || user.email },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
        timeout: 60000,
        attestation: "none",
      },
    });
    if (!credential) throw new Error("No credential created");
    storeCredentialId(user.uid, bufferToBase64url(credential.rawId));
    showDashboard(user);
  } catch (err) {
    errorEl.textContent = "Couldn't set up device lock.";
    errorEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Set Up Device Lock";
  }
}

function handleBiometricSkip() {
  const user = auth.currentUser;
  if (user) markBiometricSetupSkipped(user.uid);
  showDashboard(user);
}

function credentialStorageKey(uid) { return `ft_biometric_cred_${uid}`; }
function skippedStorageKey(uid) { return `ft_biometric_skipped_${uid}`; }
function getStoredCredentialId(uid) { try { return localStorage.getItem(credentialStorageKey(uid)); } catch (e) { return null; } }
function storeCredentialId(uid, id) { try { localStorage.setItem(credentialStorageKey(uid), id); localStorage.removeItem(skippedStorageKey(uid)); } catch (e) {} }
function clearStoredCredentialId(uid) { try { localStorage.removeItem(credentialStorageKey(uid)); } catch (e) {} }
function hasSkippedBiometricSetup(uid) { try { return localStorage.getItem(skippedStorageKey(uid)) === "true"; } catch (e) { return false; } }
function markBiometricSetupSkipped(uid) { try { localStorage.setItem(skippedStorageKey(uid), "true"); } catch (e) {} }

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
  // 🔥 Security rules unchanged hain — sirf .orderBy hataya hai taaki index error na aaye
  unsubMembers = membersCol.onSnapshot(
    (snap) => {
      allMembers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      
      // JavaScript mein securely sort karna (No database index required)
      allMembers.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      
      renderMemberTable();
      renderStats();
      renderNotifications();
    },
    (err) => console.error("members listener error:", err)
  );
}


// ----------------------------------------------------------------------
// Notifications (bell dropdown)
//
// Four sources, none of which need a new Firestore write path:
//  1. New members — computed straight from allMembers (createdAt/joinDate
//     within the last NEW_MEMBER_WINDOW_MS), refreshed every time the
//     members listener fires.
//  2. Members whose membership due date has arrived or already passed —
//     computed straight from allMembers' expiryDate (daysUntil() <= 0).
//  3. This gym's own SaaS trial/plan expiring soon or already expired —
//     read from TIER_STATE (already loaded from the control project's
//     subscriptions/{GYM_ID} doc by loadTierConfig() in firebase-config.js).
//  4. Custom messages the owner drops by hand into the control project's
//     broadcasts/{GYM_ID}/items collection (read-only from the client —
//     see the Firestore rule for it). Live via onSnapshot so a message
//     shows up without a page reload.
//
// Read/unread and cleared/dismissed state both live in localStorage (per
// device) since #1-#3 are computed on the fly, not stored docs — there's
// nothing to write "read: true" or "deleted" onto server-side. Each id
// bakes in the value that would change on a genuine new event (e.g. a
// member's expiryDate, or the subscription's expiresAt) so clearing a
// notification hides that specific event for good, while a *future*
// event (renewed plan -> new expiryDate) still gets its own fresh id and
// shows up normally.
// ----------------------------------------------------------------------

const NOTIF_READ_KEY = "fittrack:notifRead:v1";
const NOTIF_DISMISSED_KEY = "fittrack:notifDismissed:v1";
const NEW_MEMBER_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // show "new member" for 3 days
const PLAN_EXPIRY_WARNING_DAYS = 3; // "expiring soon" starts this many days out

let broadcastMessages = []; // [{ id, title, message, createdAtMs }]
let unsubBroadcasts = null;

function getReadNotifIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(NOTIF_READ_KEY) || "[]"));
  } catch (e) {
    return new Set();
  }
}

function markNotifRead(id) {
  const read = getReadNotifIds();
  read.add(id);
  try { localStorage.setItem(NOTIF_READ_KEY, JSON.stringify([...read])); } catch (e) {}
}

function markAllNotificationsRead() {
  const all = computeNotifications().map((n) => n.id);
  try { localStorage.setItem(NOTIF_READ_KEY, JSON.stringify(all)); } catch (e) {}
  renderNotifications();
}

function getDismissedNotifIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(NOTIF_DISMISSED_KEY) || "[]"));
  } catch (e) {
    return new Set();
  }
}

/** Clears (hides) a single notification. It won't come back unless the
 * underlying event changes (e.g. the member's plan gets renewed). */
function dismissNotification(id) {
  const dismissed = getDismissedNotifIds();
  dismissed.add(id);
  try { localStorage.setItem(NOTIF_DISMISSED_KEY, JSON.stringify([...dismissed])); } catch (e) {}
  renderNotifications();
}

/** Clears every notification currently showing. */
function clearAllNotifications() {
  const dismissed = getDismissedNotifIds();
  computeNotifications({ includeDismissed: true }).forEach((n) => dismissed.add(n.id));
  try { localStorage.setItem(NOTIF_DISMISSED_KEY, JSON.stringify([...dismissed])); } catch (e) {}
  renderNotifications();
}

// Subscribes to hand-added broadcast messages in the shared control
// Firebase project. Rule (add to the CONTROL project's firestore.rules,
// not this gym's own):
//   match /broadcasts/{gymId}/items/{itemId} {
//     allow read: if true;
//     allow write: if false;   // you add these from the Firebase Console
//   }
function subscribeBroadcasts() {
  if (unsubBroadcasts) return;
  try {
    unsubBroadcasts = controlDb
      .collection("broadcasts")
      .doc(GYM_ID)
      .collection("items")
      .orderBy("createdAt", "desc")
      .limit(20)
      .onSnapshot(
        (snap) => {
          broadcastMessages = snap.docs.map((d) => {
            const data = d.data();
            const createdAtMs = data.createdAt?.toDate ? data.createdAt.toDate().getTime() : Date.now();
            return {
              id: `broadcast-${d.id}`,
              title: data.title || "Message",
              message: data.message || "",
              createdAtMs,
            };
          });
          renderNotifications();
        },
        (err) => console.warn("broadcasts listener error (non-fatal):", err)
      );
  } catch (err) {
    console.warn("Could not subscribe to broadcasts:", err);
  }
}

/** Builds the current notification list, newest first. Pass
 * { includeDismissed: true } to get every computed item regardless of
 * dismissed state (used by "Clear all" to know every id to hide). */
function computeNotifications({ includeDismissed = false } = {}) {
  const items = [];
  const now = Date.now();

  // 1. New members
  allMembers.forEach((m) => {
    const createdAtMs = m.createdAt?.toDate
      ? m.createdAt.toDate().getTime()
      : m.joinDate
      ? new Date(m.joinDate).getTime()
      : null;
    if (createdAtMs && now - createdAtMs <= NEW_MEMBER_WINDOW_MS) {
      items.push({
        id: `member-new-${m.id}-${createdAtMs}`,
        icon: "🆕",
        title: "New member joined",
        subtitle: m.name || "A new member",
        timeMs: createdAtMs,
      });
    }
  });

  // 2. Members whose due date has arrived or already passed
  allMembers.forEach((m) => {
    if (!m.expiryDate) return;
    const due = daysUntil(m.expiryDate);
    if (due <= 0) {
      items.push({
        id: `member-due-${m.id}-${m.expiryDate}`,
        icon: "⚠️",
        title: `Membership due: ${m.name || "Member"}`,
        subtitle: due === 0 ? "Due today." : `Overdue by ${Math.abs(due)} day${Math.abs(due) === 1 ? "" : "s"}.`,
        timeMs: new Date(m.expiryDate).getTime() || now,
      });
    }
  });

  // 3. This gym's SaaS trial/plan status (from TIER_STATE, control project)
  if (TIER_STATE.expiresAt) {
    if (isAccessLocked()) {
      items.push({
        id: `sub-expired-${TIER_STATE.expiresAt}`,
        icon: "🔴",
        title: TIER_STATE.status === "trial" ? "Your free trial has expired" : "Your plan has expired",
        subtitle: "Renew to keep using the dashboard.",
        timeMs: TIER_STATE.expiresAt,
      });
    } else {
      const days = daysUntilExpiry();
      if (days !== null && days <= PLAN_EXPIRY_WARNING_DAYS) {
        items.push({
          id: `sub-expiring-${TIER_STATE.expiresAt}`,
          icon: "⏳",
          title: TIER_STATE.status === "trial" ? "Your free trial is ending soon" : "Your plan is expiring soon",
          subtitle: days === 0 ? "Expires today." : `Expires in ${days} day${days === 1 ? "" : "s"}.`,
          timeMs: now,
        });
      }
    }
  }

  // 4. Custom broadcasts (owner-authored, from control Firebase)
  broadcastMessages.forEach((b) => {
    items.push({
      id: b.id,
      icon: "📣",
      title: b.title,
      subtitle: b.message,
      timeMs: b.createdAtMs,
    });
  });

  items.sort((a, b) => b.timeMs - a.timeMs);

  if (includeDismissed) return items;
  const dismissed = getDismissedNotifIds();
  return items.filter((n) => !dismissed.has(n.id));
}

function renderNotifications() {
  const list = document.getElementById("notifList");
  const emptyState = document.getElementById("notifEmptyState");
  const badge = document.getElementById("notifBadge");
  if (!list || !badge) return; // dashboard not painted yet (e.g. still on login screen)

  const items = computeNotifications();
  const readIds = getReadNotifIds();
  const unreadCount = items.filter((n) => !readIds.has(n.id)).length;

  badge.classList.toggle("hidden", unreadCount === 0);
  badge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);

  emptyState.classList.toggle("hidden", items.length > 0);
  list.innerHTML = "";

  items.forEach((n) => {
    const isUnread = !readIds.has(n.id);
    const row = document.createElement("div");
    row.dataset.notifId = n.id;
    row.className = `w-full flex items-start gap-2 px-3 py-2.5 hover:bg-slate-800 transition ${
      isUnread ? "bg-accent/5" : ""
    }`;
    row.innerHTML = `
      <button type="button" data-role="notif-open" class="flex-1 min-w-0 flex items-start gap-2.5 text-left">
        <span class="text-base leading-none mt-0.5">${n.icon}</span>
        <span class="flex-1 min-w-0">
          <span class="flex items-center gap-1.5">
            <span class="text-sm font-medium text-slate-100 truncate">${escapeHtml(n.title)}</span>
            ${isUnread ? '<span class="w-1.5 h-1.5 rounded-full bg-accent shrink-0"></span>' : ""}
          </span>
          <span class="block text-xs text-slate-500 truncate">${escapeHtml(n.subtitle || "")}</span>
        </span>
      </button>
      <button type="button" data-role="notif-clear" aria-label="Clear notification"
        class="shrink-0 text-slate-600 hover:text-rose-400 transition text-base leading-none px-1 py-0.5">&times;</button>
    `;
    row.querySelector('[data-role="notif-open"]').addEventListener("click", () => {
      markNotifRead(n.id);
      renderNotifications();
    });
    row.querySelector('[data-role="notif-clear"]').addEventListener("click", (e) => {
      e.stopPropagation();
      dismissNotification(n.id);
    });
    list.appendChild(row);
  });
}

function buildMemberActionsHtml(m, dotSizeClass) {
  const days = daysUntil(m.expiryDate);
  const isActive = days >= 0;
  const isPaid = m.paymentStatus === "paid";
  const isApproved = m.approved === true;
  const alreadyCheckedIn = todayCheckedInIds.has(m.id);

  return `
    <!-- 🔥 Approve Button (Sirf tab dikhega jab user approved na ho) -->
    ${!isApproved ? `<button data-action="approve" data-id="${m.id}" class="text-xs font-semibold rounded-md bg-amber-500/15 text-amber-400 px-3 py-1.5 hover:bg-amber-500/25 transition">Approve</button>` : ""}

    <button data-action="check-in" data-id="${m.id}" ${alreadyCheckedIn ? "disabled" : ""}
      class="text-xs font-semibold rounded-md px-3 py-1.5 transition ${
        alreadyCheckedIn ? "bg-slate-800 text-slate-500 cursor-not-allowed" : "bg-accent/15 text-accent hover:bg-accent/25"
      }">${alreadyCheckedIn ? "✓ Checked In" : "Check-In"}</button>

    <!-- 🔥 3-dot menu: Mark as Paid / Send WhatsApp / Delete -->
    <div class="relative inline-block">
      <button data-action="more-menu" data-id="${m.id}"
        class="text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-md ${dotSizeClass} flex items-center justify-center transition"
        aria-label="More actions">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
      </button>
      <div data-menu-actions
        data-mark-paid="${!isPaid}"
        data-whatsapp="${!isActive || !isPaid}"
        class="hidden"></div>
    </div>
  `;
}




function renderMemberTable() {
  const query = document.getElementById("memberSearch").value.trim().toLowerCase();
  const tbody = document.getElementById("memberTableBody");
  const cardList = document.getElementById("memberCardList"); // 🔥 mobile card view
  const emptyState = document.getElementById("memberEmptyState");

  const filtered = allMembers.filter((m) => {
    if (query && !(m.name.toLowerCase().includes(query) || m.phone.includes(query))) return false;
    if (currentMemberFilter === "active" && (m.approved !== true || daysUntil(m.expiryDate) < 0)) return false;
    if (currentMemberFilter === "pending" && (m.approved !== true || m.paymentStatus === "paid")) return false;
    // 🔥 Pending approval filter check
    if (currentMemberFilter === "pending-approval" && m.approved === true) return false;
    // Due Soon: still active, but expiring within the next 3 days (0-3
    // inclusive) — the window the gym owner should be sending renewal
    // reminders for.
    if (currentMemberFilter === "due-soon") {
      const d = daysUntil(m.expiryDate);
      if (!(d >= 0 && d <= 3)) return false;
    }
    return true;
  });

  tbody.innerHTML = "";
  cardList.innerHTML = "";
  emptyState.classList.toggle("hidden", filtered.length > 0);

  filtered.forEach((m) => {
    const days = daysUntil(m.expiryDate);
    const isActive = days >= 0;
    const plan = PLANS[m.plan] || { label: m.plan };
    const isPaid = m.paymentStatus === "paid";
    const isApproved = m.approved === true;

    // ---- desktop/tablet table row (md and up) ----
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
        <!-- 🔥 Unapproved members: sirf "Pending Approval" dikhega, ACTIVE/EXPIRED nahi (kyunki abhi member confirm hi nahi hai) -->
        ${isApproved ? `
          <span class="badge ${isActive ? "badge-success" : "badge-danger"}">${isActive ? "ACTIVE" : "EXPIRED"}</span>
          <p class="text-xs text-slate-500 mt-1">${isActive ? days + "d left" : Math.abs(days) + "d ago"}</p>
        ` : `
          <span class="badge badge-warning">Pending Approval</span>
        `}
      </td>
      <td class="py-3 pr-4">
        <!-- 🔥 Payment status sirf tab dikhega jab member approve ho chuka ho -->
        ${isApproved ? `
          <span class="badge ${isPaid ? "badge-success" : "badge-warning"}">${isPaid ? "PAID" : "Payment Pending"}</span>
        ` : `
          <span class="text-xs text-slate-500">—</span>
        `}
      </td>
      <td class="py-3 pr-0">
        <div class="flex flex-wrap gap-2 justify-end items-center">
          ${buildMemberActionsHtml(m, "w-8 h-8")}
        </div>
      </td>
    `;
    tbody.appendChild(tr);

    // ---- mobile card (below md) ----
    const card = document.createElement("div");
    card.className = "rounded-xl border border-slate-800 bg-slate-900/50 p-3.5";
    card.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="font-medium text-slate-100 truncate">${escapeHtml(m.name)}</p>
          <p class="text-xs text-slate-500">+${GYM_SETTINGS.defaultCountryCode} ${m.phone}</p>
        </div>
        ${isApproved
          ? `<span class="badge shrink-0 ${isActive ? "badge-success" : "badge-danger"}">${isActive ? "ACTIVE" : "EXPIRED"}</span>`
          : `<span class="badge shrink-0 badge-warning">Pending Approval</span>`
        }
      </div>

      <!-- 🔥 Payment badge sirf approved members ke liye -->
      ${isApproved ? `
        <div class="flex flex-wrap gap-1.5 mt-2.5">
          <span class="badge ${isPaid ? "badge-success" : "badge-warning"}">${isPaid ? "PAID" : "Payment Pending"}</span>
        </div>
      ` : ""}

      <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-400 mt-2.5 pt-2.5 border-t border-slate-800/70">
        <p class="truncate"><span class="text-slate-600">Plan:</span> ${plan.label}</p>
        <p class="truncate"><span class="text-slate-600">Expiry:</span> ${formatDate(m.expiryDate)} · ${isActive ? days + "d left" : Math.abs(days) + "d ago"}</p>
        ${m.address ? `<p class="col-span-2 truncate" title="${escapeHtml(m.address)}"><span class="text-slate-600">Address:</span> ${escapeHtml(m.address)}</p>` : ""}
      </div>

      <div class="flex flex-wrap gap-2 items-center mt-3">
        ${buildMemberActionsHtml(m, "w-10 h-10")}
      </div>
    `;
    cardList.appendChild(card);
  });
}

// --------------------------------------------- 3-dot row action menu -------

let openRowMenu = null; // { menuEl, closeFn }

function closeRowMenu() {
  if (openRowMenu) {
    openRowMenu.menuEl.remove();
    openRowMenu = null;
  }
}

function openRowMenuFor(btn, member) {
  closeRowMenu();

  const wrapper = btn.nextElementSibling; // the data-menu-actions div holding flags
  const canMarkPaid = wrapper.dataset.markPaid === "true";
  const canWhatsapp = wrapper.dataset.whatsapp === "true";

  const menu = document.createElement("div");
  menu.className =
    "fixed z-50 w-44 rounded-lg border border-slate-700 bg-slate-900 shadow-xl py-1 text-sm";
  menu.innerHTML = `
    ${canMarkPaid ? `<button data-menu-action="mark-paid" class="w-full text-left px-3 py-2 text-success hover:bg-slate-800 transition">Mark as Paid</button>` : ""}
    ${canWhatsapp ? `<button data-menu-action="whatsapp" class="w-full text-left px-3 py-2 text-emerald-400 hover:bg-slate-800 transition">Send WhatsApp</button>` : ""}
    <button data-menu-action="delete" class="w-full text-left px-3 py-2 text-rose-400 hover:bg-slate-800 transition">Delete</button>
  `;
  document.body.appendChild(menu);

  // position it near the button, always fully inside the viewport
  const rect = btn.getBoundingClientRect();
  const menuWidth = menu.offsetWidth;
  const menuHeight = menu.offsetHeight;
  const margin = 8;

  // Prefer aligning the menu's right edge with the button's right edge.
  // If that would push it off the left side of the screen, align left
  // edges instead. Either way, clamp so it never overflows either side.
  let left = rect.right - menuWidth;
  if (left < margin) left = rect.left;
  left = Math.min(Math.max(left, margin), window.innerWidth - menuWidth - margin);

  const spaceBelow = window.innerHeight - rect.bottom;
  const openUpward = spaceBelow < menuHeight + margin && rect.top > menuHeight;

  menu.style.left = `${left}px`;
  menu.style.top = openUpward ? `${rect.top - menuHeight - 4}px` : `${rect.bottom + 4}px`;

  menu.addEventListener("click", (e) => {
    const actionBtn = e.target.closest("button[data-menu-action]");
    if (!actionBtn) return;
    const action = actionBtn.dataset.menuAction;
    closeRowMenu();
    if (action === "mark-paid") requestReauth("mark-paid", member, btn);
    if (action === "whatsapp") sendWhatsAppReminder(member);
    if (action === "delete") requestReauth("delete", member, btn);
  });

  openRowMenu = { menuEl: menu };
}

document.addEventListener("click", (e) => {
  if (openRowMenu && !e.target.closest("[data-menu-action]") && !e.target.closest('[data-action="more-menu"]')) {
    closeRowMenu();
  }
});
window.addEventListener("scroll", () => closeRowMenu(), true);
window.addEventListener("resize", () => closeRowMenu());


function updateMemberFilterStyles() {
  document.querySelectorAll(".member-filter-btn").forEach((btn) => {
    const active = btn.dataset.filter === currentMemberFilter;
    btn.classList.toggle("bg-accent", active);
    btn.classList.toggle("text-slate-950", active);
    btn.classList.toggle("bg-slate-800", !active);
    btn.classList.toggle("text-slate-400", !active);
  });
}

function handleMemberActionClick(e) {
  const btn = e.target.closest("button[data-action]");
  if (!btn || btn.disabled) return;
  const member = allMembers.find((m) => m.id === btn.dataset.id);
  if (!member) return;

  if (btn.dataset.action === "approve") executeApproveMember(member, btn); // 🔥 Yeh line add karni hai
  if (btn.dataset.action === "check-in") manualCheckIn(member, btn);
  if (btn.dataset.action === "more-menu") {
    e.stopPropagation();
    if (openRowMenu && openRowMenu.forId === member.id) {
      closeRowMenu();
    } else {
      openRowMenuFor(btn, member);
      openRowMenu.forId = member.id;
    }
  }
}

document.getElementById("memberTableBody").addEventListener("click", handleMemberActionClick);
document.getElementById("memberCardList").addEventListener("click", handleMemberActionClick);

async function executeApproveMember(member, btn) {
  const originalLabel = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Approving…";
  }
  try {
    await membersCol.doc(member.id).update({
      approved: true,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error(err);
    alert("Could not approve member. Please try again.");
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel || "Approve";
    }
  }
}

// --------------------------------------------- manual member registration --
function openAddMemberModal() {
  const form = document.getElementById("addMemberForm");
  form.reset();
  document.getElementById("addMemberError").classList.add("hidden");
  document.getElementById("addMemberJoinDate").value = toDateKey(new Date());
  populateAddMemberPlanOptions();
  document.getElementById("addMemberModal").classList.remove("hidden");
  document.getElementById("addMemberName").focus();
}

function closeAddMemberModal() {
  document.getElementById("addMemberModal").classList.add("hidden");
}

// ==================== PLAN & FEATURES (Basic / Prime / Advance) ====================
// This entire modal is driven by FEATURE_CATALOG + TIER_ORDER (both in
// firebase-config.js) — adding a new gated feature later means adding one
// entry to FEATURE_CATALOG there. Nothing here needs to change.

function tierLabel(tier) {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

function renderPlanTierOptions(selectedTier) {
  const container = document.getElementById("planTierOptions");
  container.innerHTML = TIER_ORDER.map((tier) => {
    const price = TIER_PRICING[tier]?.price ?? 0;
    return `
    <label class="cursor-pointer">
      <input type="radio" name="planTier" value="${tier}" class="sr-only peer" ${tier === selectedTier ? "checked" : ""} />
      <span class="block text-center rounded-lg border border-slate-700 px-2 py-2 text-slate-400 peer-checked:bg-accent/15 peer-checked:text-accent peer-checked:border-accent/40 transition">
        <span class="block text-sm font-medium">${tierLabel(tier)}</span>
        <span class="block text-[10px] opacity-80">₹${price}/mo</span>
      </span>
    </label>
  `;
  }).join("");
}

/** Renders every feature in the catalog, grouped by the tier that unlocks
 *  it, with a live "Included / Not included" badge based on whichever
 *  radio is currently selected — updates on every click, no page reload. */
function renderPlanFeaturesList() {
  const selected = document.querySelector('input[name="planTier"]:checked')?.value || "basic";
  const container = document.getElementById("planFeaturesList");
  const entries = Object.entries(FEATURE_CATALOG);

  if (entries.length === 0) {
    container.innerHTML = '<p class="text-xs text-slate-500 italic">No gated features registered yet.</p>';
    return;
  }

  container.innerHTML = entries.map(([key, feature]) => {
    const included = TIER_ORDER.indexOf(selected) >= TIER_ORDER.indexOf(feature.minTier);
    return `
      <div class="flex items-start justify-between gap-3 bg-slate-900/60 border border-slate-800 rounded-lg px-3 py-2.5">
        <div class="min-w-0">
          <p class="text-sm font-medium text-slate-200">${feature.label}</p>
          <p class="text-[11px] text-slate-500">${feature.description || ""} · requires ${tierLabel(feature.minTier)}+</p>
        </div>
        <span class="shrink-0 text-[10px] font-semibold rounded-full px-2 py-1 ${included ? "bg-success/15 text-success" : "bg-slate-800 text-slate-500"}">
          ${included ? "Included" : "Not included"}
        </span>
      </div>
    `;
  }).join("");
}

/** Shows the gym owner's current subscription status just above the tier
 *  picker — which plan they're on, and whether it's a free trial (with
 *  days remaining) or an active paid subscription. */
function renderPlanStatusBanner() {
  const el = document.getElementById("planStatusBanner");
  const current = tierLabel(TIER_STATE.current);
  const days = daysUntilExpiry();

  if (days === null) {
    el.innerHTML = `Pick a plan below to activate your account.`;
  } else if (isAccessLocked()) {
    el.innerHTML = TIER_STATE.status === "trial"
      ? `Your <strong class="text-accent">${current}</strong> free trial has ended — pick a plan below to continue.`
      : `Your <strong class="text-accent">${current}</strong> plan has expired — renew below to continue.`;
  } else if (TIER_STATE.status === "trial") {
    el.innerHTML = `You're on <strong class="text-accent">${current}</strong> — free trial, <strong>${days}</strong> day${days === 1 ? "" : "s"} left.`;
  } else {
    el.innerHTML = `You're on <strong class="text-accent">${current}</strong> — active, renews in <strong>${days}</strong> day${days === 1 ? "" : "s"}.`;
  }
}

/** Decides what the footer button says and does, based on the tier
 *  currently selected in the radio group vs. the gym's real plan:
 *  - same as the current plan, still valid -> disabled "Current Plan"
 *  - free trial never used yet             -> "Start Free Trial" (no payment)
 *  - current plan but expired              -> "Pay ₹X & Renew"
 *  - anything else                         -> "Pay ₹X & Upgrade" */
function renderPlanActionButton() {
  const btn = document.getElementById("planFeaturesSaveBtn");
  const selected = document.querySelector('input[name="planTier"]:checked')?.value || TIER_STATE.current;
  const price = TIER_PRICING[selected]?.price ?? 0;
  const locked = isAccessLocked();

  if (selected === TIER_STATE.current && TIER_STATE.status === "active" && !locked) {
    btn.textContent = "Current Plan";
    btn.disabled = true;
    btn.dataset.mode = "none";
  } else if (!TIER_STATE.trialUsed) {
    btn.textContent = `Start Free Trial (${DEFAULT_TRIAL_DAYS} days)`;
    btn.disabled = false;
    btn.dataset.mode = "trial";
  } else if (selected === TIER_STATE.current && locked) {
    btn.textContent = `Pay ₹${price} & Renew`;
    btn.disabled = false;
    btn.dataset.mode = "pay";
  } else {
    btn.textContent = `Pay ₹${price} & Upgrade`;
    btn.disabled = false;
    btn.dataset.mode = "pay";
  }
  btn.dataset.tier = selected;
}

// True while the plan modal is showing because access is LOCKED (trial/
// plan expired, or never started) — as opposed to the admin voluntarily
// opening it from the header button. Gates closePlanFeaturesModal() so
// the backdrop, X, and Cancel can't dismiss a lock screen.
let planModalLocked = false;

function openPlanFeaturesModal(locked = false) {
  planModalLocked = locked;
  renderPlanTierOptions(TIER_STATE.current);
  renderPlanFeaturesList();
  renderPlanStatusBanner();
  renderPlanActionButton();
  document.getElementById("planFeaturesError").classList.add("hidden");
  document.getElementById("planFeaturesSuccess").classList.add("hidden");
  document.getElementById("planFeaturesCloseBtn").classList.toggle("hidden", locked);
  document.getElementById("planFeaturesCancelBtn").classList.toggle("hidden", locked);
  document.getElementById("planFeaturesModal").classList.remove("hidden");
}

function closePlanFeaturesModal() {
  if (planModalLocked) return; // locked screen can't be dismissed
  document.getElementById("planFeaturesModal").classList.add("hidden");
}

/**
 * Call right after login/dashboard render (and again after any successful
 * trial-start/payment). Shows the full-screen, non-dismissible plan
 * picker whenever isAccessLocked() is true — based on the live value
 * loadTierConfig() just fetched from the control project, not a local
 * cache, so clearing storage and logging in again can never be used to
 * bypass it. Closes it again once a trial/plan is actually active.
 */
function enforcePlanLock() {
  if (isAccessLocked()) {
    openPlanFeaturesModal(true);
  } else if (planModalLocked) {
    planModalLocked = false;
    closePlanFeaturesModal();
  }
}

/** ============================================================
 *  PAYMENT ENTRY POINT — this is the ONLY function you need to replace
 *  when you're ready to plug in Razorpay. Keep the same signature: takes
 *  a tier key, returns a Promise that resolves once payment is confirmed
 *  and rejects (with an Error) if the user cancels or it fails.
 *  handlePlanActionClick() below calls this and doesn't care how the
 *  promise settles — so nothing else in the app needs to change.
 *
 *  Real swap-in, once you have a Razorpay key:
 *    function payAndUpgradeTier(tier) {
 *      return new Promise((resolve, reject) => {
 *        const rzp = new Razorpay({
 *          key: "rzp_live_xxxxxxxx",
 *          amount: TIER_PRICING[tier].price * 100, // paise
 *          currency: "INR",
 *          name: GYM_SETTINGS.name,
 *          description: `${tierLabel(tier)} plan — monthly`,
 *          handler: (response) => resolve(response),
 *          modal: { ondismiss: () => reject(new Error("Payment cancelled")) },
 *        });
 *        rzp.open();
 *      });
 *    }
 * ============================================================ */
function payAndUpgradeTier(tier) {
  const price = TIER_PRICING[tier]?.price ?? 0;
  return new Promise((resolve, reject) => {
    const confirmed = confirm(
      `Pay ₹${price}/month for the ${tierLabel(tier)} plan?\n\n(Payment gateway isn't connected yet — this marks it as a confirmed test upgrade.)`
    );
    if (confirmed) resolve({ trust: true });
    else reject(new Error("Payment cancelled"));
  });
}

async function handlePlanActionClick() {
  const errorEl = document.getElementById("planFeaturesError");
  const successEl = document.getElementById("planFeaturesSuccess");
  errorEl.classList.add("hidden");
  successEl.classList.add("hidden");

  const btn = document.getElementById("planFeaturesSaveBtn");
  const tier = btn.dataset.tier;
  const mode = btn.dataset.mode;
  if (!TIER_ORDER.includes(tier) || mode === "none") return;

  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = mode === "trial" ? "Starting trial…" : "Opening payment…";

  try {
        let update;
    if (mode === "trial") {
      update = {
        gymName: GYM_SETTINGS.name, // 🔥 Yeh line add kar de
        current: tier,
        status: "trial",
        expiresAt: Date.now() + DEFAULT_TRIAL_DAYS * 86400000,
        subscribedAt: null,
        trialUsed: true,
      };
    } else {
      await payAndUpgradeTier(tier);
      update = {
        gymName: GYM_SETTINGS.name, // 🔥 Yeh line add kar de
        current: tier,
        status: "active",
        expiresAt: Date.now() + 30 * 86400000, // one billing cycle; renews on next payment
        subscribedAt: Date.now(),
        trialUsed: true,
      };
    }

    await controlDb.collection("subscriptions").doc(GYM_ID).set(update);

    applyTierConfig(update);
    try { localStorage.setItem(TIER_CONFIG_CACHE_KEY, JSON.stringify(update)); } catch (err) {}

    successEl.textContent = mode === "trial" ? "Free trial started!" : "Payment confirmed — plan upgraded!";
    successEl.classList.remove("hidden");
    renderPlanStatusBanner();
    renderPlanActionButton();
    setTimeout(enforcePlanLock, 1200);
  } catch (err) {
    console.error("Could not update plan:", err);
    errorEl.textContent = err?.message === "Payment cancelled" ? "Payment cancelled." : "Could not update plan. Please try again.";
    errorEl.classList.remove("hidden");
    btn.textContent = originalLabel;
    btn.disabled = false;
  }
}

function populateAddMemberPlanOptions() {
  const select = document.getElementById("addMemberPlan");
  select.innerHTML = Object.entries(PLANS)
    .map(([id, plan]) => `<option value="${id}">${plan.label} — ${formatCurrency(plan.price)}</option>`)
    .join("");
}

// ==================== GYM SETTINGS (name / currency / country code / plans) ====================
// Previously gym name & plan pricing could only be changed by editing
// settings/gymConfig directly in the Firebase console — this modal lets
// the gym owner do it themselves from the admin panel.

function generatePlanId() {
  return `plan_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Appends one plan row (label/months/price inputs + remove button) to the
 *  settings modal, cloned from the <template>. `id` is kept on the row via
 *  a data attribute — not shown to the admin, just carried through to the
 *  saved plans map so existing member records (which reference plan IDs)
 *  keep working after a save. */
function addPlanRow(id, plan) {
  const template = document.getElementById("settingsPlanRowTemplate");
  const row = template.content.firstElementChild.cloneNode(true);
  row.dataset.planId = id;
  row.querySelector('[data-field="label"]').value = plan.label || "";
  row.querySelector('[data-field="months"]').value = plan.months || 1;
  row.querySelector('[data-field="price"]').value = plan.price ?? 0;
  document.getElementById("settingsPlanRows").appendChild(row);
}

function openGymSettingsModal() {
  document.getElementById("settingsGymName").value = GYM_SETTINGS.name || "";
  document.getElementById("settingsCurrencySymbol").value = GYM_SETTINGS.currencySymbol || "₹";
  document.getElementById("settingsCountryCode").value = GYM_SETTINGS.defaultCountryCode || "91";

  const rowsContainer = document.getElementById("settingsPlanRows");
  rowsContainer.innerHTML = "";
  Object.entries(PLANS).forEach(([id, plan]) => addPlanRow(id, plan));

  document.getElementById("gymSettingsError").classList.add("hidden");
  document.getElementById("gymSettingsSuccess").classList.add("hidden");
  document.getElementById("gymSettingsModal").classList.remove("hidden");
}

function closeGymSettingsModal() {
  document.getElementById("gymSettingsModal").classList.add("hidden");
}

async function handleGymSettingsSubmit(e) {
  e.preventDefault();
  const errorEl = document.getElementById("gymSettingsError");
  const successEl = document.getElementById("gymSettingsSuccess");
  errorEl.classList.add("hidden");
  successEl.classList.add("hidden");

  const name = document.getElementById("settingsGymName").value.trim();
  const currencySymbol = document.getElementById("settingsCurrencySymbol").value.trim();
  const defaultCountryCode = document.getElementById("settingsCountryCode").value.trim();

  const plans = {};
  const rows = document.querySelectorAll("#settingsPlanRows .settings-plan-row");
  for (const row of rows) {
    const id = row.dataset.planId;
    const label = row.querySelector('[data-field="label"]').value.trim();
    const months = Number(row.querySelector('[data-field="months"]').value);
    const price = Number(row.querySelector('[data-field="price"]').value);
    if (!label || !months || months < 1 || price < 0) {
      errorEl.textContent = "Every plan needs a label, at least 1 month, and a valid price.";
      errorEl.classList.remove("hidden");
      return;
    }
    plans[id] = { label, months, price };
  }

  if (!name || !defaultCountryCode || Object.keys(plans).length === 0) {
    errorEl.textContent = "Gym name, country code, and at least one plan are required.";
    errorEl.classList.remove("hidden");
    return;
  }

  const saveBtn = document.getElementById("gymSettingsSaveBtn");
  const originalLabel = saveBtn.textContent;
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";

  const data = { name, currencySymbol, defaultCountryCode, plans };

  try {
    await db.collection("settings").doc("gymConfig").set(data);

    // Reflect immediately across the app — GYM_SETTINGS/PLANS are mutated
    // in place (see firebase-config.js), so every existing reference
    // (plan pickers, gym name labels) picks up the new values without a
    // page reload.
    applyGymConfig(data);
    cacheGymConfig(data);
    document.getElementById("gymNameLabelAdmin").textContent = GYM_SETTINGS.name;

    successEl.textContent = "Settings saved!";
    successEl.classList.remove("hidden");
    setTimeout(closeGymSettingsModal, 1200);
  } catch (err) {
    console.error("Could not save gym settings:", err);
    errorEl.textContent = "Could not save settings. Please try again.";
    errorEl.classList.remove("hidden");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = originalLabel;
  }
}

function showAddMemberError(message) {
  const el = document.getElementById("addMemberError");
  el.textContent = message;
  el.classList.remove("hidden");
}

/**
 * Admin-side manual registration. Mirrors the self-registration flow in
 * member.js (same `members/{phone}` doc shape, same doc-ID-is-phone
 * convention) but the member is created pre-approved — `approved: true` —
 * since the admin is vouching for them in person, unlike public
 * self-registrations which always start as `approved: false`. Payment
 * status is whatever the admin selects (defaults to "pending").
 *
 * NOTE: firestore.rules must allow this — see the added admin branch on
 * the `members/{phone}` create rule, which permits `approved: true` /
 * `paymentStatus: "paid"` only when `isVerifiedAdminDirect()` is true.
 */
async function handleAddMemberSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const submitBtn = document.getElementById("addMemberSubmitBtn");
  document.getElementById("addMemberError").classList.add("hidden");

  const name = form.name.value.trim();
  const phone = normalizePhone(form.phone.value.trim());
  const address = form.address.value.trim();
  const joinDate = form.joinDate.value;
  const planId = form.plan.value;
  const paymentStatus = form.querySelector('input[name="paymentStatus"]:checked')?.value || "pending";

  if (!name || phone.length < 7 || !address || !joinDate || !planId) {
    showAddMemberError("Please fill every field with a valid phone number.");
    return;
  }

  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Registering…";

  try {
    // 1. Pehle check kar ki member pehle se exist karta hai ya nahi
    const existingDoc = await membersCol.doc(phone).get();
    if (existingDoc.exists) {
      showAddMemberError("A member with this phone number already exists.");
      return;
    }

    const plan = PLANS[planId];
    
    // 2. Naya logic: Days aur Months dono ko support karega
    let expiryDate;
    if (plan.days) {
      // Agar plan days mein hai (jaise 1 day, 7 days)
      const [y, m, d] = joinDate.split("-").map(Number);
      const date = new Date(y, m - 1, d);
      date.setDate(date.getDate() + plan.days);
      expiryDate = toDateKey(date);
    } else {
      // Agar plan months mein hai (jaise 1m, 3m, etc.)
      expiryDate = addMonthsToDateKey(joinDate, plan.months || 1);
    }

    // 3. Firestore mein member save karna
    await membersCol.doc(phone).set({
      name,
      phone,
      address,
      joinDate,
      plan: planId,
      expiryDate,
      paymentStatus,
      approved: true,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    if (paymentStatus === "paid") {
      await paymentsCol.add({
        memberId: phone,
        name,
        phone,
        plan: planId,
        amount: plan.price,
        method: "cash",
        dateKey: toDateKey(new Date()),
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }

    closeAddMemberModal();
  } catch (err) {
    console.error(err);
    showAddMemberError("Could not register member. Please check the details and try again.");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
}


// --------------------------------------------- quick check-in by phone --
/**
 * Lets the admin check a member in by typing their phone number instead of
 * hunting for their row in the table. Looks the member up client-side in
 * the already-subscribed `allMembers` array, then delegates to the
 * existing manualCheckIn() so the write path (deterministic
 * `memberId_dateKey` doc, `method: "manual"`, `loggedBy`, server
 * timestamp) is identical to the per-row Check-In button.
 */


// ------------------------------------------------- re-auth confirmation --
function requestReauth(type, member, btn) {
  const user = auth.currentUser;
  if (!user) return;

  pendingReauthAction = { type, member, btn };
  const isPasswordUser = user.providerData.some((p) => p.providerId === "password");

  const titleEl = document.getElementById("reauthTitle");
  const msgEl = document.getElementById("reauthMessage");
  const passwordField = document.getElementById("reauthPasswordField");
  const googleHint = document.getElementById("reauthGoogleHint");
  const passwordInput = document.getElementById("reauthPasswordInput");
  const submitBtn = document.getElementById("reauthSubmitBtn");
  const errorEl = document.getElementById("reauthError");

  errorEl.classList.add("hidden");
  passwordInput.value = "";

  if (type === "delete") {
    titleEl.textContent = "Delete this member?";
    msgEl.textContent = `This permanently deletes ${member.name}'s record from Firestore. Confirm your identity to continue.`;
  } else {
    titleEl.textContent = "Confirm payment update";
    msgEl.textContent = `This marks ${member.name}'s payment as PAID. Confirm your identity to continue.`;
  }

  if (isPasswordUser) {
    passwordField.classList.remove("hidden");
    googleHint.classList.add("hidden");
    submitBtn.textContent = "Confirm";
    setTimeout(() => passwordInput.focus(), 50);
  } else {
    passwordField.classList.add("hidden");
    googleHint.classList.remove("hidden");
    submitBtn.textContent = "Confirm with Google";
  }

  document.getElementById("reauthModal").classList.remove("hidden");
}

function closeReauthModal() {
  document.getElementById("reauthModal").classList.add("hidden");
  pendingReauthAction = null;
}

async function handleReauthSubmit(e) {
  e.preventDefault();
  if (!pendingReauthAction) return;

  const user = auth.currentUser;
  const submitBtn = document.getElementById("reauthSubmitBtn");
  const errorEl = document.getElementById("reauthError");
  errorEl.classList.add("hidden");

  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Verifying security…";

  try {
    // Check if platform authenticator (fingerprint/face lock) is available
    const biometricSupported = window.PublicKeyCredential && 
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      
    const storedCredentialId = getStoredCredentialId(user.uid);

    if (biometricSupported && storedCredentialId) {
      // SCENARIO A: Mobile / Biometric PC — Use Device Fingerprint/Passkey
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [{ id: base64urlToBuffer(storedCredentialId), type: "public-key" }],
          userVerification: "required",
          timeout: 60000,
        },
      });
      if (!assertion) throw new Error("Device verification cancelled");

    } else {
      // SCENARIO B: Desktop / PC without biometric — Fallback to Password Prompt securely
      const passwordInput = document.getElementById("reauthPasswordInput");
      // If password field was hidden, make it temporarily visible for desktop fallback
      const passwordField = document.getElementById("reauthPasswordField");
      
      if (passwordField.classList.contains("hidden")) {
        passwordField.classList.remove("hidden");
        submitBtn.textContent = "Confirm Password";
        submitBtn.disabled = false;
        passwordInput.focus();
        throw new Error("Biometric not available on this device. Please enter your password below:");
      }

      const password = passwordInput.value;
      if (!password) throw { code: "auth/missing-password" };
      
      const credential = firebase.auth.EmailAuthProvider.credential(user.email, password);
      await user.reauthenticateWithCredential(credential);
    }

    // Security check passed successfully! Execute the action.
    const { type, member, btn } = pendingReauthAction;
    closeReauthModal();

    if (type === "delete") {
      await executeDeleteMember(member, btn);
    } else if (type === "mark-paid") {
      await executeMarkAsPaid(member, btn);
    }
  } catch (err) {
    console.error("Verification failed:", err);
    let message = "Verification failed. Please try again.";
    if (err.name === "NotAllowedError") {
      message = "Device verification was cancelled.";
    } else if (err.code === "auth/wrong-password" || err.code === "auth/invalid-credential") {
      message = "That password doesn't match.";
    } else if (err.code === "auth/missing-password") {
      message = "Please enter your password.";
    } else if (err.message) {
      message = err.message;
    }
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
  } finally {
    if (submitBtn.textContent !== "Confirm Password") {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  }
}




async function executeMarkAsPaid(member, btn) {
  const originalLabel = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving…";
  }
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
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel || "Mark as Paid";
    }
  }
}

async function executeDeleteMember(member, btn) {
  const originalLabel = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Deleting…";
  }
  try {
    // 1. Member ko members collection se delete karo
    await membersCol.doc(member.id).delete();

    // 2. Us member ke saare check-ins bhi checkins collection se hata do
    const checkinsSnapshot = await checkinsCol.where("memberId", "==", member.id).get();
    const batch = db.batch();
    checkinsSnapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });
    await batch.commit();

  } catch (err) {
    console.error(err);
    alert("Could not delete member and records. Please try again.");
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel || "Delete";
    }
  }
}


// Manual Check-In
// Manual Check-In with Deterministic ID (`memberId_dateKey`)
async function manualCheckIn(member, btn) {
  if (todayCheckedInIds.has(member.id)) return;

  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Checking in…";
  
  try {
    const today = toDateKey(new Date());
    const checkinId = `${member.id}_${today}`;
    
    await checkinsCol.doc(checkinId).set({
      memberId: member.id,
      name: member.name,
      phone: member.phone,
      dateKey: today,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      method: "manual",
      loggedBy: auth.currentUser ? auth.currentUser.email : null,
    });

    // Bump the monthly check-in counter too, same "YYYY-MM" reset logic as
    // the member kiosk's self-checkin — `member` is already in memory
    // (allMembers), so this costs zero extra reads.
    const currentMonthKey = `${today.slice(0, 4)}-${today.slice(5, 7)}`; // today is YYYY-MM-DD
    const isSameMonth = member.checkinMonthKey === currentMonthKey;
    const newCount = isSameMonth ? (member.monthlyCheckinCount || 0) + 1 : 1;
    await membersCol.doc(member.id).update({
      monthlyCheckinCount: newCount,
      checkinMonthKey: currentMonthKey,
    });
    member.monthlyCheckinCount = newCount;
    member.checkinMonthKey = currentMonthKey;
  } catch (err) {
    console.error(err);
    alert("Could not log check-in. Please try again.");
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}


/**
 * Exports the currently loaded member list (allMembers -- already in
 * memory, so this is a zero-extra-read operation) as a CSV file the
 * browser downloads directly. No backend/Cloud Function involved -- just
 * builds the CSV string client-side and triggers a download via a
 * temporary <a> tag, same trick used everywhere for browser-side exports.
 */
function exportMembersToCsv() {
  if (!allMembers.length) {
    alert("No members to export yet.");
    return;
  }

  const headers = ["Name", "Phone", "Address", "Plan", "Join Date", "Expiry Date", "Days Remaining", "Payment Status", "Approved", "Monthly Check-ins"];

  // Wrap each field in quotes and escape any embedded quotes, so commas or
  // quote characters inside a member's name/address don't break columns.
  const escapeCsvField = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

  const rows = allMembers.map((m) => [
    m.name,
    m.phone,
    m.address,
    (PLANS[m.plan] || { label: m.plan }).label,
    formatDate(m.joinDate),
    formatDate(m.expiryDate),
    daysUntil(m.expiryDate),
    m.paymentStatus === "paid" ? "Paid" : "Pending",
    m.approved === true ? "Yes" : "No",
    m.monthlyCheckinCount || 0,
  ].map(escapeCsvField).join(","));

  const csvContent = [headers.map(escapeCsvField).join(","), ...rows].join("\r\n");

  // BOM prefix so Excel (including on Windows) opens the file with correct
  // UTF-8 rendering instead of mangling non-ASCII characters in names.
  const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const today = toDateKey(new Date());
  link.href = url;
  link.download = `${GYM_SETTINGS.name.replace(/\s+/g, "-")}-members-${today}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
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

function subscribeTodayCheckins() {
  const today = toDateKey(new Date());
  unsubCheckins = checkinsCol
    .where("dateKey", "==", today)
    .onSnapshot(
      (snap) => {
        const rows = snap.docs
          .map((d) => d.data())
          .sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));
        todayCheckedInIds = new Set(rows.map((r) => r.memberId).filter(Boolean));
        renderCheckinLog(rows);
        renderMemberTable();
        document.getElementById("statTodayCheckins").textContent = rows.length;
      },
      (err) => console.error("checkins listener error", err)
    );
}

function renderCheckinLog(rows) {
  window._latestTodayRows = rows; // Cache rows for filtering
  const list = document.getElementById("checkinLog");
  const emptyState = document.getElementById("checkinEmptyState");
  list.innerHTML = "";

  // Filter rows based on currentTimeFilter
  const filteredRows = rows.filter((row) => {
    if (!row.timestamp || !row.timestamp.toDate) return true;
    const hour = row.timestamp.toDate().getHours(); // 0 to 23

    if (currentTimeFilter === "morning") {
      return hour >= 5 && hour < 12; // 5 AM to 12 PM
    } else if (currentTimeFilter === "afternoon") {
      return hour >= 12 && hour < 17; // 12 PM to 5 PM
    } else if (currentTimeFilter === "evening") {
      return hour >= 17 || hour < 5; // 5 PM to 5 AM
    }
    return true; // "all"
  });

  emptyState.classList.toggle("hidden", filteredRows.length > 0);

  filteredRows.forEach((row) => {
    const time = row.timestamp?.toDate
      ? row.timestamp.toDate().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      : "—";

    // 🔥 Fallback: Agar row.name missing hai toh allMembers se name dhoond lo
    let displayName = row.name;
    if (!displayName && row.memberId) {
      const foundMember = allMembers.find((m) => m.id === row.memberId);
      if (foundMember) displayName = foundMember.name;
    }
    if (!displayName) displayName = "Member";

    const li = document.createElement("li");
    li.className = "flex items-center justify-between py-2.5 border-b border-slate-800/70 last:border-0";
    li.innerHTML = `
      <div class="flex items-center gap-3">
        <span class="w-2 h-2 rounded-full bg-success"></span>
        <div>
          <p class="text-sm font-medium text-slate-100">${escapeHtml(displayName)}</p>
          <p class="text-xs text-slate-500">+${GYM_SETTINGS.defaultCountryCode} ${row.phone}</p>
        </div>
      </div>
      <span class="text-xs text-slate-500">${time}</span>
    `;
    list.appendChild(li);
  });
}



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

function renderStats() {
  // 🔥 Ab active members mein sirf wahi count honge jo approved bhi hain aur expiry bhi bachi hai
  const active = allMembers.filter((m) => m.approved === true && daysUntil(m.expiryDate) >= 0).length;

  // 🔥 Payment Pending ab sirf approved members mein count hoga (unapproved ka payment status abhi maayne nahi rakhta)
  const pending = allMembers.filter((m) => m.approved === true && m.paymentStatus !== "paid").length;

  // 🔥 Total non-approved (naye/self-registered) members ka alag count
  const pendingApproval = allMembers.filter((m) => m.approved !== true).length;

  document.getElementById("statActive").textContent = active;
  document.getElementById("statPending").textContent = pending;
  document.getElementById("statTotal").textContent = allMembers.length;
  const pendingApprovalEl = document.getElementById("statPendingApproval");
  if (pendingApprovalEl) pendingApprovalEl.textContent = pendingApproval;
}


function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

let unsubAllPayments = null;

// Isko subscribeDashboardHistory ya subscribeMembers ke sath call kar lena dashboard load hone par
function subscribeMonthlyHistory() {
  unsubAllPayments = paymentsCol
    .orderBy("timestamp", "desc")
    .limit(300)   // sirf last 300 payments padhega, poori history nahi — chart ke liye kaafi hai
    .onSnapshot(
    (snap) => {
      const payments = snap.docs.map((d) => d.data());
      const monthlyData = {};

      payments.forEach((p) => {
        // dateKey ya timestamp se month extract karna (e.g., "September 2026")
        let monthKey = "Recent";
        if (p.timestamp && p.timestamp.toDate) {
          const date = p.timestamp.toDate();
          monthKey = date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
        } else if (p.dateKey) {
          // Fallback agar dateKey format "YYYY-MM-DD" ho
          const parts = p.dateKey.split("-");
          if (parts.length >= 2) {
            const date = new Date(parts[0], parts[1] - 1, 1);
            monthKey = date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
          }
        }

        if (!monthlyData[monthKey]) {
          monthlyData[monthKey] = { count: 0, total: 0 };
        }
        monthlyData[monthKey].count += 1;
        monthlyData[monthKey].total += (p.amount || 0);
      });

      renderMonthlyHistory(monthlyData);
    },
    (err) => console.error("Monthly history listener error", err)
  );
}

function renderMonthlyHistory(monthlyData) {
  const tbody = document.getElementById("monthlyHistoryTableBody");
  const emptyState = document.getElementById("historyEmptyState");
  tbody.innerHTML = "";

  const keys = Object.keys(monthlyData);
  emptyState.classList.toggle("hidden", keys.length > 0);

  keys.forEach((month) => {
    const data = monthlyData[month];
    const tr = document.createElement("tr");
    tr.className = "border-b border-slate-800/70 hover:bg-slate-800/30 transition";
    tr.innerHTML = `
      <td class="py-3 pr-4 font-medium text-slate-100">${month}</td>
      <td class="py-3 pr-4 text-slate-300">${data.count} payments</td>
      <td class="py-3 pr-0 text-right font-semibold text-accent">${formatCurrency(data.total)}</td>
    `;
    tbody.appendChild(tr);
  });
}


let checkinsChartInstance = null;

function renderWeeklyCheckinsChart(checkinsList) {
  const ctx = document.getElementById("weeklyCheckinsChart");
  if (!ctx) return;

  // Pichhle 7 dino ke dates generate karna
  const daysMap = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = toDateKey(d); // "YYYY-MM-DD" format
    const label = d.toLocaleDateString("en-US", { weekday: 'short' }); // "Mon", "Tue"
    daysMap[key] = { label: label, count: 0 };
  }

  // Check-ins count karna unke dateKey ke hisab se
  checkinsList.forEach((item) => {
    if (daysMap[item.dateKey]) {
      daysMap[item.dateKey].count += 1;
    }
  });

  const labels = Object.values(daysMap).map(d => d.label);
  const dataValues = Object.values(daysMap).map(d => d.count);

  if (checkinsChartInstance) {
    checkinsChartInstance.destroy();
  }

  checkinsChartInstance = new Chart(ctx, {
    type: 'bar', // ya 'line' bhi kar sakta hai
    data: {
      labels: labels,
      datasets: [{
        label: 'Check-ins',
        data: dataValues,
        backgroundColor: '#38BDF8',
        borderRadius: 4,
        barThickness: 16,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#64748B', font: { size: 10 } }
        },
        y: {
          grid: { color: 'rgba(30, 41, 59, 0.5)' },
          ticks: { color: '#64748B', font: { size: 10 }, stepSize: 1 }
        }
      }
    }
  });
}

let currentTimeFilter = "all"; // Default filter

// DOMContentLoaded ke andar yeh event listener add kar dena:
const checkinTimeFilterGroup = document.getElementById("checkinTimeFilterGroup");
if (checkinTimeFilterGroup) {
  checkinTimeFilterGroup.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-time-filter]");
    if (!btn) return;
    currentTimeFilter = btn.dataset.timeFilter;
    
    // Update button styles
    document.querySelectorAll(".checkin-time-btn").forEach((b) => {
      const active = b.dataset.timeFilter === currentTimeFilter;
      b.classList.toggle("bg-accent", active);
      b.classList.toggle("text-slate-950", active);
      b.classList.toggle("bg-slate-800", !active);
      b.classList.toggle("text-slate-400", !active);
    });

    // Re-render log with current rows
    if (window._latestTodayRows) {
      renderCheckinLog(window._latestTodayRows);
    }
  });
}