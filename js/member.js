// FitTrack QR Gym Manager — Member Portal logic (index.html)


// ==================== GEOFENCING CONFIGURATION ====================
// ==================== GEOFENCING CONFIGURATION ====================

const GYM_LOCATION = {
  lat: 29.456545,           // Tera ghar/testing latitude
  lng: 77.717185,           // Tera ghar/testing longitude
  allowedRadiusMeters: 40   // Range in meters
};


/*
const GYM_LOCATION = {
  lat: 29.456923,     // Tera ghar/testing latitude
  lng: 77.717848,           // Tera ghar/testing longitude
  allowedRadiusMeters: 20   // Range in meters
};
*/





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
      <span class="text-sm text-slate-600 font-medium">${plan.label}</span>
      <span class="text-xl font-bold text-slate-900">${formatCurrency(plan.price)}</span>
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
          <span class="text-accent">•</span>
          <span><span class="font-medium text-slate-300">${item.label}:</span> ${item.text}</span>
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
async function logCheckinIfNeeded(memberId, name, phone) {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported by your browser.");
    return "error";
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
          alert(`Check-in blocked! You are ${Math.round(distance)} meters away from the gym. You must be inside the gym premises.`);
          resolve("out-of-range");
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

          // 3. Success: Save check-in
          await checkinsCol.add({
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
        alert("GPS location access is mandatory to check in. Please turn on your phone's location.");
        resolve("error");
      },
      { 
        enableHighAccuracy: true, 
        timeout: 10000, 
        maximumAge: 0 
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
    await membersCol.doc(phone).set({
      name,
      phone,
      address,
      joinDate,
      plan: planId,
      expiryDate,
      paymentStatus: "pending",
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
    // handleStatusCheck ke andar:
currentMember = { id: doc.id, ...doc.data() };
const checkinStatus = await logCheckinIfNeeded(currentMember.id, currentMember.name, currentMember.phone);
renderStatusCard(currentMember, checkinStatus);

//  Yeh line add karni hai taaki history aur streak load ho jaye:
loadMemberCheckinHistory(currentMember.id);

    
  } catch (err) {
    console.error(err);
    showBanner("statusBanner", "Something went wrong. Please try again.");
  } finally {
    setBusy(submitBtn, false);
  }
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
  if (checkinStatus === "success") {
    checkinNote.textContent = " Checked in for today. Have a great workout!";
    checkinNote.className = "text-sm text-emerald-400";
  } else if (checkinStatus === "already-checked-in") {
    checkinNote.textContent = "You've already checked in today.";
    checkinNote.className = "text-sm text-slate-400";
  } else if (checkinStatus === "out-of-range") {
    checkinNote.textContent = " Go to gym for check-in.";
    checkinNote.className = "text-sm text-amber-400";
  } else {
    checkinNote.textContent = "GPS location required for check-in.";
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
