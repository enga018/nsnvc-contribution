# NSNVC VB-GRAMG Supabase storage

This folder contains the server-side import endpoint and the schema for the dedicated Supabase project `nevpvawkmnnafqnmbghb` (Mumbai region).

## Data boundary

- Firebase Authentication remains the sign-in provider.
- The VB-GRAMG importer sends the Firebase ID token to the Edge Function.
- The Edge Function verifies the token against the NSNVC Firebase project and checks the verified email against `public.vbgramg_admins`.
- The Edge Function uses the Supabase server-side service-role key; that key is never included in browser HTML.
- The browser has no direct table grants. RLS is enabled and `anon` / `authenticated` privileges are revoked on all VB-GRAMG tables.
- Only VB-GRAMG import snapshots are stored here. The contribution ledger remains in Firestore.

## Tables

- `vbgramg_imports`: snapshot metadata and status.
- `vbgramg_records`: records for each snapshot.
- `vbgramg_import_state`: singleton pointer to the active verified snapshot.
- `vbgramg_admins`: allowlist of Firebase verified-email addresses authorized to import/read.

See `schema/vbgramg-import-storage.sql` for the SQL schema. The schema has already been applied to the dedicated Supabase project; the file is retained for review and reproducibility.

## Edge Function

Function name: `vbgramg-import`

Actions:
- `active`: reads the active snapshot and verifies the number of rows against metadata.
- `save`: creates a staging snapshot, inserts records in batches, verifies the stored row count, marks metadata complete, then switches the active pointer. It only attempts to delete the prior snapshot after activation succeeds.

The function verifies Firebase ID tokens itself, so the Supabase gateway JWT check is disabled for this function. Do not remove the in-function token verification. The function must continue to check `vbgramg_admins` before any read or write.

## Admin allowlist

No admin email is seeded by default, so the function fails closed until the intended council admin's exact verified Firebase email is added to `public.vbgramg_admins`. Add only the approved admin account, in lowercase, and verify it matches the account used to sign into the existing tracker.

## Deployment / testing

1. Confirm the intended Firebase admin email is present in `vbgramg_admins`.
2. Confirm the deployed Edge Function version matches `functions/vbgramg-import/index.ts`.
3. Open the importer while signed in as the authorized admin; it should load an empty state until the first import.
4. Test an import and verify `vbgramg_imports.record_count` equals the row count in `vbgramg_records`.
5. Confirm `vbgramg_import_state.active_import_id` points to the completed snapshot.
6. Attempt an unauthenticated call and a signed-in non-allowlisted account; both must be rejected.
7. Confirm the existing contribution ledger still reads/writes through Firestore.

Do not merge the importer UI branch until the admin allowlist is configured and the end-to-end test passes.
