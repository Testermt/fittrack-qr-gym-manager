// FitTrack QR Gym Manager — Member Portal logic (index.html)


// ==================== GEOFENCING CONFIGURATION ====================
// ==================== GEOFENCING CONFIGURATION ====================
/*
const GYM_LOCATION = {
  lat: 29.456545,           // Tera ghar/testing latitude
  lng: 77.717185,           // Tera ghar/testing longitude
  allowedRadiusMeters: 40   // Range in meters
};
*/


const GYM_LOCATION = {
  lat: 29.456923,     // Tera ghar/testing latitude
  lng: 77.717848,           // Tera ghar/testing longitude
  allowedRadiusMeters: 20   // Range in meters
};



// Haversine formula to calculate distance in meters
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}






const membersCol = db.collection("members");
const checkinsCol = db.collection("checkins");

// ---------------------------------------------------------------- setup --
document.addEventListener("DOMContentLoaded", () => {
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

/**
 * Logs a check-in for today, but only once per member per day.
 *
 * Firestore indexing: this filters ONLY on `memberId` — a single-field
 * equality query, which Firestore indexes automatically with zero setup —
 * and then checks the date match in plain JavaScript instead of adding a
 * second `.where("dateKey", "==", today)` clause. Chaining a second
 * equality/range filter (or an `orderBy` on a different field) is exactly
 * what triggers Firestore's "missing composite index" error, which
 * requires manually creating an index in the Firebase Console before the
 * query works. Keeping it to one filter avoids that entirely.
 *
 * Never throws: any failure (network, permissions, etc.) is caught and
 * logged, and the function resolves with `false`. This makes it safe to
 * call without awaiting — a caller can fire it and move on, and it will
 * never surface as an unhandled promise rejection or block anything.
 */
// ==================== STRICT GEOFENCED CHECK-IN ====================
// ==================== UPDATED GEOFENCED CHECK-IN ====================

/**
 * Checks the LIVE Permissions API state for geolocation (when supported).
 * Returns 'granted' | 'denied' | 'prompt' | 'unsupported'.
 *
 * This is the key fix for the "manual override doesn't work" bug: the old
 * code never asked the browser what the *current* permission state is — it
 * just fired getCurrentPosition() and hoped. Because we query fresh on every
 * single attempt (no caching in a JS variable), if the user goes into site
 * settings and flips Block -> Allow, the very next check-in attempt sees
 * 'granted' immediately. No reload required.
 */
async function getGeoPermissionState() {
  if (!navigator.permissions || !navigator.permissions.query) {
    return "unsupported"; // older Safari, some in-app browsers
  }
  try {
    const status = await navigator.permissions.query({ name: "geolocation" });
    return status.state; // 'granted' | 'denied' | 'prompt'
  } catch (err) {
    return "unsupported";
  }
}

/**
 * Attempts a geofenced check-in. Never throws and never blocks the app with
 * alert() for expected/recoverable states — it always resolves to a status
 * string (or, for out-of-range, a small status object) that the caller uses
 * to render UI. Possible resolved values:
 *   "success" | "already-checked-in" | "geo-unsupported" |
 *   "permission-denied" | "position-unavailable" | "location-timeout" |
 *   "error" | { status: "out-of-range", distance: <meters> }
 */
async function logCheckinIfNeeded(memberId, name, phone) {
  if (!navigator.geolocation) {
    return "geo-unsupported";
  }

  // 0. Ask the browser for its CURRENT permission state before doing
  // anything else. If it's already denied, calling getCurrentPosition()
  // anyway is exactly what causes the "silent failure, popup never comes
  // back" symptom — on most browsers a denied permission fails instantly
  // with code 1 and no prompt. We short-circuit straight to the guidance
  // UI instead of letting that happen.
  const permissionState = await getGeoPermissionState();
  if (permissionState === "denied") {
    return "permission-denied";
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const userLat = position.coords.latitude;
        const userLng = position.coords.longitude;
        const distance = calculateDistance(userLat, userLng, GYM_LOCATION.lat, GYM_LOCATION.lng);

        console.log("Current User Lat/Lng:", userLat, userLng);
        console.log("Distance from Gym (Meters):", Math.round(distance));

        // 1. Agar gym se door hai
        if (distance > GYM_LOCATION.allowedRadiusMeters) {
          resolve({ status: "out-of-range", distance: Math.round(distance) });
          return;
        }

        // 2. Check already checked-in today
        const today = toDateKey(new Date());
        try {
          const snapshot = await checkinsCol.where("memberId", "==", memberId).get();
          const alreadyCheckedInToday = snapshot.docs.some((doc) => doc.data().dateKey === today);

          if (alreadyCheckedInToday) {
            resolve("already-checked-in");
            return;
          }

          // 3. Success: Save check-in with a deterministic document ID (memberId_dateKey)
          const checkinId = `${memberId}_${today}`;
          await checkinsCol.doc(checkinId).set({
            memberId,
            name,
            phone,
            dateKey: today,
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            method: "geofenced-gps",
          });

          resolve("success");
        } catch (err) {
          console.error("Firestore check-in error:", err);
          resolve("error");
        }
      },
      (error) => {
        console.error("GPS Error Code:", error.code, error.message);
        // error.code: 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
        if (error.code === 1) {
          resolve("permission-denied");
        } else if (error.code === 2) {
          resolve("position-unavailable");
        } else if (error.code === 3) {
          resolve("location-timeout");
        } else {
          resolve("error");
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      }
    );
  });
}




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
      return;
    }
    
    currentMember = { id: doc.id, ...doc.data() };

    //  Agar admin ne approve nahi kiya, toh GPS check karne ki zaroorat hi nahi hai!
    if (currentMember.approved !== true) {
      renderStatusCard(currentMember, "pending-approval");
      loadMemberCheckinHistory(currentMember.id);
      return;
    }

    // Agar approved hai, tabhi GPS check-in run hoga
    const checkinStatus = await logCheckinIfNeeded(currentMember.id, currentMember.name, currentMember.phone);
    renderStatusCard(currentMember, checkinStatus);
    loadMemberCheckinHistory(currentMember.id);
    
  } catch (err) {
    console.error(err);
    showBanner("statusBanner", "Something went wrong. Please try again.");
  } finally {
    setBusy(submitBtn, false);
  }
}

/**
 * Re-runs just the geolocation check-in for the member already loaded on
 * screen (currentMember), without making them re-type their phone number.
 * This is what the "Try Again" button in the permission-help banner calls.
 * Because logCheckinIfNeeded() re-queries the Permissions API fresh every
 * time, this will correctly pick up a permission the user just changed to
 * "Allow" in their browser settings — no page reload needed.
 */
async function retryCheckin() {
  if (!currentMember) return;
  hideLocationHelp();
  const retryBtn = document.getElementById("retryLocationBtn");
  setBusy(retryBtn, true, "Checking");
  try {
    const checkinStatus = await logCheckinIfNeeded(currentMember.id, currentMember.name, currentMember.phone);
    renderStatusCard(currentMember, checkinStatus);
    loadMemberCheckinHistory(currentMember.id);
  } catch (err) {
    console.error(err);
    showBanner("statusBanner", "Something went wrong. Please try again.");
  } finally {
    setBusy(retryBtn, false);
  }
}
document.getElementById("retryLocationBtn")?.addEventListener("click", retryCheckin);

/**
 * Detects the user's browser well enough to point them at the right
 * settings menu. Falls back to generic instructions when unsure.
 */
function detectBrowserName() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return "edge";
  if (/OPR\//.test(ua)) return "opera";
  if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) return "chrome";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return "safari";
  return "generic";
}

const LOCATION_HELP_STEPS = {
  chrome: [
    "Tap the lock/info icon (🔒) at the left of the address bar.",
    'Tap "Permissions" or "Site settings".',
    'Find "Location" and set it to "Allow".',
    "Come back here and tap \u201cTry Again\u201d below.",
  ],
  edge: [
    "Tap the lock icon (🔒) at the left of the address bar.",
    'Tap "Permissions for this site".',
    'Set "Location" to "Allow".',
    "Come back here and tap \u201cTry Again\u201d below.",
  ],
  firefox: [
    "Tap the lock/info icon at the left of the address bar.",
    'Tap "Clear permission" or the blocked location icon.',
    "Reload the page and allow location when prompted.",
    "Come back here and tap \u201cTry Again\u201d below.",
  ],
  safari: [
    "Open the iPhone/iPad Settings app (not the browser).",
    'Go to "Safari" (or "Privacy & Security" > "Location Services" on Mac).',
    'Find this website and set Location access to "Allow".',
    "Come back to this page and tap \u201cTry Again\u201d below.",
  ],
  opera: [
    "Tap the lock icon (🔒) at the left of the address bar.",
    'Open "Site settings" and find "Location".',
    'Set it to "Allow".',
    "Come back here and tap \u201cTry Again\u201d below.",
  ],
  generic: [
    "Open your browser's site settings for this page.",
    'Find "Location" (it may say "Blocked" or "Denied").',
    'Change it to "Allow" or "Ask".',
    "Come back here and tap \u201cTry Again\u201d below.",
  ],
};

function showLocationHelp() {
  const banner = document.getElementById("locationHelpBanner");
  if (!banner) return;
  const steps = LOCATION_HELP_STEPS[detectBrowserName()];
  banner.innerHTML = `
    <p class="font-semibold text-rose-500 mb-2">Location access is blocked</p>
    <p class="text-sm text-slate-600 mb-3">
      You (or your browser) blocked location access earlier, so we can't verify
      you're at the gym. Your browser won't show that popup again on its own —
      you'll need to reset it manually:
    </p>
    <ol class="list-decimal list-inside text-sm text-slate-600 space-y-1 mb-4">
      ${steps.map((s) => `<li>${s}</li>`).join("")}
    </ol>
    <button id="retryLocationBtn" type="button" class="btn-primary w-full !min-h-[2.75rem] !py-2 !text-sm">
      Try Again
    </button>
  `;
  banner.classList.remove("hidden");
  // The button was just re-created via innerHTML, so re-bind its listener.
  document.getElementById("retryLocationBtn")?.addEventListener("click", retryCheckin);
}

function hideLocationHelp() {
  document.getElementById("locationHelpBanner")?.classList.add("hidden");
}

function renderStatusCard(member, checkinStatus) {
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

  // Check-in status messages handling
  const checkinNote = document.getElementById("checkinNote");
  hideLocationHelp(); // reset on every render; re-shown below only if needed

  // out-of-range now arrives as { status: "out-of-range", distance } so the
  // UI can show the actual distance instead of a fixed string.
  const status = typeof checkinStatus === "object" && checkinStatus !== null
    ? checkinStatus.status
    : checkinStatus;

  if (status === "success") {
    checkinNote.textContent = "Checked in for today. Have a great workout!";
    checkinNote.className = "text-sm text-emerald-400";
  } else if (status === "already-checked-in") {
    checkinNote.textContent = "You've already checked in today.";
    checkinNote.className = "text-sm text-slate-400";
  } else if (status === "out-of-range") {
    const distance = checkinStatus.distance;
    checkinNote.textContent = distance
      ? `You're ${distance}m from the gym. Go to the gym for check-in.`
      : "Go to gym for check-in.";
    checkinNote.className = "text-sm text-amber-400";
  } else if (status === "pending-approval") {
    checkinNote.textContent = " Your registration is pending admin approval.";
    checkinNote.className = "text-sm text-amber-500 font-semibold";
  } else if (status === "permission-denied") {
    checkinNote.textContent = "Location access is blocked - see instructions below.";
    checkinNote.className = "text-sm text-rose-400";
    showLocationHelp();
  } else if (status === "position-unavailable") {
    checkinNote.textContent = "Couldn't determine your location. Make sure device location/GPS is turned on, then try again.";
    checkinNote.className = "text-sm text-rose-400";
  } else if (status === "location-timeout") {
    checkinNote.textContent = "Location request timed out. Check your signal and try again.";
    checkinNote.className = "text-sm text-rose-400";
  } else if (status === "geo-unsupported") {
    checkinNote.textContent = "This browser doesn't support location access, so check-in isn't available here.";
    checkinNote.className = "text-sm text-rose-400";
  } else {
    checkinNote.textContent = "Something went wrong with check-in. Please try again.";
    checkinNote.className = "text-sm text-rose-400";
  }
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
async function loadMemberCheckinHistory(memberId) {
  const historyList = document.getElementById("memberCheckinHistory");
  const streakContainer = document.getElementById("streakBadgeContainer");
  const streakText = document.getElementById("streakText");
  
  historyList.innerHTML = '<li class="text-slate-400 px-3 py-2 text-xs">Loading history</li>';

  try {
    const snapshot = await checkinsCol.where("memberId", "==", memberId).get();
    const records = snapshot.docs
      .map(doc => doc.data())
      .sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));

    if (records.length === 0) {
      historyList.innerHTML = '<li class="text-slate-400 italic px-3 py-2 text-xs">No check-ins recorded yet.</li>';
      streakContainer.classList.add("hidden");
      return;
    }

    // 1. Render History List with High-Contrast Light Theme Classes
    historyList.innerHTML = "";
    records.slice(0, 5).forEach((record) => {
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
