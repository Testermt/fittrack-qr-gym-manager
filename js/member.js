// FitTrack QR Gym Manager — Member Portal logic (index.html)
// Check-in itself now happens ONLY at the front-desk fingerprint kiosk (native
// app) — this page is view-only (register, check plan/history). Geofencing
// code (GYM_LOCATION, calculateDistance, logCheckinIfNeeded, etc.) has been
// removed; it's no longer needed here.


// ==================== VOICE-ASSISTED KIOSK (Web Speech API) ====================
/**
 * Speaks a short message aloud — used so members get audible feedback
 * without needing to read the screen. Cancels any message currently
 * speaking first, so rapid actions don't queue up and talk over each
 * other. No-ops silently on browsers/WebViews without speech synthesis
 * support.
 */
function speakText(message) {
  if (!("speechSynthesis" in window) || !message) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.lang = "en-IN";
    utterance.rate = 1;
    window.speechSynthesis.speak(utterance);
  } catch (err) {
    console.warn("speakText failed:", err);
  }
}






const membersCol = db.collection("members");
const checkinsCol = db.collection("checkins");

// ---------------------------------------------------------------- setup --
document.addEventListener("DOMContentLoaded", async () => {
  // Wait for settings/gymConfig (name, currency, plans) before rendering
  // anything that reads GYM_SETTINGS/PLANS. This resolves quickly from
  // cache/defaults even offline — see loadGymConfig() in firebase-config.js.
  await gymConfigReady;

  document.getElementById("gymNameLabel").textContent = GYM_SETTINGS.name;
  document.getElementById("joinDate").value = toDateKey(new Date());
  buildPlanPicker("planPicker", "plan");
  initTabs();

  document.getElementById("registerForm").addEventListener("submit", handleRegisterSubmit);
  document.getElementById("statusForm").addEventListener("submit", handleStatusCheck);
  document.getElementById("closeModalBtn").addEventListener("click", closeModal);
  document.getElementById("copyUpiIdBtn").addEventListener("click", handleCopyUpiId);
  document.getElementById("closeWelcomeModalBtn").addEventListener("click", closeWelcomeModal);
  document.getElementById("rulesLangToggle").addEventListener("click", toggleRulesLang);
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
      if (tab.dataset.tabTarget === "status") {
        speakText("Welcome to the gym. Please check in.");
      } else if (tab.dataset.tabTarget === "register") {
        speakText("Hey, please enter your details to join the gym.");
      }
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
      <span class="text-sm text-slate-700 font-medium">${plan.label}</span>
      <span class="text-xl font-extrabold text-slate-950">${formatCurrency(plan.price)}</span>
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

/** Gym rules & guidelines in English and Hindi, keyed by language code. */
const RULES_I18N = {
  en: {
    heading: (gymName) => `${gymName} Rules & Guidelines`,
    toggleLabel: "🇮🇳 हिंदी",
    items: [
      { label: "Hygiene", text: "Bring your own towel and wipe down equipment before and after use." },
      { label: "Equipment care", text: "Re-rack weights and return machines to their resting position after every set." },
      { label: "Etiquette", text: "Respect others' space, keep phone calls outside the floor, and share equipment during peak hours." },
      { label: "Timings", text: "Open Monday–Saturday, 6:00 AM – 10:00 PM. Closed on Sundays & public holidays." },
    ],
  },
  hi: {
    heading: (gymName) => `${gymName} के नियम और दिशा-निर्देश`,
    toggleLabel: "🇬🇧 English",
    items: [
      { label: "स्वच्छता", text: "अपना तौलिया साथ लाएं और उपयोग से पहले और बाद में उपकरण को साफ करें।" },
      { label: "उपकरणों की देखभाल", text: "हर सेट के बाद वज़न को वापस रैक में रखें और मशीनों को उनकी मूल स्थिति में लाएं।" },
      { label: "शिष्टाचार", text: "दूसरों की जगह का सम्मान करें, फ़ोन कॉल जिम फ्लोर के बाहर करें, और व्यस्त समय में उपकरण साझा करें।" },
      { label: "समय", text: "सोमवार–शनिवार सुबह 6:00 बजे से रात 10:00 बजे तक खुला। रविवार और सार्वजनिक अवकाश पर बंद।" },
    ],
  },
};

/** Renders the rules list + heading + toggle button label for the given language ("en" | "hi"). */
function renderRulesList(lang) {
  const data = RULES_I18N[lang];
  document.getElementById("welcomeModalRulesTitle").textContent = data.heading(GYM_SETTINGS.name);

  const list = document.getElementById("welcomeModalRulesList");
  list.innerHTML = data.items
    .map(
      (item) => `
        <li class="flex gap-2">
          <span class="text-accent"></span>
          <span>
            <span class="font-semibold text-slate-900">${item.label}:</span> ${item.text}
          </span>
        </li>
      `
    )
    .join("");

  const toggleBtn = document.getElementById("rulesLangToggle");
  toggleBtn.textContent = data.toggleLabel;
  toggleBtn.dataset.lang = lang;
}


/** Switches the rules list between English and Hindi. */
function toggleRulesLang() {
  const current = document.getElementById("rulesLangToggle").dataset.lang || "en";
  renderRulesList(current === "en" ? "hi" : "en");
}

/** Opens the post-registration welcome & gym-rules modal with the new member's details. */
function openWelcomeModal(name, planLabel, expiryDateStr) {
  document.getElementById("welcomeModalTitle").textContent = `Welcome aboard, ${name}! 🎉`;
  document.getElementById("welcomeModalSub").textContent =
    `You're on the ${planLabel} plan — active until ${expiryDateStr}.`;
  renderRulesList("en"); // always open fresh in English
  document.getElementById("welcomeModal").classList.remove("hidden");
}

function closeWelcomeModal() {
  document.getElementById("welcomeModal").classList.add("hidden");
}

// Check-in itself (logCheckinIfNeeded, GPS/geofencing) has been removed from
// this page — it now happens only at the front-desk fingerprint kiosk. This
// page stays view-only: registration, and checking your plan/check-in
// history (loadMemberCheckinHistory below reads the same `checkins`
// collection that the kiosk app writes to).




// ------------------------------------------------------------ register --
// ------------------------------------------------------------ register --
// ------------------------------------------------------------ register --
async function handleRegisterSubmit(e) {
  e.preventDefault();
  hideBanner("registerBanner");
  const form = e.target;
  const submitBtn = form.querySelector("button[type=submit]");

  const name = form.name.value.trim();
  const phoneRaw = form.phone.value.trim();
  const phone = normalizePhone(phoneRaw);
  const address = form.address.value.trim();
  const joinDate = form.joinDate.value;
  const planId = form.plan.value;

  if (!name || phone.length < 7 || !address || !joinDate || !planId) {
    showBanner("registerBanner", "Please fill every field with a valid phone number.");
    speakText("Please fill every field with a valid phone number.");
    return;
  }

  setBusy(submitBtn, true, "Registering");
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

    // Sirf Member Profile Save Hogi (Registration ke waqt koi auto check-in nahi!)
    // Sirf Member Profile Save Hogi (Registration ke waqt default unapproved rahegi)
    await membersCol.doc(phone).set({
      name,
      phone,
      address,
      joinDate,
      plan: planId,
      expiryDate,
      paymentStatus: "pending",
      approved: false, // <-- Naya user default unapproved rahega
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    //  yahan se await logCheckinIfNeeded() ko bilkul hata diya hai!

    form.reset();
    document.getElementById("joinDate").value = toDateKey(new Date());
    buildPlanPicker("planPicker", "plan");
    hideBanner("registerBanner");

    openWelcomeModal(name, plan.label, formatDate(expiryDate));
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
    speakText("Please enter a valid mobile number.");
    return;
  }

  setBusy(submitBtn, true, "Checking");
  try {
    const doc = await membersCol.doc(phone).get();
    if (!doc.exists) {
      showBanner(
        "statusBanner",
        "No membership found for this number. Switch to the 'New Member' tab to register."
      );
      speakText("No membership found for this number. Please switch to the new member tab to register.");
      return;
    }
    
    currentMember = { id: doc.id, ...doc.data() };

    renderStatusCard(currentMember, currentMember.approved !== true ? "pending-approval" : null);
    loadMemberCheckinHistory(currentMember.id);
    
  } catch (err) {
    console.error(err);
    showBanner("statusBanner", "Something went wrong. Please try again.");
  } finally {
    setBusy(submitBtn, false);
  }
}

/** Masks a phone number for display, keeping only the last 3 digits visible (e.g. "•••••0638"). */
function maskPhone(phone) {
  const digits = String(phone || "");
  if (digits.length <= 3) return digits;
  return "•".repeat(digits.length - 3) + digits.slice(-3);
}

function renderStatusCard(member, checkinStatus) {
  const days = daysUntil(member.expiryDate);
  const isActive = days >= 0;
  const plan = PLANS[member.plan] || { label: member.plan };

  const card = document.getElementById("statusCard");
  card.classList.remove("hidden");

  document.getElementById("statusName").textContent = member.name;
  document.getElementById("statusPhone").textContent = `+${GYM_SETTINGS.defaultCountryCode} ${maskPhone(member.phone)}`;
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

  // Approval-state note. Fingerprint/front-desk copy is gone — check-in now
  // happens automatically (right here) the moment an eligible member's
  // status loads — see performAutoCheckin() below.
  const checkinNote = document.getElementById("checkinNote");
  if (checkinStatus === "pending-approval") {
    checkinNote.textContent = "Your registration is pending admin approval.";
    checkinNote.className = "text-sm text-amber-500 font-semibold";
    // Delayed (setTimeout) so this plays AFTER the mascot's automatic
    // "Welcome back!" cheer (which fires async off the statusCard becoming
    // visible) instead of being cut off/overridden by it.
    setTimeout(() => speakText(`${member.name}, your registration is pending admin approval. Please speak to the admin at the front desk.`), 0);
  } else if (!isActive) {
    checkinNote.textContent = "";
    checkinNote.classList.add("hidden");
  } else {
    // Active + approved: attempt the check-in right away, no button tap needed.
    performAutoCheckin(member);
  }

  const renewSection = document.getElementById("renewSection");
  renewSection.classList.toggle("hidden", isActive && member.paymentStatus === "paid");
  if (!renewSection.classList.contains("hidden")) {
    buildPlanPicker("renewPlanPicker", "renewPlan");
  }

  // Voice feedback — check-in itself is voiced by the kiosk app now; this
  // page only needs to flag an expired/invalid membership when viewed.
  // Delayed for the same reason as above — plays after the mascot's cheer.
  if (!isActive && checkinStatus !== "pending-approval") {
    setTimeout(() => speakText(`${member.name}, please check your membership status or contact the front desk.`), 0);
  }
}


document.getElementById("renewButton")?.addEventListener("click", () => {
  const planId = document.querySelector("input[name=renewPlan]:checked")?.value;
  if (!planId) return;
  openPaymentModal(planId);
});

// --------------------------------------------------------- auto check-in --
// Number-based check-in: the moment an eligible member's status loads (i.e.
// right after they hit "Go"), we attempt today's check-in automatically —
// no separate button tap needed. Check-ins are still one-per-day per
// member — the doc ID `${memberId}_${dateKey}` means a second check-in the
// same day is a Firestore "update" (not "create"), which only admins are
// allowed to do (see firestore.rules), so duplicates are rejected
// server-side too, not just in the UI.
function checkinDocId(memberId, dateKey) {
  return `${memberId}_${dateKey}`;
}

/** Attempts today's check-in for an active, approved member and reports the outcome in checkinNote. */
async function performAutoCheckin(member) {
  const checkinNote = document.getElementById("checkinNote");
  const todayKey = toDateKey(new Date());
  const docId = checkinDocId(member.id, todayKey);

  try {
    // Check first so we don't even attempt a write we know will be an
    // "update" (blocked by firestore.rules for non-admins) — cheaper and
    // avoids a console error on the expected "already checked in" path.
    const existing = await checkinsCol.doc(docId).get();
    if (existing.exists) {
      checkinNote.textContent = "You've already checked in today.";
      checkinNote.className = "text-sm text-slate-500 font-medium";
      checkinNote.classList.remove("hidden");
      return;
    }

    await checkinsCol.doc(docId).set({
      memberId: member.id,
      phone: member.phone,
      dateKey: todayKey,
      method: "manual",
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    });

    checkinNote.textContent = "Checked in today! ✅";
    checkinNote.className = "text-sm text-emerald-600 font-semibold";
    checkinNote.classList.remove("hidden");
    speakText(`Checked in successfully. Welcome, ${member.name}!`);

    loadMemberCheckinHistory(member.id);
  } catch (err) {
    console.error("Auto check-in failed:", err);
    // A permission-denied error here almost always means today's check-in
    // already exists (a race with the read above) or the member isn't
    // approved yet — either way, treat it the same as "already checked in".
    if (err.code === "permission-denied") {
      checkinNote.textContent = "You've already checked in today.";
      checkinNote.className = "text-sm text-slate-500 font-medium";
      checkinNote.classList.remove("hidden");
    } else {
      checkinNote.textContent = "Couldn't check in — please try again or ask staff for help.";
      checkinNote.className = "text-sm text-rose-500 font-medium";
      checkinNote.classList.remove("hidden");
    }
  }
}

// ------------------------------------------------------------ UPI payment --
let pendingPaymentPlanId = null;

/**
 * Opens the payment modal and builds a real upi://pay deep link using the
 * gym's official UPI ID (fetched securely from Firestore settings/config —
 * see js/firebase-config.js -> getPaymentSettings()). Tapping the resulting
 * button launches the member's installed UPI app (GPay/PhonePe/Paytm/etc.)
 * pre-filled with the exact amount. This app never marks a membership as
 * paid on its own — see the on-screen note; only the gym admin can do that
 * from the dashboard after verifying the payment (enforced in firestore.rules).
 */
async function openPaymentModal(planId) {
  if (!currentMember) return;
  pendingPaymentPlanId = planId;
  const plan = PLANS[planId];

  document.getElementById("modalPlanLabel").textContent = plan.label;
  document.getElementById("modalPlanPrice").textContent = formatCurrency(plan.price);

  const payLink = document.getElementById("upiPayLink");
  const fallback = document.getElementById("upiIdFallback");
  const unavailableNote = document.getElementById("upiUnavailableNote");

  payLink.classList.add("hidden");
  fallback.classList.add("hidden");
  unavailableNote.classList.add("hidden");
  payLink.removeAttribute("href");

  document.getElementById("paymentModal").classList.remove("hidden");

  const settings = await getPaymentSettings();
  if (!settings.upiId) {
    unavailableNote.classList.remove("hidden");
    speakText("Online payments aren't set up yet for this gym. Please pay at the front desk.");
    return;
  }

  const note = `${GYM_SETTINGS.name} - ${plan.label} - ${currentMember.name}`;
  const transactionRef = `${currentMember.id}-${Date.now()}`;
  const upiLink = buildUpiLink({
    upiId: settings.upiId,
    payeeName: settings.payeeName,
    amount: plan.price,
    note,
    transactionRef,
  });

  payLink.href = upiLink;
  payLink.classList.remove("hidden");

  document.getElementById("upiIdText").textContent = settings.upiId;
  fallback.classList.remove("hidden");
}

function closeModal() {
  document.getElementById("paymentModal").classList.add("hidden");
  pendingPaymentPlanId = null;
}

/** Copies the fallback UPI ID to the clipboard so it can be pasted into any UPI app manually. */
async function handleCopyUpiId() {
  const upiId = document.getElementById("upiIdText").textContent;
  if (!upiId) return;
  const btn = document.getElementById("copyUpiIdBtn");
  try {
    await navigator.clipboard.writeText(upiId);
    const original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  } catch (err) {
    console.error("Clipboard copy failed:", err);
    // Clipboard API can be unavailable (e.g. non-HTTPS); the ID is still
    // visible on screen for the member to select and copy manually.
  }
}

// Status check ke waqt check-in history fetch karne ka function
// Status check ke waqt check-in history fetch karne ka function (GymOps Light Theme Optimized)
// Fetches the last 7 days by deterministic doc ID (`${memberId}_${dateKey}`
// means at most one record per day), so this filters by dateKey rather than
// just taking the most recent N documents.
async function loadMemberCheckinHistory(memberId) {
  const historyList = document.getElementById("memberCheckinHistory");
  const streakContainer = document.getElementById("streakBadgeContainer");
  const streakText = document.getElementById("streakText");

  historyList.innerHTML = '<li class="text-slate-400 px-3 py-2 text-xs">Loading history</li>';

  try {
    // Members aren't signed in (no Firebase Auth session), so
    // firestore.rules can't scope a `list` query to "only this member's
    // own docs" -- the rules only allow `list` on /checkins for verified
    // admins (otherwise anyone could enumerate every check-in for every
    // member). So instead of a `.where("memberId","==",...).get()` query
    // (which needs `list` and would get rejected with permission-denied --
    // that was the actual bug behind "Could not load check-in history"),
    // we fetch each of the last 7 days' check-in docs individually by ID
    // (`${memberId}_${dateKey}`) using `.get()`, which firestore.rules
    // allows publicly per-document -- same pattern as the members
    // collection's public `get`.
    const dateKeys = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dateKeys.push(toDateKey(d));
    }

    const snapshots = await Promise.all(
      dateKeys.map((dateKey) => checkinsCol.doc(checkinDocId(memberId, dateKey)).get())
    );
    const records = snapshots
      .filter((doc) => doc.exists)
      .map((doc) => doc.data())
      .sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));

    if (records.length === 0) {
      historyList.innerHTML = '<li class="text-slate-400 italic px-3 py-2 text-xs">No check-ins recorded yet.</li>';
      streakContainer.classList.add("hidden");
      return;
    }

    // 1. Render History List (last 7 days) with High-Contrast Light Theme Classes
    historyList.innerHTML = "";
    records.forEach((record) => {
      const timeStr = record.timestamp?.toDate 
        ? record.timestamp.toDate().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) 
        : "";
      
      const li = document.createElement("li");
      // Light theme ke liye crisp white box, clear border, aur dark text
      li.className = "flex items-center justify-between bg-slate-50 border border-slate-200 px-3.5 py-2.5 rounded-xl text-xs font-medium";
      li.innerHTML = `
        <span class="text-slate-900 font-bold">${record.dateKey}</span>
        <span class="text-slate-600 font-semibold">${timeStr} <span class="text-slate-400 font-normal">(${record.method || 'gps'})</span></span>
      `;
      historyList.appendChild(li);
    });

    // 2. Calculate Streak (Unique days count in recent records)
    const uniqueDays = [...new Set(records.map(r => r.dateKey))];
    const streakCount = uniqueDays.length;

    if (streakCount > 0) {
      streakText.textContent = `${streakCount} check-in${streakCount === 1 ? '' : 's'} logged total! Keep it up!`;
      streakContainer.classList.remove("hidden");
      streakContainer.classList.add("flex");
    } else {
      streakContainer.classList.add("hidden");
    }

  } catch (err) {
    console.error("Error loading history:", err);
    historyList.innerHTML = '<li class="text-rose-600 px-3 py-2 text-xs">Could not load check-in history.</li>';
  }
}

// ==================== KIOSK SECURITY ====================
// Real "can't switch away from this app" lockdown (blocking the system
// swipe-up/home gesture and the notification-shade swipe) is Android's own
// Screen Pinning feature (or a dedicated kiosk-launcher app with Device
// Owner permissions) — set up at the OS level, not in this code.
//
// BUT: Screen Pinning only stops you from *switching to another app* — it
// does NOT stop the Back button from navigating *inside* this page. A
// single-page app like this has no real browser history to go "back" to,
// so without a guard, one Back press was enough to make Chrome reload the
// page from scratch (the splash screen flashing back up, Sparky's greeting
// restarting, etc). So the guard below IS needed — it was removed once by
// mistake and has been restored — this version pushes a fresh state
// synchronously on every single popstate, no batching/delay, so history
// never actually runs dry (see the comment on pushGuardState below for why
// that's enough even under a fast burst of taps).
(function setupBackTrap() {
  // Every popstate (i.e. every Back press) immediately pushes a fresh state
  // right back — synchronously, with no delay/guard in between. Because
  // JS runs on a single thread, each Back press is handled start-to-finish
  // (native back → popstate fires → this handler pushes a new state) before
  // the next press's event is even processed, no matter how fast someone
  // taps. So there's never a moment where history genuinely runs out and
  // Android decides to close/relaunch the app (which is what showed the
  // splash screen). An earlier version of this added a setTimeout-based
  // "guard" meant to prevent races — that guard was the actual bug: it
  // could skip a push if two presses landed close together, thinning out
  // the history buffer until a fast burst broke through it.
  function pushGuardState() {
    history.pushState({ kiosk: true }, "", location.href);
  }
  pushGuardState(); // so the very first Back press already has somewhere to land
  window.addEventListener("popstate", pushGuardState);
})();

// ==================== DISABLE COPY / SELECT / CONTEXT MENU ====================
// CSS (`user-select: none` in index.html) handles most of this, but some
// Android browsers still show the long-press "Copy / Select all / Web
// search" popup on inputs and text regardless of that CSS, and desktop
// right-click context menus aren't CSS-blockable at all. This is the JS
// backstop: block the events at the document level so nothing anywhere in
// the app can be selected, copied, cut, or right-clicked. Inputs are
// deliberately NOT excluded — typing/backspace/cursor movement all still
// work fine, this only stops highlighting text for copy.
["contextmenu", "selectstart", "copy", "cut"].forEach((evt) => {
  document.addEventListener(evt, (e) => e.preventDefault());
});

// ==================== CUSTOM NUMERIC KEYPAD ====================
// Phone-number inputs are `readonly` (see index.html) so tapping them can
// never trigger the native Android/Chrome keyboard at all -- this custom
// on-screen keypad drives their value instead. Since the native keyboard
// never opens, Chrome's autofill accessory bar (the key/card/location-pin
// icons) and the "Save password?" prompt never have a keyboard to attach
// to either -- this fixes that problem as a side effect, not just a
// cosmetic one, and makes the number-entry UI feel like a dedicated part
// of this app rather than a generic browser text field.
//
// The typed number shows up in the real input field itself (same as
// before) -- not a separate readout inside the keypad -- so on open we
// scroll the field into view above the keypad sheet, and the backdrop
// behind the sheet is left undimmed/untouched so the field stays exactly
// as visible as it always was.
(function setupCustomKeypad() {
  const overlay = document.getElementById("customKeypadOverlay");
  if (!overlay) return;

  const backdrop = document.getElementById("customKeypadBackdrop");
  const clearBtn = document.getElementById("keypadClearBtn");
  const backspaceBtn = document.getElementById("keypadBackspaceBtn");
  const MAX_DIGITS = 10; // Indian mobile numbers

  let activeInput = null;

  function fireInputEvent(input) {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function openKeypadFor(input) {
    activeInput = input;
    // Snap the real field into view above the sheet FIRST, instantly (no
    // smooth-scroll animation, no delay) -- so there's no in-between frame
    // where the field/Go button are still cut off by the keypad before it
    // settles. Only then reveal the keypad itself.
    input.scrollIntoView({ behavior: "auto", block: "start" });
    input.classList.add("keypad-focused");
    overlay.classList.remove("hidden");
  }

  function closeKeypad() {
    if (activeInput) activeInput.classList.remove("keypad-focused");
    activeInput = null;
    overlay.classList.add("hidden");
  }

  function appendDigit(digit) {
    if (!activeInput || activeInput.value.length >= MAX_DIGITS) return;
    activeInput.value += digit;
    fireInputEvent(activeInput);
    // No "Done" button on this keypad -- once a full 10-digit number is
    // in, there's nothing more to type, so close automatically instead of
    // making the person tap something to dismiss it.
    if (activeInput.value.length >= MAX_DIGITS) {
      closeKeypad();
    }
  }

  function backspace() {
    if (!activeInput) return;
    activeInput.value = activeInput.value.slice(0, -1);
    fireInputEvent(activeInput);
  }

  function clearAll() {
    if (!activeInput) return;
    activeInput.value = "";
    fireInputEvent(activeInput);
  }

  document.querySelectorAll(".custom-keypad-input").forEach((input) => {
    input.addEventListener("click", () => openKeypadFor(input));
  });

  overlay.querySelectorAll("[data-key]").forEach((btn) => {
    btn.addEventListener("click", () => appendDigit(btn.dataset.key));
  });
  if (backspaceBtn) backspaceBtn.addEventListener("click", backspace);
  if (clearBtn) clearBtn.addEventListener("click", clearAll);
  if (backdrop) backdrop.addEventListener("click", closeKeypad);
})();
