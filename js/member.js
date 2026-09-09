// FitTrack QR Gym Manager — Member Portal logic (index.html)

const membersCol = db.collection("members");
const checkinsCol = db.collection("checkins");
const paymentsCol = db.collection("payments");

// ---------------------------------------------------------------- setup --
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("gymNameLabel").textContent = GYM_SETTINGS.name;
  document.getElementById("joinDate").value = toDateKey(new Date());
  buildPlanPicker("planPicker", "plan");
  initTabs();

  document.getElementById("registerForm").addEventListener("submit", handleRegisterSubmit);
  document.getElementById("statusForm").addEventListener("submit", handleStatusCheck);
  document.getElementById("closeModalBtn").addEventListener("click", closeModal);
  document.getElementById("confirmPaymentBtn").addEventListener("click", confirmMockPayment);
});

function initTabs() {
  const tabs = document.querySelectorAll("[data-tab-target]");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("tab-active"));
      tab.classList.add("tab-active");
      document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
        panel.classList.toggle("hidden", panel.dataset.tabPanel !== tab.dataset.tabTarget);
      });
    });
  });
}

/** Renders a row of selectable plan cards into a container, wiring up a hidden input. */
function buildPlanPicker(containerId, hiddenInputName) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  Object.entries(PLANS).forEach(([id, plan], idx) => {
    const card = document.createElement("label");
    card.className =
      "plan-card cursor-pointer rounded-xl border border-slate-700 bg-slate-800/60 p-4 flex flex-col gap-1 transition hover:border-sky-500";
    card.innerHTML = `
      <input type="radio" name="${hiddenInputName}" value="${id}" class="sr-only peer" ${idx === 0 ? "checked" : ""} required />
      <span class="text-sm text-slate-400">${plan.label}</span>
      <span class="text-xl font-semibold text-slate-50">${formatCurrency(plan.price)}</span>
    `;
    container.appendChild(card);
  });
}

// -------------------------------------------------------------- helpers --
function setBusy(buttonEl, busy, busyLabel) {
  if (!buttonEl) return;
  buttonEl.disabled = busy;
  buttonEl.dataset.originalLabel = buttonEl.dataset.originalLabel || buttonEl.textContent;
  buttonEl.textContent = busy ? busyLabel : buttonEl.dataset.originalLabel;
  buttonEl.classList.toggle("opacity-60", busy);
}

function showBanner(elId, message, kind = "error") {
  const el = document.getElementById(elId);
  el.textContent = message;
  el.classList.remove("hidden", "text-rose-400", "text-emerald-400");
  el.classList.add(kind === "error" ? "text-rose-400" : "text-emerald-400");
}

function hideBanner(elId) {
  document.getElementById(elId).classList.add("hidden");
}

/** Logs a check-in for today, but only once per member per day. */
async function logCheckinIfNeeded(memberId, name, phone) {
  const today = toDateKey(new Date());
  const existing = await checkinsCol
    .where("memberId", "==", memberId)
    .where("dateKey", "==", today)
    .limit(1)
    .get();
  if (!existing.empty) return false;
  await checkinsCol.add({
    memberId,
    name,
    phone,
    dateKey: today,
    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
  });
  return true;
}

// ------------------------------------------------------------ register --
async function handleRegisterSubmit(e) {
  e.preventDefault();
  hideBanner("registerBanner");
  const form = e.target;
  const submitBtn = form.querySelector("button[type=submit]");

  const name = form.name.value.trim();
  const phoneRaw = form.phone.value.trim();
  const phone = normalizePhone(phoneRaw);
  const joinDate = form.joinDate.value;
  const planId = form.plan.value;

  if (!name || phone.length < 7 || !joinDate || !planId) {
    showBanner("registerBanner", "Please fill every field with a valid phone number.");
    return;
  }

  setBusy(submitBtn, true, "Registering…");
  try {
    const existingDoc = await membersCol.doc(phone).get();
    if (existingDoc.exists) {
      showBanner(
        "registerBanner",
        "This phone number is already registered. Use the 'Check Status' tab instead."
      );
      return;
    }

    const plan = PLANS[planId];
    const expiryDate = addMonthsToDateKey(joinDate, plan.months);

    await membersCol.doc(phone).set({
      name,
      phone,
      joinDate,
      plan: planId,
      expiryDate,
      paymentStatus: "pending",
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    await logCheckinIfNeeded(phone, name, phone);

    form.reset();
    document.getElementById("joinDate").value = toDateKey(new Date());
    buildPlanPicker("planPicker", "plan");

    showBanner(
      "registerBanner",
      `Welcome, ${name}! You're registered on the ${plan.label} plan (expires ${formatDate(expiryDate)}). Please pay at the front desk or via the Check Status tab.`,
      "success"
    );
  } catch (err) {
    console.error(err);
    showBanner("registerBanner", "Something went wrong. Please try again or ask staff for help.");
  } finally {
    setBusy(submitBtn, false);
  }
}

// --------------------------------------------------------- status check --
let currentMember = null;

async function handleStatusCheck(e) {
  e.preventDefault();
  hideBanner("statusBanner");
  document.getElementById("statusCard").classList.add("hidden");

  const form = e.target;
  const submitBtn = form.querySelector("button[type=submit]");
  const phone = normalizePhone(form.phone.value.trim());

  if (phone.length < 7) {
    showBanner("statusBanner", "Enter a valid mobile number.");
    return;
  }

  setBusy(submitBtn, true, "Checking…");
  try {
    const doc = await membersCol.doc(phone).get();
    if (!doc.exists) {
      showBanner(
        "statusBanner",
        "No membership found for this number. Switch to the 'New Member' tab to register."
      );
      return;
    }
    currentMember = { id: doc.id, ...doc.data() };
    const justCheckedIn = await logCheckinIfNeeded(currentMember.id, currentMember.name, currentMember.phone);
    renderStatusCard(currentMember, justCheckedIn);
  } catch (err) {
    console.error(err);
    showBanner("statusBanner", "Something went wrong. Please try again.");
  } finally {
    setBusy(submitBtn, false);
  }
}

function renderStatusCard(member, justCheckedIn) {
  const days = daysUntil(member.expiryDate);
  const isActive = days >= 0;
  const plan = PLANS[member.plan] || { label: member.plan };

  const card = document.getElementById("statusCard");
  card.classList.remove("hidden");

  document.getElementById("statusName").textContent = member.name;
  document.getElementById("statusPhone").textContent = `+${GYM_SETTINGS.defaultCountryCode} ${member.phone}`;
  document.getElementById("statusPlan").textContent = plan.label;
  document.getElementById("statusJoin").textContent = formatDate(member.joinDate);
  document.getElementById("statusExpiry").textContent = formatDate(member.expiryDate);

  const badge = document.getElementById("statusBadge");
  badge.textContent = isActive ? "ACTIVE" : "EXPIRED";
  badge.className = `badge ${isActive ? "badge-success" : "badge-danger"}`;

  const daysLabel = document.getElementById("statusDays");
  daysLabel.textContent = isActive
    ? `${days} day${days === 1 ? "" : "s"} left`
    : `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`;

  const payBadge = document.getElementById("statusPayBadge");
  payBadge.textContent = member.paymentStatus === "paid" ? "PAID" : "PAYMENT PENDING";
  payBadge.className = `badge ${member.paymentStatus === "paid" ? "badge-success" : "badge-warning"}`;

  const checkinNote = document.getElementById("checkinNote");
  checkinNote.textContent = justCheckedIn
    ? "✓ Checked in for today. Have a great workout!"
    : "You've already checked in today.";

  const renewSection = document.getElementById("renewSection");
  renewSection.classList.toggle("hidden", isActive && member.paymentStatus === "paid");
  if (!renewSection.classList.contains("hidden")) {
    buildPlanPicker("renewPlanPicker", "renewPlan");
  }
}

document.getElementById("renewButton")?.addEventListener("click", () => {
  const planId = document.querySelector("input[name=renewPlan]:checked")?.value;
  if (!planId) return;
  openPaymentModal(planId);
});

// -------------------------------------------------------- mock payment --
let pendingPaymentPlanId = null;

function openPaymentModal(planId) {
  pendingPaymentPlanId = planId;
  const plan = PLANS[planId];
  document.getElementById("modalPlanLabel").textContent = plan.label;
  document.getElementById("modalPlanPrice").textContent = formatCurrency(plan.price);
  document.getElementById("paymentModal").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("paymentModal").classList.add("hidden");
  pendingPaymentPlanId = null;
}

async function confirmMockPayment() {
  if (!currentMember || !pendingPaymentPlanId) return;
  const btn = document.getElementById("confirmPaymentBtn");
  setBusy(btn, true, "Processing…");

  try {
    const plan = PLANS[pendingPaymentPlanId];
    const today = toDateKey(new Date());
    const isCurrentlyActive = daysUntil(currentMember.expiryDate) >= 0 && currentMember.paymentStatus === "paid";
    const base = isCurrentlyActive ? currentMember.expiryDate : today;
    const newExpiry = addMonthsToDateKey(base, plan.months);

    await membersCol.doc(currentMember.id).update({
      plan: pendingPaymentPlanId,
      expiryDate: newExpiry,
      paymentStatus: "paid",
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    await paymentsCol.add({
      memberId: currentMember.id,
      name: currentMember.name,
      phone: currentMember.phone,
      plan: pendingPaymentPlanId,
      amount: plan.price,
      dateKey: today,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    });

    currentMember = { ...currentMember, plan: pendingPaymentPlanId, expiryDate: newExpiry, paymentStatus: "paid" };
    closeModal();
    renderStatusCard(currentMember, false);
    showBanner("statusBanner", `Payment successful! Membership active until ${formatDate(newExpiry)}.`, "success");
  } catch (err) {
    console.error(err);
    alert("Payment simulation failed. Please try again.");
  } finally {
    setBusy(btn, false);
  }
}
