# FitTrack QR Gym Manager — Security & Logic Audit

Scope: `index.html`, `member.js`, `admin.html`, `admin.js`, `firebase-config.js`, `firestore.rules`

---

## 🔴 Critical Vulnerabilities

### 1. Geofenced check-in has **zero server-side enforcement** — it's a pure UI gate
`member.js` computes the Haversine distance in the browser and only calls `checkinsCol.add()` if it's `<= 40m`. Nothing about the GPS coordinates is ever sent to, or checked by, Firestore. Look at the create rule for `checkins`:

```js
allow create: if request.resource.data.memberId is string
              && request.resource.data.phone is string
              && request.resource.data.phone.size() >= 7
              && request.resource.data.dateKey is string
              && request.resource.data.method in ["geofenced-gps", "manual"]
              && request.resource.data.timestamp == request.time
              && get(/databases/$(database)/documents/members/$(request.resource.data.memberId)).data.approved == true;
```

There is no `lat`/`lng` field in the document at all, so there is literally nothing for a rule to validate. Any **approved** member (which just means their own phone number, which they obviously know) can open DevTools Console on the page (or hit the Firestore REST/SDK API directly from anywhere in the world) and run:

```js
firebase.firestore().collection('checkins').add({
  memberId: "919876543210",
  phone: "919876543210",
  dateKey: "2026-09-10",
  method: "geofenced-gps",
  timestamp: firebase.firestore.FieldValue.serverTimestamp()
});
```
This passes every rule check and creates a fully "valid" geofenced check-in from anywhere — no gym visit required. Chrome's built-in **Sensors panel** ("Override geolocation") makes this even easier without touching the console at all, and the exact gym coordinates (`29.456545, 77.717185`) are sitting in cleartext in the publicly-served `member.js`.

**Remediation:** Firestore rules fundamentally cannot verify a client-reported GPS reading — the client controls what it sends. Options, in order of robustness:
- Move check-in through a **Cloud Function (callable)** that requires **Firebase App Check** (blocks scripted/non-browser callers) and treat the client GPS reading as advisory only, paired with a physical proof-of-presence signal (e.g., a rotating QR code displayed on a screen at the gym, or a gym Wi‑Fi–only endpoint/BSSID check).
- At minimum, enable **App Check** so raw REST/console abuse from outside your own app instance is blocked (this stops casual tampering, not a determined attacker who extracts the debug token, but raises the bar significantly).
- Accept this as an inherent limitation of GPS-only proof and message it internally — don't rely on it for anything financially consequential.

### 2. No duplicate/forged check-in protection in the rules — the "once per day" rule is client-side only
`logCheckinIfNeeded` queries existing check-ins in JS and skips the insert if one already exists for `today` — but the **rule has no equivalent check**. Nothing stops:
- Inserting **multiple** check-in documents per member per day (inflating stats, streaks, or covering for a manual audit).
- Setting `dateKey` to any arbitrary string, independent of the current date. This can be trivially exploited via console, bypassing the app entirely and racing past the client-side pre-check (classic TOCTOU).

**Remediation — use a deterministic document ID instead of `.add()`:**

```js
// checkins/{memberId}_{dateKey}
match /checkins/{checkinId} {
  allow create: if request.resource.data.memberId is string
                && request.resource.data.phone is string
                && request.resource.data.phone.size() >= 7
                && request.resource.data.dateKey is string
                && request.resource.data.method in ["geofenced-gps", "manual"]
                && request.resource.data.timestamp == request.time
                && checkinId == request.resource.data.memberId + '_' + request.resource.data.dateKey
                && get(/databases/$(database)/documents/members/$(request.resource.data.memberId)).data.approved == true;

  allow read, update, delete: if isVerifiedAdmin();
}
```
Client change: `checkinsCol.doc(`${memberId}_${today}`).set({...})` instead of `.add({...})`. If a doc already exists at that path, Firestore evaluates the write as an **update**, which only admins are allowed to do — so a second write for the same member/day is atomically rejected server-side, no race condition, no per-query check needed for security (keep it for UX only).

### 3. Unauthenticated PII harvesting via predictable document IDs
```js
match /members/{phone} {
  allow get: if true;
  ...
}
```
Document IDs **are** the raw phone number (7–15 digits). Combined with public `get`, anyone can script sequential/likely phone-number GETs directly against the Firestore REST endpoint (no login, no rate limit, no App Check) and harvest **name, address, plan, expiry date, and payment status** for every member in the gym. This is a straightforward automatable PII scrape, not a theoretical one.

**Remediation:**
- Split the document: keep only what the status page truly needs public (e.g., `approved`, `paymentStatus`, `expiryDate`) in a lean doc, and move `name`/`address` into an admin-only sub-collection or the `members` doc itself with `get` restricted, retrieved instead via a callable Cloud Function that the member reaches by submitting their own phone number (function can rate-limit/App-Check).
- Enable **App Check** at minimum to stop pure script/REST abuse.

### 4. Admin re-auth modal is a client-side illusion — it doesn't map to anything Firestore can verify
`requestReauth` / `handleReauthSubmit` gate `delete` and `mark-paid` behind either a WebAuthn assertion or `reauthenticateWithCredential`. But the actual writes are authorized purely by:
```js
function isVerifiedAdmin() {
  return request.auth != null && exists(/databases/$(database)/documents/admins/$(request.auth.token.email));
}
```
This has no concept of "was this session recently re-verified." Two separate problems:
- **The WebAuthn branch never touches Firebase Auth at all.** `navigator.credentials.get()` succeeding just resolves a JS promise — it doesn't refresh the ID token or set any claim Firestore can see. It is 100% cosmetic from the database's point of view.
- **Even the password branch**, which *does* call `reauthenticateWithCredential` (and does update the token's `auth_time`), isn't enforced by the rules — `isVerifiedAdmin()` never checks `auth_time` freshness.

Net effect: anyone with access to an already-authenticated admin session — an unlocked laptop left open, a stolen session via XSS, or simply opening DevTools and calling `firebase.firestore().collection('members').doc(id).delete()` directly — can **skip the modal completely**. The "leave dashboard open" scenario you asked about is a real bypass today.

**Remediation:**
```js
function recentlyReauthenticated() {
  return request.auth != null
    && (request.time.toMillis()/1000 - request.auth.token.auth_time) < 300; // 5 min
}

match /members/{phone} {
  allow update: if isVerifiedAdmin();
  allow delete: if isVerifiedAdmin() && recentlyReauthenticated();
}

match /payments/{paymentId} {
  allow create: if isVerifiedAdmin() && recentlyReauthenticated();
  allow read, update, delete: if isVerifiedAdmin();
}
```
This only works for real Firebase reauthentication (password, or re-triggering the Google popup with `reauthenticateWithPopup`). The WebAuthn/biometric convenience layer would need to be re-architected around a Cloud Function that verifies the assertion server-side and mints a short-lived custom token/claim — otherwise it should be treated as a UX nicety, not a security boundary, and the two destructive actions should require the real Firebase reauth path.

### 5. No schema/type enforcement on member self-registration
```js
allow create: if phone.matches('^[0-9]{7,15}$')
              && request.resource.data.phone == phone
              && request.resource.data.paymentStatus == "pending"
              && request.resource.data.approved == false;
```
Nothing restricts the field set or types beyond those three. A console user can add arbitrary extra fields, or submit `name` as a number/array/object instead of a string. That's not just theoretical — `renderMemberTable` does `m.name.toLowerCase()`, which **throws** on a non-string `name`, breaking the admin dashboard's rendering for every admin until the poisoned doc is manually removed from the console. This is a trivial, unauthenticated DoS against the admin panel.

**Remediation:**
```js
allow create: if phone.matches('^[0-9]{7,15}$')
              && request.resource.data.keys().hasOnly(
                   ['name','phone','address','joinDate','plan','expiryDate',
                    'paymentStatus','approved','createdAt','updatedAt'])
              && request.resource.data.phone == phone
              && request.resource.data.name is string && request.resource.data.name.size() > 0 && request.resource.data.name.size() < 100
              && request.resource.data.address is string
              && request.resource.data.plan in ['1m','3m','6m','12m']
              && request.resource.data.joinDate is string
              && request.resource.data.expiryDate is string
              && request.resource.data.paymentStatus == "pending"
              && request.resource.data.approved == false;
```

---

## 🟡 Medium / Low Risks

- **`approved` never expires.** Once an admin sets `approved: true`, the check-in rule (`get(...).data.approved == true`) has no relationship to `expiryDate`. A member whose membership lapsed months ago can keep checking in forever unless an admin manually flips `approved` back to `false`. Consider either re-deriving eligibility from `expiryDate` in the rule, or having a scheduled Cloud Function sweep expired members back to `approved: false`.
- **No App Check anywhere.** Registration (`members` create) is fully public with no CAPTCHA or App Check, so it can be spammed/DoS'd with junk documents at will.
- **Biometric "device lock" is purely local.** The credential ID lives in `localStorage` (`ft_biometric_cred_${uid}`), scoped only to that browser. Anyone with the authenticated session (e.g., an unlocked device) can clear that key and enroll *their own* fingerprint, since nothing server-side is bound to the original enrollment. Treat this as friction against casual snooping, not a real second factor — the actual trust boundary is Google Sign-In + the `admins` whitelist.
- **`dateKey` is derived from the client's local clock**, not cross-checked against `request.time` server-side. After the composite-ID fix (#2) this mostly stops mattering for duplicate prevention, but a clock-skewed device could still log a check-in dated for the "wrong" day near midnight.
- **CSRF is a non-issue in practice.** Firebase Auth tokens aren't ambient cookies attached automatically by the browser cross-site the way session cookies are — every SDK call explicitly carries a bearer token from IndexedDB. Classic CSRF doesn't really apply to this architecture; no action needed here.
- **`firebase-config.js` API key is not a secret** — this is normal/expected for a Firebase web app. Security rests entirely on `firestore.rules` being correct, not on hiding this file. No action needed, just noting it isn't a leak in itself.

---

## 🟢 Confirmed Secure Areas

- **`approved: false` cannot be forged at registration** — the create rule hard-requires `approved == false` and `paymentStatus == "pending"`, so nobody can self-approve or self-mark-paid on signup.
- **Check-ins correctly cross-reference the member doc** via `get(...).data.approved == true` — a genuinely unapproved member cannot get a check-in document to write no matter what the client does. This is the one place the rules do real cross-document enforcement.
- **`timestamp == request.time`** correctly prevents backdating/forward-dating check-in timestamps.
- **`admins/{email}` blocks all client writes** (`allow write: if false`) — there is no path to self-promote into the admin whitelist from the client; it can only be seeded via the Admin SDK/console. Good.
- **`payments` and `settings` writes are correctly restricted** to `isVerifiedAdmin()`; public read is intentionally limited to what the UPI payment flow needs.
- **Members `list`, `update`, `delete` are correctly admin-only** — a member can only ever fetch their *own* known document by ID, not enumerate/browse the collection.

---

## Priority Order for Fixes
1. Composite check-in doc ID (`memberId_dateKey`) — closes the duplicate/forged check-in gap, cheap and atomic.
2. `keys().hasOnly()` + type checks on `members` create — closes the DoS/data-poisoning gap, cheap.
3. `auth_time` freshness check on `delete`/payment writes, and switch destructive admin actions to real Firebase reauth instead of the decorative WebAuthn branch.
4. Enable Firebase App Check across the project.
5. Reassess public `get` on `members` — either split the document or move status lookups behind a callable function.
