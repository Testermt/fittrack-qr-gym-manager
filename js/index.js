/**
 * FitTrack Gym Manager — WhatsApp Bot (Firebase Cloud Functions, no n8n)
 *
 * Deploy: firebase deploy --only functions
 * Env vars needed (set via `firebase functions:config:set` or, for 2nd-gen
 * functions like these, `.env` in the functions/ folder):
 *   WHATSAPP_TOKEN         - Meta permanent access token
 *   WHATSAPP_PHONE_ID      - your WhatsApp Business phone number ID
 *   WHATSAPP_VERIFY_TOKEN  - any string YOU choose, entered in Meta's
 *                            webhook config to prove the callback is yours
 */

const { onRequest, onCall } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();
const db = admin.firestore();

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// ==================== FEATURE TIER CHECK (server-side enforcement) ====================
// Mirrors FEATURE_CATALOG in firebase-config.js. Client-side hiding (the
// registration checkbox, admin buttons) is just UX — this is what actually
// stops a Basic-tier gym's WhatsApp functions from running even if someone
// crafts a request by hand or flips a client-side flag.
const TIER_ORDER = ["basic", "prime", "advance"];
const FEATURE_MIN_TIER = { whatsappBot: "prime" };

async function hasFeatureServerSide(featureKey) {
  const minTier = FEATURE_MIN_TIER[featureKey];
  if (!minTier) return false;
  const snap = await db.collection("settings").doc("tier").get();
  const current = snap.exists ? snap.data().current : "basic";
  return TIER_ORDER.indexOf(current) >= TIER_ORDER.indexOf(minTier);
}

// ==================== SHARED HELPERS ====================

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function tomorrowKey() {
  return new Date(Date.now() + 86400000).toISOString().slice(0, 10);
}

function daysUntil(dateKey) {
  const diffMs = new Date(dateKey + "T00:00:00") - new Date(todayKey() + "T00:00:00");
  return Math.round(diffMs / 86400000);
}

/** Sends a plain-text reply. Only works within Meta's 24-hour customer
 *  service window (i.e. the member messaged first, which every bot reply
 *  here is a response to) — fine for menu replies, but the proactive
 *  scheduled reminder/broadcast further down MUST use a template instead. */
async function sendWhatsAppText(phone, body) {
  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to: phone, type: "text", text: { body } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
  } catch (err) {
    console.error(`WhatsApp text send failed (${phone}):`, err.response?.data || err.message);
  }
}

/** Sends an approved template — required for any message the bot sends
 *  WITHOUT the member having messaged first (registration welcome,
 *  scheduled reminders, broadcasts). Create these once in Meta Business
 *  Manager before using; approval typically takes a few hours. */
async function sendWhatsAppTemplate(phone, templateName, params) {
  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
          name: templateName,
          language: { code: "en" },
          components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) }],
        },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    return true;
  } catch (err) {
    console.error(`WhatsApp template send failed (${phone}):`, err.response?.data || err.message);
    return false;
  }
}

const MENU_TEXT =
  "Reply with a number:\n1️⃣ Check my status\n2️⃣ Check in\n3️⃣ Renew my plan\n\n" +
  "Reply STOP to turn off offer messages.";

// ==================== 1. INCOMING MESSAGE WEBHOOK (the bot itself) ====================

exports.whatsappWebhook = onRequest(async (req, res) => {
  // --- Meta's one-time webhook verification handshake (GET) ---
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }

  // Gym's plan doesn't include the WhatsApp bot — don't process the
  // message at all (no reply either, since replying would itself be
  // giving away a Prime feature for free).
  if (!(await hasFeatureServerSide("whatsappBot"))) {
    return res.sendStatus(200);
  }

  // --- Incoming message event (POST) ---
  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];
    if (!message) return res.sendStatus(200); // status callbacks etc — nothing to do

    const fromPhone = message.from; // includes country code, e.g. "919876543210"
    const text = (message.text?.body || "").trim().toLowerCase();

    // Your Firestore doc ID is the LOCAL number (no country code) — strip
    // GYM_SETTINGS.defaultCountryCode's length worth of digits. Hardcoding
    // "91" here matches your current single-country setup; adjust if you
    // ever support multiple.
    const localPhone = fromPhone.startsWith("91") ? fromPhone.slice(2) : fromPhone;

    const memberRef = db.collection("members").doc(localPhone);
    const memberSnap = await memberRef.get();

    if (!memberSnap.exists) {
      await sendWhatsAppText(fromPhone, "This number isn't registered yet. Please visit the gym front desk to sign up.");
      return res.sendStatus(200);
    }

    const member = memberSnap.data();

    // Bot disabled for this member but they're messaging anyway — offer to
    // turn it on rather than silently ignoring them.
    if (!member.whatsappBotOptIn) {
      if (text === "yes") {
        await memberRef.update({ whatsappBotOptIn: true });
        await sendWhatsAppText(fromPhone, "WhatsApp bot enabled! " + MENU_TEXT);
      } else {
        await sendWhatsAppText(fromPhone, "Reply YES to enable check-in & status updates over WhatsApp.");
      }
      return res.sendStatus(200);
    }

    // --- Menu-based intent switch ---
    if (text === "1" || text === "status") {
      const days = daysUntil(member.expiryDate);
      const statusLine = member.approved
        ? (days >= 0 ? `Active — ${days} day(s) left, expires ${member.expiryDate}.` : "Your plan has expired.")
        : "Your registration is pending approval.";
      await sendWhatsAppText(fromPhone, `Hi ${member.name}!\n${statusLine}\n\n${MENU_TEXT}`);

    } else if (text === "2" || text === "checkin" || text === "check in") {
      if (!member.approved) {
        await sendWhatsAppText(fromPhone, "You can't check in yet — your registration is still pending approval.");
      } else {
        const dateKey = todayKey();
        const checkinId = `${localPhone}_${dateKey}`;
        const checkinRef = db.collection("checkins").doc(checkinId);
        const existing = await checkinRef.get();
        if (existing.exists) {
          await sendWhatsAppText(fromPhone, "You've already checked in today ✅");
        } else {
          await checkinRef.set({
            memberId: localPhone, phone: member.phone, name: member.name,
            dateKey, method: "whatsapp-bot",
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
          });
          await sendWhatsAppText(fromPhone, "Checked in ✅ Have a great workout!");
        }
      }

    } else if (text === "3" || text === "renew") {
      // Point them at the same UPI flow your kiosk already uses — pull
      // upiId from settings/config the same way member.js does, or just
      // tell them to renew via the kiosk/front desk if UPI isn't set up.
      const settingsSnap = await db.collection("settings").doc("config").get();
      const upiId = settingsSnap.exists ? settingsSnap.data().upiId : null;
      if (upiId) {
        await sendWhatsAppText(fromPhone,
          `To renew, pay via UPI to ${upiId} and show the receipt at the front desk — ` +
          `your admin will confirm and update your plan.`);
      } else {
        await sendWhatsAppText(fromPhone, "Please renew at the front desk — ask staff to update your plan.");
      }

    } else if (text === "stop") {
      await memberRef.update({ whatsappMarketingOptIn: false });
      await sendWhatsAppText(fromPhone, "You won't receive offer messages anymore. Check-in & reminders are still active.");

    } else {
      await sendWhatsAppText(fromPhone, `Hi ${member.name}! ${MENU_TEXT}`);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("whatsappWebhook error:", err);
    return res.sendStatus(200); // always 200 — Meta retries aggressively on non-200
  }
});

// ==================== 2. WELCOME MESSAGE ON REGISTRATION ====================

exports.welcomeNewMember = onDocumentCreated("members/{phone}", async (event) => {
  const member = event.data.data();
  if (!member.whatsappBotOptIn) return;
  if (!(await hasFeatureServerSide("whatsappBot"))) return;

  const fullPhone = `91${member.phone}`; // adjust if defaultCountryCode changes
  await sendWhatsAppTemplate(fullPhone, "registration_successful", [member.name]);
  // Template body example (create once in Meta Business Manager):
  // "Hi {{1}}! Your registration was successful. Reply MENU anytime to
  //  check your status, check in, or renew your plan."
});

// ==================== 3. DAILY EXPIRY REMINDERS ====================

exports.sendExpiryReminders = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Asia/Kolkata" },
  async () => {
    if (!(await hasFeatureServerSide("whatsappBot"))) return; // Basic-tier gym — skip entirely

    const todayK = todayKey();
    const tomorrowK = tomorrowKey();

    const snap = await db.collection("members")
      .where("expiryDate", "in", [todayK, tomorrowK])
      .where("approved", "==", true)
      .where("whatsappBotOptIn", "==", true)
      .get();

    for (const doc of snap.docs) {
      const m = doc.data();
      if (m.lastReminderSentDate === todayK) continue; // dedup against retries

      const daysLeft = m.expiryDate === todayK ? "today" : "tomorrow";
      const ok = await sendWhatsAppTemplate(`91${m.phone}`, "membership_expiry_reminder", [m.name, daysLeft]);

      if (ok) {
        await doc.ref.update({ lastReminderSentDate: todayK });
      } else {
        await db.collection("pendingReminders").doc(doc.id).set({
          memberId: doc.id, name: m.name, phone: m.phone, daysLeft,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }
  }
);

// ==================== 4. ADMIN-TRIGGERED BROADCAST ====================

exports.sendBroadcast = onCall(async (request) => {
  const email = request.auth?.token?.email;
  if (!email || !request.auth.token.email_verified) {
    throw new Error("unauthenticated");
  }
  const adminDoc = await db.collection("admins").doc(email).get();
  if (!adminDoc.exists) throw new Error("permission-denied");

  if (!(await hasFeatureServerSide("whatsappBot"))) {
    throw new Error("failed-precondition: WhatsApp bot is not enabled on this gym's plan.");
  }

  const { headline, detail } = request.data;
  if (!headline || !detail) throw new Error("invalid-argument: headline and detail required");

  const snap = await db.collection("members")
    .where("whatsappMarketingOptIn", "==", true)
    .where("approved", "==", true)
    .get();

  let sent = 0, failed = 0;
  for (const doc of snap.docs) {
    const m = doc.data();
    const ok = await sendWhatsAppTemplate(`91${m.phone}`, "gym_promo_broadcast", [m.name, headline, detail]);
    ok ? sent++ : failed++;
    await new Promise((r) => setTimeout(r, 100)); // gentle pacing
  }

  await db.collection("broadcastLogs").add({
    headline, detail, sent, failed,
    sentBy: email, sentAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { sent, failed };
});
