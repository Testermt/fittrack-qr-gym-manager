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

async function isVerifiedAdmin(email, retries = 5) {
  if (!email) return false;
  const docId = email.trim().toLowerCase();
  
  // 🔥 Ensure Firebase Auth token is fully ready and synced with Firestore
  const currentUser = auth.currentUser;
  if (currentUser) {
    try {
      await currentUser.getIdToken(true); // Force token refresh & sync
    } catch (e) {
      console.warn("Token sync warning:", e);
    }
  }

  for (let i = 0; i < retries; i++) {
    try {
      const doc = await db.collection("admins").doc(docId).get();
      if (doc.exists) return true;
      
      // Agar document nahi mila, toh 1 second wait karke retry karein
      if (i < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      return false;
    } catch (err) {
      console.warn(`Admin verification attempt ${i + 1} failed:`, err.code || err.message);
      if (i === retries - 1) return false;
      // Clean retry delay without any broken syntax
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return false;
}






const SCREENS = ["loginScreen", "deviceVerifyScreen", "biometricSetupScreen", "dashboardScreen"];

function showScreen(idToShow) {
  SCREENS.forEach((id) => {
    document.getElementById(id).classList.toggle("hidden", id !== idToShow);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("gymNameLabelAdmin").textContent = GYM_SETTINGS.name;

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


async function handleAuthenticatedUser(user) {
  const signedInWithGoogle = user.providerData.some((p) => p.providerId === "google.com");

  if (signedInWithGoogle) {
    showScreen("deviceVerifyScreen");
    setDeviceVerifyStage("checkingAdmin");

    let isAdmin = false;
    try {
      // 🔥 FIX: Ensure auth token is fully synced with Firestore before querying
      await user.getIdToken(true);
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
  if (unsubMembers) unsubMembers();
  if (unsubCheckins) unsubCheckins();
  if (unsubPayments) unsubPayments();
  closeReauthModal();
}


function showDashboard(user) {
  showScreen("dashboardScreen");
  document.getElementById("adminEmailLabel").textContent = user.email;
  updateDeviceLockToggle(user);

  subscribeMembers();
  subscribeWeeklyAndTodayCheckins(); // <-- Yeh dono cheezein ek sath handle karega (Chart + Today's List)
  subscribeMonthlyRevenue();
  subscribeMonthlyHistory();
}

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
    const confirmed = confirm("Remove the device lock from this browser?");
    if (confirmed) {
      clearStoredCredentialId(user.uid);
      updateDeviceLockToggle(user);
    }
    return;
  }
  showScreen("biometricSetupScreen");
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
    },
    (err) => console.error("members listener error:", err)
  );
}


function renderMemberTable() {
  const query = document.getElementById("memberSearch").value.trim().toLowerCase();
  const tbody = document.getElementById("memberTableBody");
  const emptyState = document.getElementById("memberEmptyState");

  const filtered = allMembers.filter((m) => {
    if (query && !(m.name.toLowerCase().includes(query) || m.phone.includes(query))) return false;
    if (currentMemberFilter === "active" && daysUntil(m.expiryDate) < 0) return false;
    if (currentMemberFilter === "pending" && m.paymentStatus === "paid") return false;
    // 🔥 Pending approval filter check
    if (currentMemberFilter === "pending-approval" && m.approved === true) return false;
    return true;
  });

  tbody.innerHTML = "";
  emptyState.classList.toggle("hidden", filtered.length > 0);

  filtered.forEach((m) => {
    const days = daysUntil(m.expiryDate);
    const isActive = days >= 0;
    const plan = PLANS[m.plan] || { label: m.plan };
    const isPaid = m.paymentStatus === "paid";
    const isApproved = m.approved === true;
    const alreadyCheckedIn = todayCheckedInIds.has(m.id);

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
        <!-- 🔥 Approval Status Badge -->
        <span class="badge mt-1 ${isApproved ? "badge-success" : "badge-warning"}">${isApproved ? "APPROVED" : "PENDING"}</span>
      </td>
      <td class="py-3 pr-0">
        <div class="flex flex-wrap gap-2 justify-end">
          <!-- 🔥 Approve Button (Sirf tab dikhega jab user approved na ho) -->
          ${!isApproved ? `<button data-action="approve" data-id="${m.id}" class="text-xs font-semibold rounded-md bg-amber-500/15 text-amber-400 px-3 py-1.5 hover:bg-amber-500/25 transition">Approve</button>` : ""}

          <button data-action="check-in" data-id="${m.id}" ${alreadyCheckedIn ? "disabled" : ""}
            class="text-xs font-semibold rounded-md px-3 py-1.5 transition ${
              alreadyCheckedIn ? "bg-slate-800 text-slate-500 cursor-not-allowed" : "bg-accent/15 text-accent hover:bg-accent/25"
            }">${alreadyCheckedIn ? "✓ Checked In" : "Check-In"}</button>
          
          ${!isPaid ? `<button data-action="mark-paid" data-id="${m.id}" class="text-xs font-semibold rounded-md bg-success/15 text-success px-3 py-1.5 hover:bg-success/25 transition">Mark as Paid</button>` : ""}
          ${(!isActive || !isPaid) ? `<button data-action="whatsapp" data-id="${m.id}" class="text-xs font-semibold rounded-md bg-emerald-500/15 text-emerald-400 px-3 py-1.5 hover:bg-emerald-500/25 transition">Send WhatsApp</button>` : ""}
          
          <button data-action="delete" data-id="${m.id}" class="text-xs font-semibold rounded-md bg-rose-500/15 text-rose-400 px-3 py-1.5 hover:bg-rose-500/25 transition">Delete</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}


function updateMemberFilterStyles() {
  document.querySelectorAll(".member-filter-btn").forEach((btn) => {
    const active = btn.dataset.filter === currentMemberFilter;
    btn.classList.toggle("bg-accent", active);
    btn.classList.toggle("text-slate-950", active);
    btn.classList.toggle("bg-slate-800", !active);
    btn.classList.toggle("text-slate-400", !active);
  });
}

document.getElementById("memberTableBody").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn || btn.disabled) return;
  const member = allMembers.find((m) => m.id === btn.dataset.id);
  if (!member) return;

  if (btn.dataset.action === "approve") executeApproveMember(member, btn); // 🔥 Yeh line add karni hai
  if (btn.dataset.action === "check-in") manualCheckIn(member, btn);
  if (btn.dataset.action === "mark-paid") requestReauth("mark-paid", member, btn);
  if (btn.dataset.action === "whatsapp") sendWhatsAppReminder(member);
  if (btn.dataset.action === "delete") requestReauth("delete", member, btn);
});

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
  } catch (err) {
    console.error(err);
    alert("Could not log check-in. Please try again.");
    btn.disabled = false;
    btn.textContent = originalLabel;
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
  
  const pending = allMembers.filter((m) => m.paymentStatus !== "paid").length;
  document.getElementById("statActive").textContent = active;
  document.getElementById("statPending").textContent = pending;
  document.getElementById("statTotal").textContent = allMembers.length;
}


function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

let unsubAllPayments = null;

// Isko subscribeDashboardHistory ya subscribeMembers ke sath call kar lena dashboard load hone par
function subscribeMonthlyHistory() {
  unsubAllPayments = paymentsCol.orderBy("timestamp", "desc").onSnapshot(
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