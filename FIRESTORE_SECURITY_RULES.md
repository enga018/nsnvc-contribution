# Firestore Security Rules

These are the **production rules for the current NSNVC app**.

The app is admin-only. There is no public citizen lookup, so Firestore should not grant public read access to household data.

## Production rules

Replace `YOUR_ADMIN_EMAIL` with the email address used by the authorized NSNVC administrator:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    match /citizens/{cid} {
      allow read, write: if request.auth != null
        && request.auth.token.email == "YOUR_ADMIN_EMAIL";

      match /{sub=**} {
        allow read, write: if request.auth != null
          && request.auth.token.email == "YOUR_ADMIN_EMAIL";
      }
    }

    match /meta/{doc} {
      allow read, write: if request.auth != null
        && request.auth.token.email == "YOUR_ADMIN_EMAIL";

      // Collection-group queries for ledger and pending payments.
      // The app reads ALL ledgers / pending payments in one query
      // (store.js: collectionGroup("ledger"), collectionGroup("pendingPayments")).
      // Firestore only allows a collection-group query when a rule matches the
      // group itself, so these blocks are required.
      match /{path=**}/ledger/{doc} {
        allow read, write: if request.auth != null
          && request.auth.token.email == "YOUR_ADMIN_EMAIL";
      }

      match /{path=**}/pendingPayments/{doc} {
        allow read, write: if request.auth != null
          && request.auth.token.email == "YOUR_ADMIN_EMAIL";
      }
    }
  }
}
```

These rules cover citizen documents, their ledger/pending-payment subcollections, and the `meta` documents used by the app.

## Important

Do **not** deploy the old catch-all rule:

```
allow read, write: if request.auth != null;
```

That rule permits every authenticated Firebase user to access all NSNVC data. It is not the intended production configuration.

Likewise, do not use the old field-type validation template from earlier versions without testing it against the current application payloads. The app's ledger supports `charge`, `payment`, `forgive`, and `sanitationFee`, and metadata/deferred-state writes have evolved.

## Deployment

1. Open the Firebase Console for the NSNVC project.
2. Go to **Firestore Database → Rules**.
3. Replace the deployed rules with the production rules above.
4. Replace `YOUR_ADMIN_EMAIL` with the exact admin email.
5. Publish.
6. Sign in to the app and test a payment and a deferral.

If the app shows a save error after publishing, check the browser error strip and Firebase error code before changing the rules.

## Security checklist

- [ ] Email/password authentication enabled.
- [ ] Only the intended admin account has access.
- [ ] Admin-only Firestore rules are deployed.
- [ ] No public citizen lookup rules remain.
- [ ] Production Firebase configuration is used.
- [ ] Backup JSON files are stored securely because they contain household/payment data.

## Data sensitivity

Backups can contain household names, phone numbers and complete payment history. Treat them as sensitive administrative records.
