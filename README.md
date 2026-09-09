# FitTrack QR Gym Manager

A two-sided gym management app:

- **`index.html`** — the public portal members reach by scanning a QR code at
  the entrance. New-member registration, "check my status" / daily check-in,
  and a mock online renewal payment.
- **`admin.html`** — the password-protected dashboard for the gym owner/
  trainer. Live attendance feed, full member directory, search, "Mark as
  Paid" for cash, and one-tap WhatsApp payment reminders.

No build step, no npm install — plain HTML/CSS/JS with Tailwind and Firebase
loaded from CDNs. Open the files directly or drop the folder on any static
host.

```
fittrack-qr-gym-manager/
├── index.html          # Member / public QR portal
├── admin.html          # Admin dashboard (auth-protected)
├── firestore.rules     # Firestore security rules to paste into console
├── js/
│   ├── firebase-config.js   # Shared config + helpers (EDIT THIS FIRST)
│   ├── member.js             # index.html logic
│   └── admin.js               # admin.html logic
└── README.md
```

## 1. Create your Firebase project (5 minutes)

1. Go to <https://console.firebase.google.com> → **Add project** → give it a
   name (e.g. "fittrack-gym") → finish the wizard (Google Analytics is
   optional, you can skip it).
2. Inside the project, click the **`</>`** (Web) icon to register a new web
   app. Give it a nickname — you do **not** need Firebase Hosting at this
   step. Firebase will show you a `firebaseConfig` object like:

   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "fittrack-gym.firebaseapp.com",
     projectId: "fittrack-gym",
     storageBucket: "fittrack-gym.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456789:web:abc123",
   };
   ```

3. Copy those values into `js/firebase-config.js` → `FIREBASE_CONFIG`.

## 2. Turn on Firestore

1. In the left sidebar: **Build → Firestore Database → Create database**.
2. Choose **Production mode** and pick a region close to your gym.
3. Once created, go to the **Rules** tab, delete the default contents, and
   paste in everything from `firestore.rules` in this repo. Click **Publish**.

## 3. Turn on Authentication (for the admin dashboard)

1. **Build → Authentication → Get started**.
2. Under **Sign-in method**, enable **Email/Password**.
3. Go to the **Users** tab → **Add user** → enter the gym owner's email and a
   password. This is the login for `admin.html`. You can add more staff
   accounts the same way — every one of them gets full admin access.

## 4. Customize gym details & plans

Open `js/firebase-config.js` and edit:

- `GYM_SETTINGS.name` — shown in both portal headers.
- `GYM_SETTINGS.currencySymbol` — defaults to `₹`.
- `GYM_SETTINGS.defaultCountryCode` — used to build correct `wa.me` WhatsApp
  links when a stored number is 10 digits (defaults to `91` for India — set
  to `1` for US/Canada, `44` for UK, etc.).
- `PLANS` — the membership plans offered (id, label, duration in months,
  price). Add or remove plans freely; both pages read from this object
  automatically.

## 5. Run it locally / test instantly

Because everything is static files, you can just open `index.html` and
`admin.html` directly in a browser to test (Firestore reads/writes will work
over the internet as soon as your config is filled in). For a closer-to-
production local test, serve the folder so relative paths behave exactly
like they will on a real host:

```bash
# from inside the fittrack-qr-gym-manager folder
python3 -m http.server 8080
# then visit http://localhost:8080/index.html and http://localhost:8080/admin.html
```

## 6. Deploy for real

Any static host works. The two easiest options:

**Firebase Hosting** (keeps everything in one place):
```bash
npm install -g firebase-tools
firebase login
firebase init hosting     # pick your existing project, public dir = this folder
firebase deploy
```

**Or** drag-and-drop the folder onto Netlify / Vercel / GitHub Pages — no
configuration needed since there's no build step.

Once deployed, generate a QR code (any free QR generator) that points to your
live `index.html` URL and print it for the gym entrance. Bookmark the
`admin.html` URL on the front-desk tablet/laptop.

## How data flows

- **Registration** (`index.html` → New Member tab) creates a document in the
  `members` collection with the phone number as the document ID, so lookups
  are instant and duplicates are naturally prevented.
- **Check Status / Check-In** (`index.html` → second tab) looks up that
  document, logs one row per member per day in `checkins` (used for the
  admin's live attendance feed), and shows Active/Expired + days remaining.
- **Mock renewal payment** updates the member's `expiryDate` /
  `paymentStatus` and appends a row to `payments` (used for the admin's
  monthly revenue widget). Swap the `confirmMockPayment()` function in
  `js/member.js` for a real gateway (Razorpay, Stripe, PayU, UPI intents,
  etc.) when you're ready to take real payments — every other part of the
  app is unaffected.
- **Admin dashboard** (`admin.html`) subscribes in real time (Firestore
  `onSnapshot`) to all three collections, so new registrations, check-ins,
  and payments appear instantly without refreshing.
- **WhatsApp reminders** open `https://wa.me/<number>?text=<message>` in a
  new tab with your default WhatsApp-enabled device — no WhatsApp Business
  API or paid integration required for this manual, one-tap flow.

## Notes & production hardening ideas

- The member portal is intentionally open (no login) since it's meant to be
  used anonymously via a QR scan — `firestore.rules` restricts it to
  create/read-own operations only. Consider adding
  [Firebase App Check](https://firebase.google.com/docs/app-check) to block
  traffic that isn't coming from your actual deployed page.
- For SMS-based OTP verification on check-in/registration, add Firebase
  Phone Auth — the current design trusts the phone number the member types.
  For a small local gym this is normally an acceptable trade-off for speed.
  Consider adding an OTP step here if you want stronger phone verification.
- To automate WhatsApp reminders (rather than a manual per-member tap), pair
  this with the official WhatsApp Business Platform API via a small Cloud
  Function triggered on a daily schedule.
