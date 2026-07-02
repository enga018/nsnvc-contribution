# NSNVC Citizen Contribution Tracker

A lightweight web app for the **New Serchhip North Village Council (NSNVC)**, Mizoram, India, to track monthly citizen contributions (derived from MGNREGA wages) for each household — and let citizens look up their own balance.

**Live site:** https://enga018.github.io/nsnvc-contribution/

It is a single HTML file. No build step, no server of its own — just static hosting plus Firebase for data and admin login.

---

## What it does

### For citizens (public, no login)
- Look up a contribution balance by typing the **job card number** (the part after the slash is enough).
- See a clean statement: name, status (Cleared / Due / Partly paid), the amount still to pay, and a collapsible payment history (oldest first).
- Browse the list of households who still owe.
- **Pay Now (UPI):** opens the citizen's UPI app (GPay / PhonePe / Paytm) with the council's UPI ID and amount pre-filled. The council confirms the payment manually once it arrives.

### For the council (admin, email/password login)
- Dashboard with a single **"Still to collect"** figure (total outstanding + number of pending households).
- Filter households by **Pending / Paid / Deferred / All**, and by **period** ("Pending: January", etc.).
- Open any household to add a contribution, record a payment, **mark fully paid**, **forgive** part or all of a balance, or **defer** a charge (for someone still awaiting their wages).
- **Edit or delete** any history entry; balances recompute from the ledger automatically.
- **Import from Excel:**
  - First-time historical register (one-time, with a guard against duplicating existing data).
  - Monthly update file — detects the layout and asks you to confirm which column is the job card, name and amount, so fixed header names aren't required.
  - Bank payment file — records payments and flags rows it can't match.
  - A duplicate-period guard warns before re-importing a period already added.
- **Export** the owing list (with payment detail) as CSV.
- **Backup & restore:** download a full JSON backup of every household and its history, or restore from one.
- **Recalculate all balances** — rebuilds every total from its history if anything ever looks off.

---

## Tech stack

- **Vanilla JavaScript**, single `index.html` (no frameworks, no bundler)
- **Firebase Firestore** — database
- **Firebase Authentication** — admin login (email/password)
- **SheetJS (xlsx)** — Excel parsing, loaded on demand from a CDN
- **GitHub Pages** — free static hosting

The app runs in a local **test mode** with sample data if no Firebase config is present, so you can try the UI without a backend.

---

## Setup

### 1. Firebase
1. Create a Firebase project and enable **Firestore** and **Authentication → Email/Password**.
2. Add an admin user under Authentication.
3. Copy your web app config into the `firebaseConfig` object near the top of `index.html`:

   ```js
   const firebaseConfig = {
     apiKey: "…",
     authDomain: "YOUR_PROJECT.firebaseapp.com",
     projectId: "YOUR_PROJECT",
     storageBucket: "YOUR_PROJECT.firebasestorage.app",
     messagingSenderId: "…",
     appId: "…"
   };
   ```

   > The web `apiKey` is **not** a secret — it is meant to ship in client code. Access is controlled by Firestore security rules, not by hiding the key.

### 2. Firestore security rules
Public read (so citizens can look up balances), admin-only write:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    match /citizens/{cid} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.token.email == "YOUR_ADMIN_EMAIL";
      match /{sub=**} {
        allow read: if true;
        allow write: if request.auth != null && request.auth.token.email == "YOUR_ADMIN_EMAIL";
      }
    }

    match /meta/{doc} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.token.email == "YOUR_ADMIN_EMAIL";
    }

  }
}
```

Replace `YOUR_ADMIN_EMAIL` with your admin login email. The `meta` rule lets the duplicate-import guard remember which periods have been imported.

### 3. Deploy
Commit `index.html` to the repo and enable **GitHub Pages** (Settings → Pages → deploy from branch). The app is served from the repo's `index.html`.

---

## Data model (brief)

Each household is a document in the `citizens` collection, keyed by its full job card (with `/` encoded). It stores name, job card, totals (`totalCharged`, `totalPaid`, `balance`, `deferredTotal`) and a `ledger` subcollection of entries:

- `charge` — a period's contribution (can be `deferred`)
- `payment` — money received (cash / bank / UPI)
- `forgive` — a waived amount

Balances are derived from the ledger: effective balance = (charges excluding deferred) − payments. Payments are not tied to specific periods; the period filter applies them oldest-first (FIFO).

---

## Backups

The data lives only in Firestore, so **take a backup regularly**: Admin → Backup / Restore → Download backup. Keep the JSON file somewhere safe. Restore reads that file back. There is no automatic off-site backup.

---

## Notes

- Designed for low-end phones and patchy connectivity — minimal, fast, single file.
- Built and maintained for NSNVC, Mizoram.
