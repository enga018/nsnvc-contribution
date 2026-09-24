# Firestore Security Rules

**CRITICAL:** These rules must be deployed to your Firebase project before production deployment.

## Current Status
⚠️ **SECURITY RISK:** No rules configuration is included in this repository. Default Firestore rules allow ANY authenticated user to read/write all data.

## Recommended Security Rules

**Start here.** This is the minimum that keeps a signed-in treasurer fully
functional. It allows any authenticated user to read and write everything —
appropriate for a single-admin council app. (If a stricter ruleset is deployed
but its create/update type-checks don't match the app's real payloads, the app
loads fine but **every write silently fails** — that exact incident is logged
in MAINTAINERS.md, v1.33.9–1.33.11.)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

Publish the block above, then hard-refresh the app (Ctrl+Shift+R) and try a
write (defer a charge, record a payment). If a toast still shows a `(code)`,
report it — but with the rules above writes are allowed as long as you're
signed in.

### Optional hardening (only after basic writes are verified)

The stricter ruleset below is from the original template. Do **not** deploy it
blindly: it validates create/update payload field types, and if the app's real
payloads don't satisfy every condition (e.g. a missing numeric field on first
create), Firestore denies the write and the app reverts to "can't save".

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Only authenticated users can access
    match /{document=**} {
      allow read, write: if request.auth != null;
    }

    // Citizens data - authenticated users only
    match /citizens/{citizenId} {
      allow read, write: if request.auth != null;
      
      // Prevent data type injection
      allow create: if request.resource.data.name is string &&
                       request.resource.data.jobCard is string &&
                       request.resource.data.totalCharged is number &&
                       request.resource.data.totalPaid is number &&
                       request.resource.data.balance is number;
      
      allow update: if request.resource.data.name is string &&
                       request.resource.data.jobCard is string;
    }

    // Ledger entries - authenticated users only
    match /citizens/{citizenId}/ledger/{entryId} {
      allow read, write: if request.auth != null;
      
      // Validate entry structure
      allow create: if request.resource.data.type in ["charge", "payment", "forgive"] &&
                       request.resource.data.amount is number &&
                       request.resource.data.amount > 0;
      
      allow update: if request.resource.data.type in ["charge", "payment", "forgive"] &&
                       request.resource.data.amount is number &&
                       request.resource.data.amount > 0;
    }

    // Pending payments
    match /citizens/{citizenId}/pendingPayments/{paymentId} {
      allow read, write: if request.auth != null;
      
      allow create: if request.resource.data.amount is number &&
                       request.resource.data.amount > 0 &&
                       request.resource.data.status == "pending";
    }

    // Metadata - authenticated users only
    match /meta/{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

Before deploying here, verify in the Rules **Playground** (authentication:
"Firebase Auth", any UID) that a simulated write to a `citizens/{id}` document
containing only the fields the app's first create sends is **allowed** — if it
denies, weaken that block to plain `allow read, write: if request.auth != null;`.

## Deployment Instructions

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project (nsnvc-contribution)
3. Navigate to Firestore Database → Rules
4. Replace the default rules with the rules above
5. Click "Publish"

## Security Checklist

- [ ] Email/password authentication enabled in Firebase Auth
- [ ] Only authorized admin users have sign-in credentials
- [ ] Firestore security rules deployed (see above)
- [ ] No test mode credentials stored in production
- [ ] Backup files with PII are stored securely (use password encryption)
- [ ] Firebase API key has proper restrictions (optional, can limit to this domain)
- [ ] Regular security audits of Firestore usage and costs

## Authentication

- Uses Firebase Authentication with email/password
- Backend validates all Firestore writes with client-side validation
- No direct database access allowed - all operations go through authenticated Firestore SDK

## Data Sensitivity

⚠️ **Backup files contain PII:**
- Household names
- Phone numbers  
- Complete payment history

**Always use password encryption when downloading backups** to production environments.

## Multi-User Access (Future)

When adding multi-user/multi-school support:
- Add organization ID to data structure
- Restrict reads/writes by organization:
  ```
  allow read, write: if request.auth != null &&
                        request.resource.data.organizationId == 
                        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.organizationId;
  ```

## Questions or Issues?

If you find security issues in this application, please report them confidentially.
