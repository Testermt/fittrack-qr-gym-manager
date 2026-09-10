# FitTrack — Re-Verification After Fixes

I re-read every file line by line and diffed the security posture against the two prior audits. Ran `node --check` on `admin.js` to confirm syntax validity, since a rule change and a client change have to match exactly or writes fail.

---

## 🔴 URGENT — Two bugs introduced by the fix (not security holes, but the app is currently broken)

### 1. `admin.js` has a fatal syntax error — the entire admin dashboard script fails to load
Confirmed directly:
```
$ node --check admin.js
admin.js:189
    await auth.sendPasswordResetEmail(email);
    ^^^^^
SyntaxError: await is only valid in async functions and the top level bodies of modules
```
Around line 183–198, the `handleForgotPassword` function's *signature* was deleted when you removed the email/password auth path, but its **body was left behind** as orphaned top-level code, followed by a dangling `}`:

```js
async function handleGoogleSignIn() {
  ...
}


  const originalLabel = btn.textContent;   // <-- orphaned, `btn` undefined here
  btn.disabled = true;
  btn.textContent = "Sending…";

  try {
    await auth.sendPasswordResetEmail(email);   // <-- `email` undefined, `await` outside async fn
    ...
  } finally {
    ...
  }
}   // <-- stray closing brace, no matching opener
```
Because this is a parse-time error, **the browser will refuse to execute any of `admin.js`** — not just this function. That means `DOMContentLoaded` never attaches, `googleSignInBtn` never gets its click handler, and the entire admin dashboard is currently non-functional in production. This has to be fixed before anything else here matters.

**Fix:** delete the orphaned block entirely (lines ~183–198 in your current file):
```js
async function handleGoogleSignIn() {
  ...
}

function showResetMessage(message, kind) {
  ...
```
i.e. just remove everything between the end of `handleGoogleSignIn` and the start of `showResetMessage`. `showResetMessage`/`hideResetMessage` can also be deleted if nothing else calls them now that the password-reset flow is gone (worth a quick `grep -n "showResetMessage\|hideResetMessage"` to confirm nothing else references them).

### 2. Admin's manual check-in button will now fail for every use
The `firestore.rules` check-in rule now requires the document ID to be exactly `memberId_dateKey`:
```js
allow create: if ... && checkinId == request.resource.data.memberId + '_' + request.resource.data.dateKey && ...
```
`member.js`'s self-check-in flow was correctly updated to match (`checkinsCol.doc(`${memberId}_${today}`).set({...})`) — but `manualCheckIn()` in `admin.js` was **not**:
```js
await checkinsCol.add({   // <-- random auto-ID, will never equal memberId_dateKey
  memberId: member.id,
  ...
});
```
This will hit `PERMISSION_DENIED` on every attempt once #1 above is fixed and the button becomes clickable again.

**Fix:**
```js
const checkinId = `${member.id}_${toDateKey(new Date())}`;
await checkinsCol.doc(checkinId).set({
  memberId: member.id,
  name: member.name,
  phone: member.phone,
  dateKey: toDateKey(new Date()),
  timestamp: firebase.firestore.FieldValue.serverTimestamp(),
  method: "manual",
  loggedBy: auth.currentUser ? auth.currentUser.email : null,
});
```

---

## 🟢 Confirmed Fixed — the actual security objective

I re-checked each finding from the previous two reports against the current files:

| Finding | Status |
|---|---|
| Admin impersonation via email/password auth (the headline privilege-escalation hole) | **Fixed.** `isVerifiedAdmin()` now requires `email_verified == true` **and** `sign_in_provider == 'google.com'`, in addition to the whitelist check. A `createUserWithEmailAndPassword` token can never satisfy this regardless of project settings. |
| Dead `handleLogin`/password sign-in code reachable from console | **Removed.** Confirmed via `grep` — no `signInWithEmailAndPassword`, `createUserWithEmailAndPassword`, or `handleLogin` remain in `admin.js`. (The syntax error above is a side-effect of this removal being incomplete, not a reintroduction of the hole.) |
| `paymentStatus`/`approved` escalation via direct `members.update()` | **Still correctly blocked**, and now sits behind the strengthened `isVerifiedAdmin()` — double-secured. |
| Fake `payments` records from non-admins | **Still correctly blocked**, same reasoning. |
| Duplicate/forged check-ins (no server-side one-per-day enforcement) | **Fixed correctly.** Composite doc ID (`memberId_dateKey`) is enforced in the rule, and `member.js`'s self-service check-in was updated to match it exactly. |
| No schema/type whitelist on member registration (DoS via bad field types) | **Fixed.** `keys().hasOnly([...])` plus explicit `is string` / `in [...]` checks on `name`, `address`, `plan`, `joinDate`, `expiryDate` are now in place. |
| Admin email case-sensitivity mismatch risk | **Improved.** Both the `admins` read rule and `isVerifiedAdmin()` now compare `.toLowerCase()` consistently, matching how `admin.js`'s own `isVerifiedAdmin(email)` UI-gating function normalizes email. |

---

## 🟡 Still open (carried over from the earlier reports, lower priority than the two blockers above)

- **Re-auth freshness (`auth_time`) is still not enforced in rules** for `delete`/`mark-paid`. The WebAuthn branch in `handleReauthSubmit` still isn't tied to any Firebase-verifiable claim — an unattended, already-authenticated admin session can still bypass the modal via direct console calls. This wasn't part of this round's ask, but it's the next real risk once the two bugs above are patched.
- **`allow get: if true` on `members` with phone-number doc IDs** is unchanged — still allows scripted PII harvesting by guessing/iterating phone numbers, no App Check or rate limiting in front of it.
- **No App Check** anywhere in the project.
- **`approved` has no relationship to `expiryDate`** — an expired member stays checkin-eligible until an admin manually revokes approval.
- Minor: `createdAt`/`updatedAt` are in the `hasOnly` whitelist but have no type/value constraint (e.g., `== request.time`), so a crafted request could still write arbitrary values into those two fields. Low impact — they're display/sort-only.

---

**Priority order:** fix #1 (syntax error) immediately — the site doesn't function at all right now — then #2 (manual check-in ID), then treat the 🟡 list as your next security iteration once the payment-tampering objective (which is now solid) is confirmed working end-to-end in a test environment.
