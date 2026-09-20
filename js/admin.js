// FitTrack QR Gym Manager — Admin Dashboard logic (admin.html)

const membersCol = db.collection("members");
const checkinsCol = db.collection("checkins");
const paymentsCol = db.collection("payments");
const refundsCol = db.collection("refunds");

let allMembers = [];
let unsubMembers = null;
let unsubCheckins = null;
let unsubPayments = null;

// "owner" (full access) or "staff" (front-desk: check-in/approve only).
// Set from the admins/{email} doc's `role` field once sign-in verifies
// admin access (see isVerifiedAdmin) — missing/absent role defaults to
// "owner", matching firestore.rules' isOwnerAdmin() default so an existing
// admin without this field set isn't accidentally locked out.
let currentAdminRole = "owner";

let currentMemberFilter = "all";
let todayCheckedInIds = new Set();

// Variable to track pending secure action for re-auth
let pendingReauthAction = null;

// Grace window: once the admin has verified once (passkey/password), any
// OTHER sensitive action (delete / mark-paid / refund / phone-change)
// within this window skips re-asking — avoids re-verifying 3-4 times in a
// row during, say, a bulk cleanup session. Resets on page reload (in
// memory only, never persisted), so a fresh session always re-verifies.
const REAUTH_GRACE_MS = 5 * 60 * 1000;
let lastVerifiedAt = 0;

// Member currently open in the Renew Plan modal
let pendingRenewMember = null;

// Member currently open in the Cancel & Refund modal
let pendingRefundMember = null;

// Member currently open in the Change Phone Number modal
let pendingPhoneChangeMember = null;

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
      if (doc.exists) {
        currentAdminRole = doc.data().role === "staff" ? "staff" : "owner";
      }
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
  document.getElementById("logoutBtn").addEventListener("click", () => { lastVerifiedAt = 0; currentAdminRole = "owner"; auth.signOut(); });
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

  // Renew Plan modal
  document.getElementById("renewCancelBtn").addEventListener("click", closeRenewModal);
  document.getElementById("renewCloseBtn").addEventListener("click", closeRenewModal);
  document.getElementById("renewBackdrop").addEventListener("click", closeRenewModal);
  document.getElementById("renewForm").addEventListener("submit", handleRenewSubmit);
  document.getElementById("renewPlanSelect").addEventListener("change", updateRenewPreview);
  document.querySelectorAll('input[name="renewPaymentMode"]').forEach((el) =>
    el.addEventListener("change", updateRenewPreview)
  );

  // Cancel & Refund modal
  document.getElementById("refundCancelBtn").addEventListener("click", closeRefundModal);
  document.getElementById("refundCloseBtn").addEventListener("click", closeRefundModal);
  document.getElementById("refundBackdrop").addEventListener("click", closeRefundModal);
  document.getElementById("refundForm").addEventListener("submit", handleRefundSubmit);

  // Change Phone Number modal
  document.getElementById("phoneChangeCancelBtn").addEventListener("click", closePhoneChangeModal);
  document.getElementById("phoneChangeCloseBtn").addEventListener("click", closePhoneChangeModal);
  document.getElementById("phoneChangeBackdrop").addEventListener("click", closePhoneChangeModal);
  document.getElementById("phoneChangeForm").addEventListener("submit", handlePhoneChangeSubmit);

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

  // Staff Access modal (owner-only) — add/remove front-desk staff logins.
  document.getElementById("staffAccessBtn").addEventListener("click", openStaffAccessModal);
  document.getElementById("staffAccessCloseBtn").addEventListener("click", closeStaffAccessModal);
  document.getElementById("staffAccessBackdrop").addEventListener("click", closeStaffAccessModal);
  document.getElementById("staffAccessForm").addEventListener("submit", handleAddStaffSubmit);
  document.getElementById("staffAccessBtn").addEventListener("click", () => toggleProfileMenu(true));
  document.getElementById("staffListRows").addEventListener("click", (e) => {
    const btn = e.target.closest('button[data-action="remove-staff"]');
    if (!btn) return;
    const email = btn.closest(".staff-row").dataset.email;
    // Same reason as handleAddStaffSubmit below: close this modal before
    // the reauth modal opens, or the two (same z-50) stack in DOM order
    // and this one hides the "Confirm" button underneath it.
    closeStaffAccessModal();
    requestReauth("remove-staff", null, btn, { email });
  });

  // Plan & Features modal (Basic/Prime/Advance tier + which features that
  // unlocks) — controls hasFeature() everywhere else in the app.
  document.getElementById("planFeaturesBtn").addEventListener("click", () => {
    toggleProfileMenu(true);
    openPlanFeaturesModal(false);
  });
  document.getElementById("exportCsvBtn").addEventListener("click", () => {
    toggleProfileMenu(true);
    exportMembersToCsv();
  });
  document.getElementById("gymSettingsBtn").addEventListener("click", () => toggleProfileMenu(true));

  // Notification bell (new member / SaaS trial-plan expiry / custom broadcasts)
  document.getElementById("notifBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleProfileMenu(true);
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

  // Profile menu (photo/name button -> Sign Out + settings dropdown)
  document.getElementById("profileMenuBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleNotifDropdown(true);
    toggleProfileMenu();
  });
  document.addEventListener("click", (e) => {
    const wrap = document.getElementById("profileMenuWrap");
    if (wrap && !wrap.contains(e.target)) toggleProfileMenu(true);
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
  if (unsubStaff) unsubStaff();
  if (planLockCheckInterval) { clearInterval(planLockCheckInterval); planLockCheckInterval = null; }
  planModalLocked = false;
  closeReauthModal();
}


let planLockCheckInterval = null;

/**
 * Staff (front-desk) role gets check-in/approve only — everything
 * financial or destructive is hidden here, and separately hard-blocked at
 * the Firestore rules level (isOwnerAdmin()) so hiding a button is a UX
 * nicety, not the actual security boundary.
 *
 * NOTE on limits: Firestore has no field-level read security — a staff
 * login can still technically read a member's `duesAmount`/`paymentStatus`
 * fields via the members list (they're on the same doc as name/approval
 * status, which staff legitimately needs for check-in). This hides the
 * dedicated revenue/dues *summary* views; it can't redact those two
 * fields from the member directory without moving them into a separate,
 * owner-only subcollection — a bigger data-model change, ask if you want it.
 */
function applyRolePermissions() {
  const isOwner = currentAdminRole === "owner";

  const titleEl = document.getElementById("dashboardTitleLabel");
  if (titleEl) titleEl.textContent = isOwner ? "Owner Dashboard" : "Staff Dashboard";
  document.title = isOwner ? "FitTrack — Owner Dashboard" : "FitTrack — Staff Dashboard";

  const ownerOnlyIds = [
    "gymSettingsBtn",     // gym's own membership plan pricing / config
    "staffAccessBtn",     // add/remove staff logins (list on /admins is owner-only in rules)
    "openAddMemberBtn",   // manual registration (create is owner-only in rules)
    "revenueStatCard",    // Revenue (This Month) stat
  ];
  ownerOnlyIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("hidden", !isOwner);
  });

  const revenueHistorySection = document.getElementById("monthlyRevenueHistorySection");
  if (revenueHistorySection) revenueHistorySection.classList.toggle("hidden", !isOwner);

  const duesSub = document.getElementById("statDuesSub");
  if (duesSub) duesSub.classList.toggle("hidden", !isOwner);
}

function showDashboard(user) {
  showScreen("dashboardScreen");
  document.getElementById("adminEmailLabel").textContent =
    user.displayName || (user.email ? user.email.split("@")[0] : "Admin");
  renderProfileMenu(user);
  applyRolePermissions();

  subscribeMembers();
  subscribeWeeklyAndTodayCheckins(); // <-- Yeh dono cheezein ek sath handle karega (Chart + Today's List)
  // Payments collection is owner-only in firestore.rules — these would
  // throw permission-denied for a staff login, so skip subscribing at all
  // rather than hide the failing listener's output.
  if (currentAdminRole === "owner") {
    subscribeMonthlyRevenue();
    subscribeMonthlyHistory();
    // /admins list access is owner-only in firestore.rules — a staff login
    // would get permission-denied here, so skip subscribing entirely.
    subscribeStaffList();
  }

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
const HEADER_DROPDOWN_IDS = ["notifDropdown", "profileMenuDropdown"];

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
  const map = { notifDropdown: "notifBtn", profileMenuDropdown: "profileMenuBtn" };
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
        subtitle: `${m.name || "A new member"} · +${GYM_SETTINGS.defaultCountryCode} ${m.phone || ""}`,
        timeMs: createdAtMs,
        memberId: m.id,
      });
    }
  });

  // 2. Members whose due date has arrived or already passed
  allMembers.forEach((m) => {
    if (!m.expiryDate) return;
    const due = daysUntil(m.expiryDate);
    if (due <= 0) {
      const status = due === 0 ? "Due today." : `Overdue by ${Math.abs(due)} day${Math.abs(due) === 1 ? "" : "s"}.`;
      items.push({
        id: `member-due-${m.id}-${m.expiryDate}`,
        icon: "⚠️",
        title: `Membership due: ${m.name || "Member"}`,
        subtitle: `+${GYM_SETTINGS.defaultCountryCode} ${m.phone || ""} · ${status}`,
        timeMs: new Date(m.expiryDate).getTime() || now,
        memberId: m.id,
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
      if (n.memberId) jumpToMemberCard(n.memberId);
    });
    row.querySelector('[data-role="notif-clear"]').addEventListener("click", (e) => {
      e.stopPropagation();
      dismissNotification(n.id);
    });
    list.appendChild(row);
  });
}

/** Called when a notification tied to a specific member is tapped.
 * Closes the notification dropdown, clears any search/filter that
 * could be hiding that member from the list, then scrolls to and
 * briefly highlights their row/card so the owner can find them
 * instantly instead of having to search manually. */
function jumpToMemberCard(memberId) {
  toggleNotifDropdown(true);
  toggleProfileMenu(true);

  const searchEl = document.getElementById("memberSearch");
  let needsRerender = false;
  if (searchEl && searchEl.value.trim() !== "") {
    searchEl.value = "";
    needsRerender = true;
  }
  if (currentMemberFilter !== "all") {
    currentMemberFilter = "all";
    updateMemberFilterStyles();
    needsRerender = true;
  }
  if (needsRerender) renderMemberTable();

  // Give the DOM a tick to repaint after any re-render above, then scroll.
  setTimeout(() => {
    const targets = document.querySelectorAll(`[data-member-id="${cssEscape(memberId)}"]`);
    if (!targets.length) return;
    // Scroll whichever one is actually visible (table row on desktop,
    // card on mobile) — offscreen (display:none via responsive classes)
    // elements report 0 size and are skipped.
    let el = null;
    targets.forEach((t) => {
      if (!el && t.offsetParent !== null) el = t;
    });
    if (!el) el = targets[0];
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("notif-jump-highlight");
    setTimeout(() => el.classList.remove("notif-jump-highlight"), 2200);
  }, 60);
}

/** Minimal CSS.escape polyfill fallback for member phone-number ids
 * (Firestore doc id / member.id), which are plain digit strings anyway,
 * but this keeps the selector safe if that ever changes. */
function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(String(value));
  return String(value).replace(/[^a-zA-Z0-9_\-]/g, "\\$&");
}

function buildMemberActionsHtml(m, dotSizeClass) {
  const days = daysUntil(m.expiryDate);
  const isActive = days >= 0;
  const isPaid = m.paymentStatus === "paid";
  const isApproved = m.approved === true;
  const isFrozen = m.isFrozen === true;
  const alreadyCheckedIn = todayCheckedInIds.has(m.id);

  return `
    <!-- 🔥 Approve Button (Sirf tab dikhega jab user approved na ho) -->
    ${!isApproved ? `<button data-action="approve" data-id="${m.id}" class="text-xs font-semibold rounded-md bg-amber-500/15 text-amber-400 px-3 py-1.5 hover:bg-amber-500/25 transition">Approve</button>` : ""}

    <!-- 🔥 Check-In button sirf approved, non-frozen members ko dikhega -->
    ${isApproved && !isFrozen ? `
      <button data-action="check-in" data-id="${m.id}" ${alreadyCheckedIn ? "disabled" : ""}
        class="text-xs font-semibold rounded-md px-3 py-1.5 transition ${
          alreadyCheckedIn ? "bg-slate-800 text-slate-500 cursor-not-allowed" : "bg-accent/15 text-accent hover:bg-accent/25"
        }">${alreadyCheckedIn ? "✓ Checked In" : "Check-In"}</button>
    ` : ""}
    ${isApproved && isFrozen ? `<span class="text-xs font-semibold rounded-md bg-violet-500/15 text-violet-300 px-3 py-1.5">Paused</span>` : ""}

    <!-- 🔥 3-dot menu: Mark as Paid / Send WhatsApp / Renew / Freeze / Refund / Change Phone / Delete -->
    <div class="relative inline-block">
      <button data-action="more-menu" data-id="${m.id}"
        class="text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-md ${dotSizeClass} flex items-center justify-center transition"
        aria-label="More actions">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
      </button>
      <div data-menu-actions
        data-mark-paid="${!isPaid}"
        data-whatsapp="${!isActive || !isPaid}"
        data-renew="${isApproved}"
        data-freeze="${isApproved && !isFrozen && isActive}"
        data-resume="${isApproved && isFrozen}"
        data-refund="${isApproved && isPaid && isActive && !isFrozen}"
        data-change-phone="true"
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
    const isFrozen = m.isFrozen === true;
    const dues = m.duesAmount || 0; // 🔥 accumulated unpaid amount from credit renewals
    const frozenDaysSoFar = isFrozen && m.freezeStartDate ? Math.max(0, daysBetweenKeys(m.freezeStartDate, toDateKey(new Date()))) : 0;

    // ---- desktop/tablet table row (md and up) ----
    const tr = document.createElement("tr");
    tr.dataset.memberId = m.id;
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
        ${isApproved ? (isFrozen ? `
          <span class="badge bg-violet-500/15 text-violet-300">PAUSED</span>
          <p class="text-xs text-slate-500 mt-1">${frozenDaysSoFar}d paused so far</p>
        ` : `
          <span class="badge ${isActive ? "badge-success" : "badge-danger"}">${isActive ? "ACTIVE" : "EXPIRED"}</span>
          <p class="text-xs text-slate-500 mt-1">${isActive ? days + "d left" : Math.abs(days) + "d ago"}</p>
        `) : `
          <span class="badge badge-warning">Pending Approval</span>
        `}
      </td>
      <td class="py-3 pr-4">
        <!-- 🔥 Payment status sirf tab dikhega jab member approve ho chuka ho -->
        ${isApproved ? `
          <span class="badge ${isPaid ? "badge-success" : "badge-warning"}">${isPaid ? "PAID" : "Payment Pending"}</span>
          ${dues > 0 ? `<p class="text-xs text-rose-400 mt-1">Dues: ${formatCurrency(dues)}</p>` : ""}
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
    card.dataset.memberId = m.id;
    card.className = "rounded-xl border border-slate-800 bg-slate-900/50 p-3.5";
    card.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="font-medium text-slate-100 truncate">${escapeHtml(m.name)}</p>
          <p class="text-xs text-slate-500">+${GYM_SETTINGS.defaultCountryCode} ${m.phone}</p>
        </div>
        ${isApproved
          ? (isFrozen
              ? `<span class="badge shrink-0 bg-violet-500/15 text-violet-300">PAUSED</span>`
              : `<span class="badge shrink-0 ${isActive ? "badge-success" : "badge-danger"}">${isActive ? "ACTIVE" : "EXPIRED"}</span>`)
          : `<span class="badge shrink-0 badge-warning">Pending Approval</span>`
        }
      </div>

      <!-- 🔥 Payment badge sirf approved members ke liye -->
      ${isApproved ? `
        <div class="flex flex-wrap gap-1.5 mt-2.5 items-center">
          <span class="badge ${isPaid ? "badge-success" : "badge-warning"}">${isPaid ? "PAID" : "Payment Pending"}</span>
          ${dues > 0 ? `<span class="text-xs text-rose-400 font-medium">Dues: ${formatCurrency(dues)}</span>` : ""}
        </div>
      ` : ""}

      <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-400 mt-2.5 pt-2.5 border-t border-slate-800/70">
        <p class="truncate"><span class="text-slate-600">Plan:</span> ${plan.label}</p>
        <p class="truncate"><span class="text-slate-600">Expiry:</span> ${formatDate(m.expiryDate)} · ${isFrozen ? `paused ${frozenDaysSoFar}d` : (isActive ? days + "d left" : Math.abs(days) + "d ago")}</p>
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

  const isOwner = currentAdminRole === "owner";
  const wrapper = btn.nextElementSibling; // the data-menu-actions div holding flags
  // Staff (front-desk) only ever gets the Check-In / Approve buttons
  // outside this menu, plus WhatsApp reminders here — everything else in
  // this menu is financial or destructive and is owner-only, mirroring the
  // isOwnerAdmin() gate on the matching Firestore writes.
  const canMarkPaid = isOwner && wrapper.dataset.markPaid === "true";
  const canWhatsapp = wrapper.dataset.whatsapp === "true";
  const canRenew = isOwner && wrapper.dataset.renew === "true";
  const canFreeze = isOwner && wrapper.dataset.freeze === "true";
  const canResume = isOwner && wrapper.dataset.resume === "true";
  const canRefund = isOwner && wrapper.dataset.refund === "true";
  const canChangePhone = isOwner && wrapper.dataset.changePhone === "true";
  const canDelete = isOwner;

  const menu = document.createElement("div");
  menu.className =
    "fixed z-50 w-48 rounded-lg border border-slate-700 bg-slate-900 shadow-xl py-1 text-sm";
  menu.innerHTML = `
    ${canRenew ? `<button data-menu-action="renew" class="w-full text-left px-3 py-2 text-accent hover:bg-slate-800 transition">Renew Plan</button>` : ""}
    ${canMarkPaid ? `<button data-menu-action="mark-paid" class="w-full text-left px-3 py-2 text-success hover:bg-slate-800 transition">Mark as Paid</button>` : ""}
    ${canFreeze ? `<button data-menu-action="freeze" class="w-full text-left px-3 py-2 text-violet-300 hover:bg-slate-800 transition">Freeze / Pause</button>` : ""}
    ${canResume ? `<button data-menu-action="resume" class="w-full text-left px-3 py-2 text-violet-300 hover:bg-slate-800 transition">Resume Membership</button>` : ""}
    ${canRefund ? `<button data-menu-action="refund" class="w-full text-left px-3 py-2 text-amber-400 hover:bg-slate-800 transition">Cancel & Refund</button>` : ""}
    ${canWhatsapp ? `<button data-menu-action="whatsapp" class="w-full text-left px-3 py-2 text-emerald-400 hover:bg-slate-800 transition">Send WhatsApp</button>` : ""}
    ${canChangePhone ? `<button data-menu-action="change-phone" class="w-full text-left px-3 py-2 text-sky-400 hover:bg-slate-800 transition">Change Phone Number</button>` : ""}
    ${canDelete ? `<button data-menu-action="delete" class="w-full text-left px-3 py-2 text-rose-400 hover:bg-slate-800 transition">Delete</button>` : ""}
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
    if (action === "renew") openRenewModal(member);
    if (action === "mark-paid") requestReauth("mark-paid", member, btn);
    if (action === "freeze") executeFreezeMember(member, btn);
    if (action === "resume") executeResumeMember(member, btn);
    if (action === "refund") openRefundModal(member);
    if (action === "whatsapp") sendWhatsAppReminder(member);
    if (action === "change-phone") openPhoneChangeModal(member);
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
  const plan = PLANS[member.plan] || {};
  const isDayPass = !!plan.days;
  const isUnpaid = member.paymentStatus !== "paid";

  // 🔥 Day passes are one-off walk-ins — once approved they can check in
  // and leave, and there's no ongoing relationship to chase payment
  // later. So approving an unpaid day-pass member now asks to collect
  // payment in the same step, instead of silently approving on trust
  // (which is fine for regular members, but risky for a one-time visitor).
  // Staff (front-desk) can't collect/record payment (owner-only, same as
  // Mark as Paid) — for them this always stays a plain approve, payment
  // stays pending for an owner to collect later.
  let collectPaymentToo = false;
  if (isDayPass && isUnpaid && currentAdminRole === "owner") {
    collectPaymentToo = confirm(
      `This is a ${plan.label || "day pass"} (${formatCurrency(plan.price || 0)}) and payment is still pending.\n\n` +
      `Click OK to collect ${formatCurrency(plan.price || 0)} now and approve together, or Cancel to go back without approving.`
    );
    if (!collectPaymentToo) return; // admin backed out — member stays unapproved
  }

  const originalLabel = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Approving…";
  }
  try {
    const update = {
      approved: true,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (collectPaymentToo) {
      update.paymentStatus = "paid";
      update.duesAmount = 0;
    }
    await membersCol.doc(member.id).update(update);

    if (collectPaymentToo) {
      await paymentsCol.add({
        memberId: member.id,
        name: member.name,
        phone: member.phone,
        plan: member.plan,
        amount: plan.price || 0,
        method: "cash",
        dateKey: toDateKey(new Date()),
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
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

// ==================== RENEW PLAN (extend expiry, with optional "on credit") ====================
// Renews any approved member's plan. Base date for the new expiry is the
// LATER of today and their current expiry — so a member renewing early
// doesn't lose paid days, but a member who's already expired just gets a
// fresh full period starting today (fair, since the gap wasn't paid for).
//
// "Extend without collecting payment" is the real-world case where an
// owner lets a member keep training on trust and settle up later: it
// keeps paymentStatus pending AND adds this cycle's price to duesAmount
// (running total), instead of the old behavior where there was no way to
// track that a member now owes for TWO cycles, not one.

function computeRenewBaseDate(member) {
  const todayK = toDateKey(new Date());
  const currentExpiry = member.expiryDate;
  return currentExpiry && currentExpiry > todayK ? currentExpiry : todayK;
}

function computeRenewedExpiry(baseDateKey, plan) {
  if (plan.days) {
    const [y, m, d] = baseDateKey.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + plan.days);
    return toDateKey(date);
  }
  return addMonthsToDateKey(baseDateKey, plan.months || 1);
}

function populateRenewPlanOptions(selectedPlanId) {
  const select = document.getElementById("renewPlanSelect");
  select.innerHTML = Object.entries(PLANS)
    .map(([id, plan]) => `<option value="${id}" ${id === selectedPlanId ? "selected" : ""}>${plan.label} — ${formatCurrency(plan.price)}</option>`)
    .join("");
}

// 🔥 Day passes (1 Day, 3 Day, etc.) are walk-in, one-off transactions —
// there's no ongoing relationship to chase dues later, so "Extend on
// Credit" only makes sense for month-based plans. Force "Collect Now"
// and hide the credit option whenever a day-based plan is selected.
function updateRenewPaymentModeAvailability(plan) {
  const creditRadio = document.querySelector('input[name="renewPaymentMode"][value="credit"]');
  const creditLabel = creditRadio.closest("label");
  const noteEl = document.getElementById("renewCreditNote");
  const isDayPass = !!plan.days;

  creditLabel.classList.toggle("hidden", isDayPass);
  if (isDayPass) {
    creditRadio.checked = false;
    document.querySelector('input[name="renewPaymentMode"][value="now"]').checked = true;
    noteEl.textContent = "Day passes must be paid upfront — credit isn't available for walk-in passes.";
  } else {
    noteEl.textContent = "\"Extend on Credit\" keeps this unpaid — the amount is added to their dues instead.";
  }
}

function updateRenewPreview() {
  if (!pendingRenewMember) return;
  const planId = document.getElementById("renewPlanSelect").value;
  const plan = PLANS[planId];
  if (!plan) return;

  updateRenewPaymentModeAvailability(plan);

  const baseDate = computeRenewBaseDate(pendingRenewMember);
  const newExpiry = computeRenewedExpiry(baseDate, plan);
  document.getElementById("renewNewExpiryPreview").textContent = formatDate(newExpiry);

  const collectNow = document.querySelector('input[name="renewPaymentMode"]:checked')?.value === "now";
  const existingDues = pendingRenewMember.duesAmount || 0;
  const summaryEl = document.getElementById("renewAmountSummary");
  summaryEl.textContent = collectNow
    ? `${formatCurrency(plan.price + existingDues)} to collect now${existingDues > 0 ? ` (includes ${formatCurrency(existingDues)} previous dues)` : ""}`
    : `${formatCurrency(existingDues + plan.price)} will be owed (dues) — payment stays pending`;
}

function openRenewModal(member) {
  pendingRenewMember = member;
  document.getElementById("renewMemberName").textContent = member.name;
  document.getElementById("renewCurrentExpiry").textContent = formatDate(member.expiryDate);

  const existingDues = member.duesAmount || 0;
  const duesRow = document.getElementById("renewExistingDuesRow");
  if (existingDues > 0) {
    document.getElementById("renewExistingDues").textContent = formatCurrency(existingDues);
    duesRow.classList.remove("hidden");
  } else {
    duesRow.classList.add("hidden");
  }

  populateRenewPlanOptions(member.plan);
  const nowRadio = document.querySelector('input[name="renewPaymentMode"][value="now"]');
  if (nowRadio) nowRadio.checked = true;
  document.getElementById("renewError").classList.add("hidden");
  updateRenewPreview();
  document.getElementById("renewModal").classList.remove("hidden");
}

function closeRenewModal() {
  document.getElementById("renewModal").classList.add("hidden");
  pendingRenewMember = null;
}

async function handleRenewSubmit(e) {
  e.preventDefault();
  if (!pendingRenewMember) return;
  const member = pendingRenewMember;
  const submitBtn = document.getElementById("renewSubmitBtn");
  const errorEl = document.getElementById("renewError");
  errorEl.classList.add("hidden");

  const planId = document.getElementById("renewPlanSelect").value;
  const plan = PLANS[planId];
  let collectNow = document.querySelector('input[name="renewPaymentMode"]:checked')?.value === "now";
  if (!plan) return;

  // 🔥 Safety net: day passes always collect now, even if the UI state
  // somehow got out of sync with the selected plan.
  if (plan.days) collectNow = true;

  const baseDate = computeRenewBaseDate(member);
  const newExpiry = computeRenewedExpiry(baseDate, plan);
  const existingDues = member.duesAmount || 0;

  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Saving…";

  try {
    const update = {
      plan: planId,
      expiryDate: newExpiry,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };

    if (collectNow) {
      // Collecting now settles this cycle AND any dues already owed.
      update.paymentStatus = "paid";
      update.duesAmount = 0;
      await paymentsCol.add({
        memberId: member.id,
        name: member.name,
        phone: member.phone,
        plan: planId,
        amount: plan.price + existingDues,
        method: "cash",
        dateKey: toDateKey(new Date()),
        note: existingDues > 0 ? `Includes ₹${existingDues} previous dues` : "",
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      // Extended on credit — plan/check-ins continue, payment stays
      // pending, and the amount owed accumulates instead of resetting.
      update.paymentStatus = "pending";
      update.duesAmount = existingDues + plan.price;
    }

    await membersCol.doc(member.id).update(update);
    closeRenewModal();
  } catch (err) {
    console.error(err);
    errorEl.textContent = "Could not renew plan. Please try again.";
    errorEl.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
}

// ==================== FREEZE / PAUSE MEMBERSHIP ====================
// Real-world need: a member travelling for N days shouldn't have their
// expiry silently tick down while they're away. Freezing stops the clock
// (badge shows PAUSED, check-in is blocked) and Resume pushes expiryDate
// forward by exactly the number of days they were paused, so they get
// back every day they paid for.

async function executeFreezeMember(member, btn) {
  if (member.isFrozen) return;
  if (daysUntil(member.expiryDate) < 0) return; // expired plan has nothing running to pause
  if (!confirm(`Freeze ${member.name}'s membership? Their expiry date won't move while paused, and they won't be able to check in until you resume it.`)) return;

  const originalLabel = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; }
  try {
    await membersCol.doc(member.id).update({
      isFrozen: true,
      freezeStartDate: toDateKey(new Date()),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error(err);
    alert("Could not freeze membership. Please try again.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
  }
}

async function executeResumeMember(member, btn) {
  if (!member.isFrozen) return;

  const today = toDateKey(new Date());
  const frozenDays = Math.max(0, daysBetweenKeys(member.freezeStartDate || today, today));
  const newExpiry = addDaysToDateKey(member.expiryDate, frozenDays);

  if (!confirm(`Resume ${member.name}'s membership? They were paused for ${frozenDays} day${frozenDays === 1 ? "" : "s"} — their new expiry will be ${formatDate(newExpiry)}.`)) return;

  const originalLabel = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; }
  try {
    await membersCol.doc(member.id).update({
      isFrozen: false,
      freezeStartDate: firebase.firestore.FieldValue.delete(),
      expiryDate: newExpiry,
      totalFrozenDays: (member.totalFrozenDays || 0) + frozenDays,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error(err);
    alert("Could not resume membership. Please try again.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
  }
}

// ==================== CANCEL & REFUND (mid-plan cancellation) ====================
// Prorates the refund off the member's current plan price by days
// remaining in the cycle vs. the plan's total length, logs it to the
// `refunds` collection for accountability, and ends the membership today
// (expiryDate = today) so the member table reflects it as EXPIRED right
// away. The admin can always override the suggested amount before
// confirming — the math is a starting point, not a rule.

function computeSuggestedRefund(member) {
  const plan = PLANS[member.plan] || {};
  const price = plan.price || 0;
  const totalDays = plan.days || Math.round((plan.months || 1) * 30);
  const daysRemaining = Math.max(0, Math.min(totalDays, daysUntil(member.expiryDate)));
  const amount = totalDays > 0 ? Math.round((price * daysRemaining) / totalDays) : 0;
  return { plan, price, totalDays, daysRemaining, amount };
}

function openRefundModal(member) {
  pendingRefundMember = member;
  const { plan, price, daysRemaining, amount } = computeSuggestedRefund(member);

  document.getElementById("refundMemberName").textContent = member.name;
  document.getElementById("refundPlanLabel").textContent = plan.label || member.plan;
  document.getElementById("refundPlanPrice").textContent = formatCurrency(price);
  document.getElementById("refundDaysRemaining").textContent = `${daysRemaining} day${daysRemaining === 1 ? "" : "s"}`;
  document.getElementById("refundAmountInput").value = amount;
  document.getElementById("refundReasonInput").value = "";
  document.getElementById("refundError").classList.add("hidden");
  document.getElementById("refundModal").classList.remove("hidden");
}

function closeRefundModal() {
  document.getElementById("refundModal").classList.add("hidden");
  pendingRefundMember = null;
}

async function handleRefundSubmit(e) {
  e.preventDefault();
  if (!pendingRefundMember) return;
  const member = pendingRefundMember;
  const submitBtn = document.getElementById("refundSubmitBtn");
  const errorEl = document.getElementById("refundError");
  errorEl.classList.add("hidden");

  const amount = Number(document.getElementById("refundAmountInput").value);
  const reason = document.getElementById("refundReasonInput").value.trim();

  if (!Number.isFinite(amount) || amount < 0) {
    errorEl.textContent = "Please enter a valid refund amount.";
    errorEl.classList.remove("hidden");
    return;
  }

  // Sensitive action (money going back out, membership ends immediately,
  // irreversible) — same passkey/password re-verification gate as Mark as
  // Paid / Delete / Change Phone Number before the refund actually posts.
  closeRefundModal();
  requestReauth("refund", member, null, { amount, reason });
}

/** Runs the actual refund write — only called after requestReauth("refund", …) succeeds. */
async function executeRefundMigration(member, amount, reason) {
  const { plan, daysRemaining } = computeSuggestedRefund(member);
  try {
    const today = toDateKey(new Date());
    await refundsCol.add({
      memberId: member.id,
      name: member.name,
      phone: member.phone,
      plan: member.plan,
      planPrice: plan.price || 0,
      daysRemaining,
      amount,
      reason,
      dateKey: today,
      processedBy: auth.currentUser ? auth.currentUser.email : null,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    });

    // Ends the membership immediately — expiry is cut to today, so the
    // member table shows EXPIRED right away instead of counting down the
    // days that were just refunded.
    await membersCol.doc(member.id).update({
      expiryDate: today,
      cancelledAt: today,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error(err);
    alert("Could not process refund. Please try again.");
  }
}

// ==================== CHANGE PHONE NUMBER ====================
// The member's phone number IS the Firestore doc ID (members/{phone}), so
// "changing" it means migrating to a brand-new doc at the new phone, then
// deleting the old one — plain field updates can't rename a doc ID.
// Check-in history is migrated too: firestore.rules forces every new
// checkin's `timestamp` to equal `request.time` (server time), so the
// exact original check-in time can't be preserved on the re-created docs
// — but the `dateKey` (the field that actually matters for the "last 7
// days" history and the deterministic doc ID the kiosk looks up) is kept
// exactly as it was, so history stays continuous under the new number.

function openPhoneChangeModal(member) {
  pendingPhoneChangeMember = member;
  document.getElementById("phoneChangeCurrentPhone").textContent = `+${GYM_SETTINGS.defaultCountryCode} ${member.phone}`;
  document.getElementById("phoneChangeNewInput").value = "";
  document.getElementById("phoneChangeError").classList.add("hidden");
  document.getElementById("phoneChangeModal").classList.remove("hidden");
  setTimeout(() => document.getElementById("phoneChangeNewInput").focus(), 50);
}

function closePhoneChangeModal() {
  document.getElementById("phoneChangeModal").classList.add("hidden");
  pendingPhoneChangeMember = null;
}

function showPhoneChangeError(message) {
  const errorEl = document.getElementById("phoneChangeError");
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

// Fields allowed in a member doc's `create` shape (firestore.rules
// hasValidMemberShape) — the new doc's first `.set()` must contain only
// these, everything else (dues, freeze state, counters…) is copied over
// afterwards in a follow-up `.update()`, which admins aren't restricted on.
const MEMBER_BASE_SHAPE_KEYS = [
  "name", "phone", "address", "joinDate", "plan", "expiryDate",
  "paymentStatus", "approved", "createdAt", "updatedAt",
  "whatsappBotOptIn", "whatsappMarketingOptIn",
];

async function handlePhoneChangeSubmit(e) {
  e.preventDefault();
  if (!pendingPhoneChangeMember) return;
  const member = pendingPhoneChangeMember;
  const submitBtn = document.getElementById("phoneChangeSubmitBtn");
  document.getElementById("phoneChangeError").classList.add("hidden");

  const oldPhone = member.id;
  const newPhone = normalizePhone(document.getElementById("phoneChangeNewInput").value);

  if (!/^[0-9]{7,15}$/.test(newPhone)) {
    showPhoneChangeError("Enter a valid phone number (7–15 digits).");
    return;
  }
  if (newPhone === oldPhone) {
    showPhoneChangeError("That's already their current number.");
    return;
  }

  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Checking…";

  try {
    // Sanity-check up front (cheap reads, no writes yet) so the admin
    // doesn't go through passkey/password verification only to hit an
    // avoidable "already exists" error afterwards.
    const existing = await membersCol.doc(newPhone).get();
    if (existing.exists) {
      showPhoneChangeError("A member with this phone number already exists.");
      return;
    }
    const oldSnap = await membersCol.doc(oldPhone).get();
    if (!oldSnap.exists) {
      showPhoneChangeError("This member's record could not be found. Please refresh and try again.");
      return;
    }

    // Sensitive action (rewrites the member's identity/history under a new
    // doc ID) — same passkey/password re-verification gate as Mark as
    // Paid / Delete before the actual migration runs.
    closePhoneChangeModal();
    requestReauth("phone-change", member, null, { newPhone });
  } catch (err) {
    console.error(err);
    showPhoneChangeError("Could not verify phone number. Please try again.");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
}

/** Runs the actual doc migration — only called after requestReauth("phone-change", …) succeeds. */
async function executePhoneChangeMigration(member, newPhone, btn) {
  const oldPhone = member.id;
  try {
    const newDocRef = membersCol.doc(newPhone);
    const oldSnap = await membersCol.doc(oldPhone).get();
    if (!oldSnap.exists) {
      alert("This member's record could not be found. Please refresh and try again.");
      return;
    }
    const oldData = oldSnap.data();

    // 1) Create the new doc with just the base shape the create rule
    //    requires, `phone` swapped to the new number.
    const baseData = {};
    for (const key of MEMBER_BASE_SHAPE_KEYS) {
      if (key === "phone") { baseData.phone = newPhone; continue; }
      if (key in oldData) baseData[key] = oldData[key];
    }
    baseData.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    await newDocRef.set(baseData);

    // 2) Migrate check-in history BEFORE copying extra fields like
    //    isFrozen onto the new doc — the checkins create rule refuses a
    //    new check-in doc for a frozen member, and at this point the new
    //    doc only has the base shape (no isFrozen yet), so migrating a
    //    paused member's history still goes through. Re-created under the
    //    new deterministic ID (`${newPhone}_${dateKey}`) so the kiosk's
    //    history lookup keeps working, then old docs are deleted. Batched
    //    in chunks to stay well under Firestore's 500-writes-per-batch limit.
    const oldCheckins = await checkinsCol.where("memberId", "==", oldPhone).get();
    const CHUNK_SIZE = 200; // 200 creates + 200 deletes = 400 ops/batch
    const docs = oldCheckins.docs;
    for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
      const batch = db.batch();
      const chunk = docs.slice(i, i + CHUNK_SIZE);
      chunk.forEach((doc) => {
        const data = doc.data();
        const newCheckinRef = checkinsCol.doc(`${newPhone}_${data.dateKey}`);
        batch.set(newCheckinRef, {
          memberId: newPhone,
          name: data.name || member.name,
          phone: newPhone,
          dateKey: data.dateKey,
          method: data.method === "geofenced-gps" ? "geofenced-gps" : "manual",
          timestamp: firebase.firestore.FieldValue.serverTimestamp(),
          loggedBy: data.loggedBy || null,
          migratedFromPhone: oldPhone,
        });
        batch.delete(doc.ref);
      });
      await batch.commit();
    }

    // 3) Now copy over everything else (dues, freeze state, check-in
    //    counters…) — an admin update has no field restriction, unlike
    //    create, so this can carry any extra fields the old doc had.
    const extraData = {};
    for (const key of Object.keys(oldData)) {
      if (MEMBER_BASE_SHAPE_KEYS.includes(key)) continue;
      extraData[key] = oldData[key];
    }
    extraData.migratedFromPhone = oldPhone;
    extraData.phoneChangedAt = firebase.firestore.FieldValue.serverTimestamp();
    if (Object.keys(extraData).length > 0) {
      await newDocRef.update(extraData);
    }

    // 4) Finally, drop the old member doc now that everything's migrated.
    await membersCol.doc(oldPhone).delete();
  } catch (err) {
    console.error(err);
    alert("Could not change phone number. Please try again.");
  }
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
  const isDays = plan.days != null;
  row.querySelector('[data-field="label"]').value = plan.label || "";
  row.querySelector('[data-field="duration"]').value = isDays ? plan.days : (plan.months || 1);
  row.querySelector('[data-field="durationUnit"]').value = isDays ? "days" : "months";
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

// ----------------------------------------------------------------- staff --
// Owner-only. `allStaff` is only ever populated for an owner login (see
// subscribeStaffList's guard in showDashboard) — a staff account never
// requests or receives this list, both because the UI is hidden for them
// (applyRolePermissions) and because firestore.rules only grants `list` on
// /admins to isOwnerAdmin().
let allStaff = [];
let unsubStaff = null;

function subscribeStaffList() {
  unsubStaff = db.collection("admins")
    .where("role", "==", "staff")
    .onSnapshot(
      (snap) => {
        allStaff = snap.docs.map((d) => ({ email: d.id, ...d.data() }));
        renderStaffList();
      },
      (err) => console.error("staff listener error:", err)
    );
}

function renderStaffList() {
  const container = document.getElementById("staffListRows");
  const emptyState = document.getElementById("staffListEmptyState");
  if (!container) return;

  container.innerHTML = "";
  emptyState.classList.toggle("hidden", allStaff.length > 0);

  const template = document.getElementById("staffRowTemplate");
  allStaff
    .slice()
    .sort((a, b) => a.email.localeCompare(b.email))
    .forEach((staff) => {
      const row = template.content.cloneNode(true).querySelector(".staff-row");
      row.dataset.email = staff.email;
      row.querySelector('[data-field="email"]').textContent = staff.email;
      container.appendChild(row);
    });
}

function openStaffAccessModal() {
  document.getElementById("staffEmailInput").value = "";
  document.getElementById("staffAccessError").classList.add("hidden");
  renderStaffList();
  document.getElementById("staffAccessModal").classList.remove("hidden");
}

function closeStaffAccessModal() {
  document.getElementById("staffAccessModal").classList.add("hidden");
}

function handleAddStaffSubmit(e) {
  e.preventDefault();
  const errorEl = document.getElementById("staffAccessError");
  errorEl.classList.add("hidden");

  const email = document.getElementById("staffEmailInput").value.trim().toLowerCase();
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailPattern.test(email)) {
    errorEl.textContent = "Enter a valid email address.";
    errorEl.classList.remove("hidden");
    return;
  }
  if (!email.endsWith("@gmail.com")) {
    errorEl.textContent = "Staff sign in with Google — enter a @gmail.com address.";
    errorEl.classList.remove("hidden");
    return;
  }
  if (email === (auth.currentUser && auth.currentUser.email.toLowerCase())) {
    errorEl.textContent = "You're already the owner — enter a different email.";
    errorEl.classList.remove("hidden");
    return;
  }
  if (allStaff.some((s) => s.email === email)) {
    errorEl.textContent = "This email is already a staff member.";
    errorEl.classList.remove("hidden");
    return;
  }

  const btn = document.getElementById("staffAccessAddBtn");
  // Close this modal before the reauth modal opens — both are z-50, and
  // this one comes later in the DOM, so left open it visually stacks on
  // top of (hides) the reauth modal's "Confirm" button underneath it.
  closeStaffAccessModal();
  requestReauth("add-staff", null, btn, { email });
}

async function executeAddStaff(email, btn) {
  const originalLabel = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Adding…";
  }
  try {
    // .create() semantics come from firestore.rules (`allow create` only —
    // no update/delete on this path), so this can never silently overwrite
    // an existing admin's role even if called twice.
    await db.collection("admins").doc(email).set({
      role: "staff",
      addedBy: auth.currentUser.email,
      addedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    document.getElementById("staffEmailInput").value = "";
  } catch (err) {
    console.error(err);
    const errorEl = document.getElementById("staffAccessError");
    errorEl.textContent = err.code === "permission-denied"
      ? "That email is already registered as an admin."
      : "Could not add staff member. Please try again.";
    errorEl.classList.remove("hidden");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel || "Add Staff";
    }
  }
}

async function executeRemoveStaff(email, btn) {
  const originalLabel = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Removing…";
  }
  try {
    await db.collection("admins").doc(email).delete();
  } catch (err) {
    console.error(err);
    alert("Could not remove staff member. Please try again.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel || "Remove";
    }
  }
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
    const duration = Number(row.querySelector('[data-field="duration"]').value);
    const unit = row.querySelector('[data-field="durationUnit"]').value;
    const price = Number(row.querySelector('[data-field="price"]').value);
    if (!label || !duration || duration < 1 || price < 0) {
      errorEl.textContent = "Every plan needs a label, a valid duration, and a valid price.";
      errorEl.classList.remove("hidden");
      return;
    }
    // Stored shape stays { label, months, price } or { label, days, price }
    // — addMemberSubmit/member.js self-registration already branch on
    // plan.days vs plan.months when computing expiryDate.
    plans[id] = unit === "days"
      ? { label, days: duration, price }
      : { label, months: duration, price };
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

/** Runs the actual sensitive action once verification (fresh or grace-window) has passed. */
async function dispatchReauthedAction({ type, member, btn, extra }) {
  if (type === "delete") {
    await executeDeleteMember(member, btn);
  } else if (type === "mark-paid") {
    await executeMarkAsPaid(member, btn);
  } else if (type === "phone-change") {
    await executePhoneChangeMigration(member, extra.newPhone, btn);
  } else if (type === "refund") {
    await executeRefundMigration(member, extra.amount, extra.reason);
  } else if (type === "add-staff") {
    await executeAddStaff(extra.email, btn);
  } else if (type === "remove-staff") {
    await executeRemoveStaff(extra.email, btn);
  }
}

function requestReauth(type, member, btn, extra) {
  const user = auth.currentUser;
  if (!user) return;

  const action = { type, member, btn, extra: extra || null };

  // Grace window: skip re-verifying if the admin already confirmed their
  // identity for a different sensitive action within the last few minutes.
  if (Date.now() - lastVerifiedAt < REAUTH_GRACE_MS) {
    dispatchReauthedAction(action);
    return;
  }

  pendingReauthAction = action;
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
  } else if (type === "phone-change") {
    titleEl.textContent = "Confirm phone number change?";
    msgEl.textContent = `This moves ${member.name}'s record (plan, dues, check-in history) from +${GYM_SETTINGS.defaultCountryCode} ${member.phone} to +${GYM_SETTINGS.defaultCountryCode} ${extra.newPhone}. Confirm your identity to continue.`;
  } else if (type === "refund") {
    titleEl.textContent = "Confirm refund?";
    msgEl.textContent = `This refunds ${formatCurrency(extra.amount)} to ${member.name} and ends their membership immediately. Confirm your identity to continue.`;
  } else if (type === "add-staff") {
    titleEl.textContent = "Grant staff access?";
    msgEl.textContent = `This gives ${extra.email} sign-in access to this dashboard (check-in/approve only). Confirm your identity to continue.`;
  } else if (type === "remove-staff") {
    titleEl.textContent = "Revoke staff access?";
    msgEl.textContent = `${extra.email} will immediately lose access to this dashboard. Confirm your identity to continue.`;
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

    // Security check passed successfully! Start the grace window, then
    // execute the action.
    lastVerifiedAt = Date.now();
    const completedAction = pendingReauthAction;
    closeReauthModal();
    await dispatchReauthedAction(completedAction);
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

  const headers = ["Name", "Phone", "Address", "Plan", "Join Date", "Expiry Date", "Days Remaining", "Payment Status", "Dues Owed", "Approved", "Monthly Check-ins"];

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
    m.duesAmount || 0,
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

  // 🔥 Total dues — credit pe renew kiye gaye members ka accumulated owed amount
  const totalDues = allMembers.reduce((sum, m) => sum + (m.duesAmount || 0), 0);

  document.getElementById("statActive").textContent = active;
  document.getElementById("statPending").textContent = pending;
  document.getElementById("statTotal").textContent = allMembers.length;
  const pendingApprovalEl = document.getElementById("statPendingApproval");
  if (pendingApprovalEl) pendingApprovalEl.textContent = pendingApproval;
  const duesEl = document.getElementById("statDuesSub");
  if (duesEl) duesEl.textContent = totalDues > 0 ? `${formatCurrency(totalDues)} in dues` : "";
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

  const entries = Object.values(daysMap);
  const labels = entries.map((d) => d.label);
  const dataValues = entries.map((d) => d.count);
  const todayIndex = entries.length - 1; // last bucket is always today

  if (checkinsChartInstance) {
    checkinsChartInstance.destroy();
  }

  const canvasCtx = ctx.getContext("2d");
  // Soft vertical gradient (accent → a lighter tint of it) instead of a
  // flat fill — reads as a lot more polished on a stats-card chart than a
  // single solid colour.
  const barGradient = canvasCtx.createLinearGradient(0, 0, 0, ctx.clientHeight || 140);
  barGradient.addColorStop(0, "#0284C7");
  barGradient.addColorStop(1, "#7DD3FC");
  const barGradientHover = canvasCtx.createLinearGradient(0, 0, 0, ctx.clientHeight || 140);
  barGradientHover.addColorStop(0, "#0369A1");
  barGradientHover.addColorStop(1, "#38BDF8");

  checkinsChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Check-ins",
        data: dataValues,
        backgroundColor: dataValues.map((_, i) => (i === todayIndex ? barGradientHover : barGradient)),
        hoverBackgroundColor: barGradientHover,
        borderRadius: { topLeft: 6, topRight: 6, bottomLeft: 0, bottomRight: 0 },
        borderSkipped: false,
        maxBarThickness: 22,
        categoryPercentage: 0.6,
        barPercentage: 0.9,
      }],
    },
    plugins: [ChartDataLabels],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500, easing: "easeOutQuart" },
      layout: { padding: { top: 18 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          backgroundColor: "#0F172A",
          titleColor: "#94A3B8",
          bodyColor: "#F8FAFC",
          bodyFont: { weight: "600" },
          padding: 10,
          cornerRadius: 8,
          displayColors: false,
          callbacks: {
            title: (items) => items[0].label,
            label: (item) => `${item.parsed.y} check-in${item.parsed.y === 1 ? "" : "s"}`,
          },
        },
        // Shows the count directly above each bar — only when > 0, so a
        // quiet week doesn't get cluttered with a row of "0"s.
        datalabels: {
          anchor: "end",
          align: "top",
          offset: 4,
          color: "#64748B",
          font: { size: 10, weight: "700" },
          formatter: (value) => (value > 0 ? value : ""),
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: {
            color: (context) => (context.index === todayIndex ? "#0284C7" : "#94A3B8"),
            font: (context) => ({
              size: 11,
              weight: context.index === todayIndex ? "700" : "500",
            }),
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(148, 163, 184, 0.15)", drawTicks: false },
          border: { display: false },
          ticks: { color: "#94A3B8", font: { size: 10 }, stepSize: 1, precision: 0 },
        },
      },
    },
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