# Firestore Security Rules

**CRITICAL:** These rules must be deployed to your Firebase project before production deployment.

## Current Status
⚠️ **SECURITY RISK:** No rules configuration is included in this repository. Default Firestore rules allow ANY authenticated user to read/write all data.

## Recommended Security Rules

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
