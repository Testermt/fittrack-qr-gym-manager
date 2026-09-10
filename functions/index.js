const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

// Haversine formula for distance calculation in meters
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

exports.verifyAndCheckIn = functions.https.onCall(async (data, context) => {
  const { memberId, userLat, userLng } = data;

  if (!memberId || typeof userLat !== "number" || typeof userLng !== "number") {
    throw new functions.https.HttpsError("invalid-argument", "Invalid location or member data.");
  }

  // 1. Fetch Member Profile & Check Admin Approval Status
  const memberDoc = await db.collection("members").doc(memberId).get();
  if (!memberDoc.exists) {
    throw new functions.https.HttpsError("not-found", "Member profile not found.");
  }
  const memberData = memberDoc.data();

  // STRICT SECURITY: If admin hasn't approved yet, block check-in!
  if (memberData.approved !== true) {
    throw new functions.https.HttpsError(
      "permission-denied", 
      "Your registration is pending admin approval. Please contact the front desk."
    );
  }

  // 2. Fetch official Gym Location securely from Firestore settings/config
  const settingsDoc = await db.collection("settings").doc("config").get();
  const gymConfig = settingsDoc.exists ? settingsDoc.data() : {};
  
  const gymLat = gymConfig.lat || 29.456545; 
  const gymLng = gymConfig.lng || 77.717185; 
  const allowedRadius = gymConfig.allowedRadiusMeters || 40; // 40m GPS Jitter range

  // 3. Calculate distance server-side
  const distance = calculateDistance(userLat, userLng, gymLat, gymLng);

  if (distance > allowedRadius) {
    throw new functions.https.HttpsError(
      "permission-denied", 
      `Check-in blocked! You are ${Math.round(distance)} meters away from the gym premises.`
    );
  }

  // 4. Check duplicate check-in for today
  const today = new Date().toISOString().split("T")[0];
  const checkinsRef = db.collection("checkins");
  
  const snapshot = await checkinsRef.where("memberId", "==", memberId).get();
  const alreadyCheckedIn = snapshot.docs.some((doc) => doc.data().dateKey === today);

  if (alreadyCheckedIn) {
    return { status: "already-checked-in" };
  }

  // 5. Save check-in securely using Admin SDK
  await checkinsRef.add({
    memberId,
    name: memberData.name,
    phone: memberData.phone,
    dateKey: today,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    method: "geofenced-gps-secure",
  });

  return { status: "success", distance: Math.round(distance) };
});
