// FitTrack QR Gym Manager — Admin Dashboard logic (admin.html)

const membersCol = db.collection("members");
const checkinsCol = db.collection("checkins");
const paymentsCol = db.collection("payments");

let allMembers = [];
let unsubMembers = null;
let unsubCheckins = null;
let unsubPayments = null;

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("gymNameLabelAdmin").textContent = GYM_SETTINGS.name;

  document.getElementById("loginForm").addEventListener("submit", handleLogin);
  document.getElementById("googleSignInBtn").addEventListener("click", handleGoogleSignIn);
  document.getElementById("forgotPasswordBtn").addEventListener("click", handleForgotPassword);
  document.getElementById("logoutBtn").addEventListener("click", () => auth.signOut());
  document.getElementById("memberSearch").addEventListener("input", renderMemberTable);

  auth.onAuthStateChanged((user) => {
    if (user) {
      showDashboard(user);
    } else {
      showLogin();
    }
  });
});

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
    await auth.signInWithPopup(provider);
    // auth.onAuthStateChanged (registered on load) takes it from here and
    // swaps in the dashboard once Firebase confirms the signed-in user.
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
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("dashboardScreen").classList.add("hidden");
  if (unsubMembers) unsubMembers();
  if (unsubCheckins) unsubCheckins();
  if (unsubPayments) unsubPayments();
}

function showDashboard(user) {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("dashboardScreen").classList.remove("hidden");
  document.getElementById("adminEmailLabel").textContent = user.email;

  subscribeMembers();
  subscribeTodayCheckins();
  subscribeMonthlyRevenue();
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
