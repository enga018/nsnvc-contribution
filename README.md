# NSNVC Citizen Contribution Tracker

A lightweight web app for the **New Serchhip North Village Council (NSNVC)**, Mizoram, India, to track monthly citizen contributions (derived from MGNREGA wages) for each household. Admin-only — there is no public citizen-facing lookup.

**Live site:** https://enga018.github.io/nsnvc-contribution/

The app is a static PWA with a main `index.html` UI plus separate JavaScript modules for ledger rules and data stores. There is no build step or application server; GitHub Pages hosts the static files and Firebase provides authentication and Firestore data.

---

## What it does

There is no public-facing view — the app opens straight to the council login. An earlier citizen lookup/UPI flow was removed so Firestore does not need public read access to household data.

### For the council (admin, email/password login)

- Dashboard with **Still to collect** and household statistics.
- Filter households by **Pending / Paid / Deferred / All**. The main dashboard no longer has a period dropdown.
- Open any household to add a contribution, record a payment, **mark fully paid**, **forgive** part or all of a balance, or **defer** a charge.
- **Edit or delete** history entries; balances recompute from the ledger.
- **Manage Periods** for imported periods and deferral state.
- **Import from Excel**:
  - First-time historical register.
  - Monthly update files, with column/layout detection.
  - Bank payment files, with unmatched rows flagged.
  - Duplicate-period protection.
- **Export**:
  - Owing list as CSV.
  - Owing list as PDF.
  - All households as CSV.
  - Periods as CSV.
  - A selected period's contribution/payment detail.
- **Backup & restore**: download or restore the complete household/ledger backup.
- **Recalculate all balances** when a full rebuild is needed.

### Important balance rule

The effective outstanding balance is derived from the ledger:

**active charges + sanitation fees − payments − applicable waivers**

Charges that are currently deferred are excluded from the active amount to collect. Deferred amounts are therefore **not included in “Still to collect.”** If a deferred charge is restored, it becomes active again.

---

## Tech stack

- **Vanilla JavaScript** with ES modules
- **`index.html`** — application shell, UI, state, rendering and event wiring
- **`ledger.js`** — pure ledger/deferral engine
- **`store.js`** — local and Firebase data-store implementations
- **Firebase Firestore** — database
- **Firebase Authentication** — admin login
- **SheetJS (xlsx)** — Excel parsing, loaded on demand
- **GitHub Pages** — static hosting
- **Playwright / Node tests** — automated checks

The app has a local **test mode** with sample data when Firebase configuration is not present.

---

## Setup

### 1. Firebase

1. Create a Firebase project and enable **Firestore** and **Authentication → Email/Password**.
2. Add the authorized admin user under Authentication.
3. Copy the web app config into the `firebaseConfig` object in `index.html`.

The web Firebase API key is not a secret; Firestore security rules are what protect the data.

### 2. Firestore security rules

Use the admin-only rules in [`FIRESTORE_SECURITY_RULES.md`](FIRESTORE_SECURITY_RULES.md).

The production application has no public citizen view, so **do not use public Firestore read rules**.

### 3. Deploy

Commit the static files to the repo and enable GitHub Pages from the `main` branch.

---

## Data model

Each household is a document in the `citizens` collection, keyed by its full job card (with `/` encoded). It stores name, job card, cached totals and timestamps.

Ledger entries live in `citizens/{id}/ledger`:

- `charge` — a period contribution
- `payment` — money received (cash / bank / UPI)
- `forgive` — a waived amount
- `sanitationFee` — sanitation charge

A charge may be deferred. Deferral is resolved using the current whole-period and per-charge override state.

Balances are derived from the ledger; cached citizen totals are summaries and can be rebuilt with **Recalculate all balances**.

---

## Backups

The data lives in Firestore, so take backups regularly: **Admin → Backup / Restore → Download backup**. Backup files contain household information and payment history; store them securely.

---

## Notes

- Designed for low-end phones and patchy connectivity.
- The dashboard is cache-first and the application supports offline Firestore persistence when available.
- Current deployed version: **v1.34.0**.
