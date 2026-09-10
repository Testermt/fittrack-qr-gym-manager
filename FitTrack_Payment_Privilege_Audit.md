# FitTrack — Payment & Privilege Escalation Deep-Dive

Follow-up to the initial audit, focused specifically on payment tampering and admin privilege escalation, per your checklist.

---

## 🔴 Critical: Admin impersonation via leftover email/password auth path

This is the real privilege-escalation vector in this codebase — not a rules bug in the `members`/`payments` collections themselves.

`isVerifiedAdmin()` is identity-agnostic about *how* someone authenticated:
```js
function isVerifiedAdmin() {
  return request.auth != null &&
    exists(/databases/$(database)/documents/admins/$(request.auth.token.email));
}
```
It trusts `request.auth.token.email` completely, regardless of which sign-in provider produced it or whether that email was ever verified.

`admin.html` no longer renders an email/password form — but `admin.js` still ships fully working functions for it: `handleLogin`, `handleForgotPassword`, and `signInWithEmailAndPassword` calls (lines ~152–232). Dead UI doesn't mean a dead capability: **any Firebase Auth method enabled on the project is reachable straight from the browser console**, form or no form:
```js
firebase.auth().createUserWithEmailAndPassword("realadmin@yourgym.com", "AttackerChosenPassw0rd!")
```
If the Email/Password provider is still enabled in the Firebase console (the leftover code strongly suggests it was in use before being pulled from the UI — worth confirming directly in Firebase Console → Authentication → Sign-in method), this call:
- Creates a brand-new Firebase Auth user with `email: "realadmin@yourgym.com"`, `email_verified: false` — no proof of inbox ownership required at creation time.
- Immediately returns a valid ID token where `request.auth.token.email == "realadmin@yourgym.com"`.
- That token then passes `isVerifiedAdmin()` outright, because the check only compares the email string against the `/admins/{email}` whitelist — it has no idea the "admin" signing in didn't actually authenticate as that person.

From there, the attacker has **full admin rights**: `membersCol.doc(phone).update({paymentStatus: "paid", approved: true})`, arbitrary deletes, writing directly to `payments`, everything.

**Important caveat (so you can gauge real exposure):** this specific path only works for an admin email that has *never* created a Firebase Auth account before (e.g., a newly whitelisted admin who hasn't logged in yet), assuming your project's default "one account per email address" linking is on — if the real admin has already signed in with Google once, Firebase will reject `createUserWithEmailAndPassword` for that email with `auth/email-already-in-use`. That's a helpful mitigating factor, but it's fragile: it depends on account-creation *order* and a Firebase project setting you'd have to go verify, not on anything your rules actually enforce. Don't rely on timing/config to save you — fix it in the rule itself:

```js
function isVerifiedAdmin() {
  return request.auth != null
    && request.auth.token.email_verified == true
    && request.auth.token.firebase.sign_in_provider == 'google.com'
    && exists(/databases/$(database)/documents/admins/$(request.auth.token.email));
}
```
This closes the hole unconditionally: it no longer matters whether Email/Password is enabled, whether the real admin has logged in yet, or what the project's linking setting is — only a genuine Google OAuth assertion for that exact email can ever satisfy `isVerifiedAdmin()`.

**Also do this:**
- Delete `handleLogin` / `handleForgotPassword` / the `loginForm` submit wiring from `admin.js` entirely — dead code that re-exposes a credentialed auth path is a liability even after the rule fix.
- In Firebase Console → Authentication → Sign-in method, **disable Email/Password** if Google is the only intended admin path. Belt and suspenders with the rule fix above.

---

## Direct answers to your checklist

### 1. Payment-status privilege escalation via `members` update
**Not exploitable as asked.** `allow list, update, delete: if isVerifiedAdmin();` gates every `update()` on `members` — a regular member has no Firebase Auth session at all in this app (`member.js` never signs anyone in), so `request.auth == null` and `isVerifiedAdmin()` short-circuits to `false` immediately. A member (or anonymous console user) calling:
```js
db.collection('members').doc('919876543210').update({paymentStatus: 'paid'})
```
gets `PERMISSION_DENIED`. Same for flipping `approved`. **This is correctly locked down** — contingent on the fix above, since `isVerifiedAdmin()` is the single choke point everything else depends on.

`executeMarkAsPaid` in `admin.js` is not itself a security boundary and doesn't need to be — it's a convenience wrapper. Whether it's invoked from the real UI, a modified copy of the function, or hand-typed console calls makes no difference: the Firestore rule is what actually decides the outcome, and it correctly requires `isVerifiedAdmin()` either way. A malicious user *can* call `executeMarkAsPaid()` from the console, but it will fail identically to a raw `.update()` call unless they are a real verified admin.

### 2. Payments collection integrity
**Locked down correctly:**
```js
match /payments/{paymentId} {
  allow create, read, update, delete: if isVerifiedAdmin();
}
```
No create/read/update/delete path is available to a non-admin. An unverified user cannot plant a fake `payments` doc to spoof revenue reporting. (Same caveat as above: this is only as strong as `isVerifiedAdmin()` itself — fix that function and this collection is solid.)

### 3. Client/server disconnects
- `member.js`'s payment UI (`openPaymentModal`, `buildUpiLink`) only ever *builds a `upi://pay` deep link* for the member's own convenience — it never writes to Firestore. There is no code path in `member.js` that could mark a payment "paid" even if fully tampered with; a member editing the DOM to visually show "PAID" changes nothing in the database, and the badge is re-rendered from `doc.data()` on every fresh status check.
- The only two places `paymentStatus` is ever written are: (a) registration, hard-coded to `"pending"` and enforced by the create rule, and (b) `executeMarkAsPaid` in `admin.js`, gated by `isVerifiedAdmin()`. There is no "fake successful payment modal" vector that touches real data — it's cosmetic-only if attempted.

### 4. Other authorization gaps across collections
- `members` **update** (admin-authenticated) has no field/type whitelist — unlike `create`, there's nothing stopping a compromised or buggy admin session from writing arbitrary extra fields or wrong types into an existing member doc. Low severity (requires an already-privileged session) but cheap to harden:
  ```js
  allow update: if isVerifiedAdmin()
                && request.resource.data.paymentStatus in ["pending","paid"]
                && request.resource.data.approved is bool;
  ```
- `checkins` and the composite-ID/duplicate-check-in gap flagged in the previous audit are still outstanding and unrelated to payments — see that report for the fix.

---

## 🟡 Medium / Hardening

- Add the `auth_time` freshness check (from the previous audit) specifically to `payments` create and `members` update-of-paymentStatus, so that even a **legitimate but unattended** admin session requires a fresh re-auth before money-affecting writes go through — this is the realistic "payment fraud by insider/opportunist" scenario now that the outsider-impersonation hole above is closed.
- Consider logging `markedBy: request.auth.token.email` server-verifiably (it already is, implicitly, via `isVerifiedAdmin()`, but the `payments` doc itself doesn't currently store which admin performed the action — useful for audit trails if a dispute arises).
- Confirm in the Firebase Console that the `admins` collection is only ever seeded via the Admin SDK/console, never through any deployed Cloud Function that trusts client input.

---

## 🟢 Confirmed Secure

- `paymentStatus` cannot be escalated from `pending` → `paid` by any unauthenticated or non-admin authenticated user — no rule path allows it.
- `approved` cannot be self-flipped to `true` — same reasoning.
- `payments` collection has no create/read/write path for non-admins; revenue cannot be spoofed by outside actors.
- Registration (`create`) hard-forces `paymentStatus: "pending"` and `approved: false` — can't be bypassed at signup.
- No client-side code in `member.js` ever writes `paymentStatus` or `approved` — the entire member-facing payment UI is display/deep-link only, with zero write capability.
- `admins/{email}` remains fully write-blocked from the client (`allow write: if false`), so the whitelist itself can't be tampered with directly — the only viable attack surface is impersonating an already-whitelisted email via auth-provider confusion, which is the finding above.

**Bottom line:** your Firestore *authorization logic* for payments is sound — the gap isn't in what `isVerifiedAdmin()` checks once it's true, it's in how easily "true" can be reached via a non-Google auth path. Fix that one function and this entire threat model closes.
