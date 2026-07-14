# NSNVC Contribution App - Deployment & Security Review

## Deployment

**Current URL**

https://enga018.github.io/nsnvc-contribution

The application is successfully deployed on GitHub Pages and the PWA functionality is working.

---

## What Is Working Well

- Progressive Web App (PWA) setup is configured correctly.
- Service worker caching is active.
- Offline access is available.
- Contribution ledger supports:
  - Charges
  - Payments
  - Deferred charges
  - Forgiven debt
  - Pending UPI payments
- Import/export backup functionality exists.
- Cache versioning is implemented (`nsnvc-tracker-v1.27.0`).

---

## Important Risks

### 1. Development Password in Production

The current login uses a hardcoded development password:

```javascript
"dev-mode-only"
```

Anyone who knows this password can access the admin panel.

### 2. Data Stored Only in Browser

All records are currently stored in `localStorage`.

If the phone is reset, browser data is cleared, or storage becomes corrupted, contribution records may be lost.

---

## Immediate Recommendation

Replace the development password with a strong private password until Firebase Authentication is enabled.

Example:

```javascript
"NSNVC@2026#Secure"
```

---

## Recommended Production Architecture

### Authentication

Use **Firebase Authentication** with:

- Email/password login
- Only authorized village council accounts
- Remove all hardcoded passwords

### Database

Use **Firestore** as the primary database.

Keep `localStorage` only for offline caching.

### Backups

Add automatic daily backups to Firestore or Firebase Storage.

---

## Service Worker Improvement

Current strategy: cache-first for all requests.

Recommended:

- `index.html` -> network-first
- Static assets -> cache-first

This ensures users receive new deployments more reliably.

---

## Suggested Folder Structure

```
/css
  styles.css

/js
  app.js
  db.js
  ui.js

/assets
  icons/

index.html
```

This will make it easier to maintain multiple village council deployments such as:

- nsnvc.enga.in
- vanchengte.enga.in
- other village portals

---

## Priority Order

1. Change development password
2. Enable Firebase Authentication
3. Migrate data to Firestore
4. Add automatic backups
5. Connect custom domain (`nsnvc.enga.in`)

---

## Overall Assessment

| Area | Score |
|------|------|
| UI/UX | 9/10 |
| Features | 9/10 |
| Security | 4/10 |
| Data Safety | 5/10 |
| Overall | 8/10 |

After Firebase Authentication and Firestore migration, the app would be suitable for official village council operations.