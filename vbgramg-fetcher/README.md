# VB-GRAMG direct-fetch Worker

This optional Cloudflare Worker lets the NSNVC importer try a server-side request when Brave/browser fetch() is blocked by CORS. It retrieves only the fixed New Serchhip North report; it does not accept arbitrary URLs or forward browser cookies.

## Deploy

1. Sign in to Cloudflare and open **Workers & Pages**.
2. Create a Worker (a basic/Hello World Worker is fine).
3. Replace its sample code with the contents of `worker.js` from this folder and deploy.
4. Copy the deployed Worker HTTPS URL.
5. Open the NSNVC VB-GRAMG importer while signed in. Paste the Worker URL into **Optional server-side fetcher endpoint** and tap **Load Records**.

The Worker allows requests from `https://enga018.github.io`. For a local development preview, add that exact development origin to `ALLOWED_ORIGINS` before deploying.

## Important limitation

This is a diagnostic path, not a guarantee that the government site will allow server-side retrieval. If the upstream returns HTTP 401/403, a login/error page, or blocks the Worker, the importer will show an error. This Worker intentionally does not bypass authentication or access controls. If that happens, the next step is to investigate whether the official report needs a valid session or a different authorized retrieval route.

The importer remains read-only. It parses records in the browser and does not write to the contribution ledger.
