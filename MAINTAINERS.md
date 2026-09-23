# NSNVC Contribution Tracker — Maintainer's Guide

A single-file progressive web app for tracking citizen contributions in
New Serchhip North village council. Deployed via GitHub Pages at
<https://enga018.github.io/nsnvc-contribution>.

This document is the map of the codebase: where things live, how the data is
shaped, and the rules that must not be broken. It exists so the app can be
maintained and (later) refactored safely.

---

## 1. Files

| File | Purpose |
| --- | --- |
| `index.html` | The app: styles, markup, and all UI/state/store/main-thread JavaScript. |
| `ledger.js` | **Pure ledger engine** (money + deferral rules). DOM-free, state-injected, unit-tested. |
| `tests/ledger.test.js` | Node unit tests for `ledger.js` (`npm test`). |
| `package.json` | Marks `.js` as ES modules (so Node can test `ledger.js`) and defines `npm test`. |
| `sw.js` | Service worker. Precache list + stale-while-revalidate strategy. |
| `manifest.json` | PWA manifest (name, icons, colours). |
| `VERSION` | The current version string. |
| `icon-192.png`, `icon-512.png` | PWA icons, referenced by `manifest.json`. |
| `scripts/sync-version.sh` | Writes the `VERSION` value into the footer and `sw.js`. |
| `scripts/check-version-sync.sh` | CI check that the three version strings match. |
| `.github/workflows/version-check.yml` | Runs the check on pushes/PRs touching `VERSION`/`index.html`/`sw.js`. |
| `.githooks/pre-commit` | Runs `sync-version.sh` before each commit. |
| `.githooks/post-commit` | Prompts for a version bump (interactive only). |
| `FIRESTORE_SECURITY_RULES.md` | The Firestore rules that should be deployed. |
| `README.md` | The end-user / deployment readme. |

### Versioning

Three strings must always agree:

1. `VERSION` (e.g. `1.31.2`)
2. `index.html` footer: `New Serchhip North Village Council · v1.31.2`
3. `sw.js`: `const CACHE_NAME = 'nsnvc-tracker-v1.31.2'`

The service worker only reinstalls when its bytes change, so **the cache name
must be bumped on any deploy that changes `index.html`/`manifest.json`**, or
installed PWAs keep serving the old shell. `scripts/sync-version.sh`
(sed-based) updates all three from `VERSION`; `check-version-sync.sh` enforces it.

---

## 2. `index.html` structure

The file is, in order:

1. `<head>` + a single minified `<style>` block (all CSS).
2. Static markup for `<header>`, `<main>` (login card, dashboard, detail
   container), `#modalRoot`, and `<footer>`.
3. A small **classic** `<script>` — installs global error handlers and a
   "did the module start?" watchdog.
4. One **module** `<script type="module">` (top-level `await`) containing the
   entire application.

Section banners inside the module (search for these):

| Banner | What it holds |
| --- | --- |
| `constants` | `CURRENCY`, debounce/delay constants, `FIRESTORE_BATCH_SIZE`. |
| `persistent dashboard cache` | IndexedDB read/write (`readDashboardCache`, `writeDashboardCache`, `hydrateDashboardCache`). |
| `helpers` | `fmt`, `$`, `esc`, date/period helpers, defer-resolution helpers, ledger math. |
| `Global State` | Module-level `let` variables (store, caches, period state). |
| `Offline / sync indicator` | The offline/syncing pill. |
| `Backup / Restore` | Encrypted backup download and restore. |
| `one-time maintenance` | A one-shot balance recalculation + meta cleanup. |

Other notable markers: `/* ---------- ADMIN AUTH ---------- */`,
`ADMIN — live citizen list + stats`, `ADMIN — citizen detail: all actions`,
`ADMIN — citizen detail: all actions`, upload/import/export blocks, and the
two store factories `makeLocalStore()` / `makeFirebaseStore()`.

### Global state (module scope)

```
store            // the active data store (local or firebase)
loggedIn, isLocalMode
citizensUnsub    // Firestore onSnapshot unsubscribe
allCitizens      // rows used for rendering (may carry `.ledger`)
rawCitizens      // the raw subscriber list (no `.ledger`)
ledgerCache      // Map<citizenId, entries[]>
periodStatsCache // memoised { periods, stats }
statsMemo / statsRevision  // memoised per-citizen balance/deferred
excludedPeriods  // REMOVED — do not reintroduce
deferredPeriods, deferredPeriodUpdatedAt, deferredPeriodOverrides
adminFilter, adminShown, adminFilteredList, periodFilter, unpaidCache, periodsReady
```

---

## 3. Data model

### 3.1 Citizen document — collection `citizens`, id = `fullKey(jobCard)`

`fullKey` = job card with `/` → `%2F` (e.g. `MZ-07-001-005-001%2F3`).

```
{
  jobCard, cardNo, name, phone,
  totalCharged, totalPaid, balance, deferredTotal,   // cached summaries
  createdAt, updatedAt                                // Timestamp
}
```

Ledger entries live in the subcollection `citizens/{id}/ledger`:

```
{
  entryId,                    // document id, also stored as a field
  type: "charge" | "payment" | "forgive" | "sanitationFee",
  amount,                     // positive number
  note,                       // period label for charges, or payment mode
  date,
  deferred,                   // boolean, set at creation/import (fallback only)
  createdAt                   // Timestamp / millis
}
```

Pending UPI payments: `citizens/{id}/pendingPayments`

```
{ id, amount, date, status: "pending" | "confirmed", createdAt }
```

### 3.2 Meta documents — collection `meta`

| Doc id | Shape | Meaning |
| --- | --- | --- |
| `deferredPeriods` | `{ periods: string[], updatedAt: { [period]: number } }` | Whole periods deferred. |
| `deferredPeriodOverrides` | `{ overrides: { [citizenId]: { [entryId]: { value, at } } } }` | Per-charge (and legacy per-period) defer overrides. |
| `imports` | `{ periods: string[] }` | Periods seen during imports (suggestions). |

> `meta/excludedPeriods` is obsolete (the exclusion feature was removed). A
> one-time maintenance step deletes it; do not read it.

Local (test) mode mirrors all of this under `localStorage["nsn_contrib_v1"]`.

---

## 4. The ledger engine (`ledger.js`) — the important rules

The money and deferral logic lives in **`ledger.js`**, a pure ES module with no
DOM or app-state dependency. `index.html` imports it at the top of its module
script. Every function that needs deferral state takes it from the injected
state object (see `setDeferralState`); `index.html` calls
`syncDeferralStateToEngine()` after updating its own `deferredPeriods` /
`deferredPeriodUpdatedAt` / `deferredPeriodOverrides` variables, so the engine
always resolves against the current state.

If you change these functions, run `npm test` first — `tests/ledger.test.js`
covers the rules below.

- `calculateLedgerState(entries, citizenId)` — the single source of truth for
  a household's money. Iterates entries; **payments and waivers are summed
  regardless of period**; charges/sanitation fees are counted as owed unless
  `isPeriodDeferredForCitizen(...)` is true. Returns
  `{ totalCharged, totalPaid, totalWaived, appliedWaiver, deferredRemaining,
  owed, activeRemaining, unappliedPayment, balance }`, where
  `balance = activeRemaining − totalPaid`.
- `allocateLedgerPayments` / `getOwedBreakdown` — FIFO allocation of payments
  to charges; exposes only active owed items.
- `recalcFromLedger(entries, citizenId)` — the cached summary
  (`totalCharged`, `totalPaid`, `balance`, `deferredTotal`) written back to the
  citizen doc after every change.
- `normalizeDeferredPeriodState` / `normalizeDeferredPeriodOverrides` — accept
  legacy shapes and flag migration.
- `periodKey` — rough month ordering for period labels.

`getEffectiveBalance` / `getDeferredAmount` / `statusOf` and the memoisation
stay in `index.html` (they read `c.ledger` and the stats cache), but they call
into the engine.

### 4.1 Defer resolution — "latest wins"

`isPeriodDeferredForCitizen(entry, citizenId)` decides whether a charge is out
of the active balance:

```
override   = per-charge override (entryId, else period note)
bulkAt     = deferredPeriodUpdatedAt[period] || 0
overrideAt = override ? override.at : -1

if (override && overrideAt >= bulkAt) return override.value   // personal wins (ties too)
if (period in deferredPeriods)        return true             // bulk defer
if (override)                         return override.value
return Boolean(entry.deferred)                               // creation/import flag
```

Timestamps come from `nextDeferTimestamp()`, a **monotonic session clock**
(strictly increasing) so two actions in the same millisecond can't tie.

Rules that must hold (learned the hard way):

- A **rename is not a new defer** — `handlePeriodsSave` carries the old
  period's `updatedAt` onto the new name.
- `setDeferredPeriods` must **not** stamp a timestampless period with "now";
  it preserves `0`. Stamping made renames look like fresh defers and silently
  overrode per-person restores.
- Only **Defer** removes a charge from the balance. There is no "exclude"
  feature any more.

---

## 5. Store interface

Both `makeLocalStore()` and `makeFirebaseStore()` expose the same API. Callers
only ever use `store.*`.

```
subscribe(cb)                    // live citizen list
listOwing()                      // citizens with effective balance > 0
getLedger(id) / exists(id)
addCitizen(id, d)
addEntry(id, type, amount, note, date, deferred?)
confirmPendingPayment(id, pendingId)
forgiveDebt(id, amount, note)
deleteEntry / editEntry / deleteCitizen / deleteAll
getPendingPayments()             // pending UPI rows (name/jobCard attached)
bulkAppendCharges / bulkAppendPayments
exportOwingCsv() / exportAll()   // CSV, backup JSON
importAll(backup, onProgress)    // restore
recalcAll(onProgress)            // rebuild summaries from ledgers
renamePeriod(old, new, onProgress)
refreshChangedLedgers(citizens) / getAllLedgers()
getDeferredPeriods / setDeferredPeriods
getDeferredPeriodOverrides / setDeferredPeriodOverrides / setCitizenChargeDeferred
getImportedPeriods / recordImportedPeriod
deleteMeta(name)
signIn / signOut / onAuth
```

### Performance rules

- **Never open a `ledger`/`pendingPayments` subcollection per household in a
  loop.** Use `collectionGroup("ledger")` /
  `collectionGroup("pendingPayments")` (single indexed query) and fall back to
  **batches of 20** only if the query is rejected. This was the app's biggest
  performance problem (see git history around v1.30.0/v1.31.2).
- Ledger reads are batched (`refreshChangedLedgers` chunks of 20) to avoid
  opening hundreds of reads at once on first login.
- The dashboard is **cache-first**: `refreshDashboard` renders from
  `ledgerCache` immediately, then refreshes in the background.

### Offline

`loadFirebase` initialises Firestore with `persistentLocalCache` +
`persistentMultipleTabManager` so the app reads from a local cache and queues
writes offline, syncing automatically. It falls back to the in-memory cache if
persistence is unavailable.

---

## 6. Caching layers (and how to invalidate them)

1. **`ledgerCache`** (`Map`) — in-memory ledgers.
2. **IndexedDB** — `writeDashboardCache`/`readDashboardCache` persist the
   citizen list and ledgers for fast cold start.
3. **`statsMemo`** — memoises `getEffectiveBalance`/`getDeferredAmount`
   per citizen, keyed by `statsRevision`.
4. **`periodStatsCache`** — memoised period list/stats for Manage Periods.

**Whenever ledger data or period/defer state changes, call the invalidators:**

```
invalidateLedgerCache(id?)   // clears ledgerCache entry + periodStatsCache + memo
periodStatsCache = null
invalidateStatsMemo()        // bumps statsRevision
```

There are ~16 call sites; if you add a mutation, add the invalidation too, or
the dashboard will show stale numbers. `writeDashboardCache(list, {})` is used
on every snapshot — **do not** pass the whole ledger cache there (it rewrites
every ledger to IndexedDB on every write).

---

## 7. Key flows

- **Login**: `login()` → `store.signIn` → `onAuth()` loads period/defer meta,
  hydrates the IndexedDB cache, starts `subscribeCitizens()`, and schedules the
  one-time maintenance.
- **Dashboard refresh**: snapshot → `scheduleDashboardRefresh()` (debounced) →
  `refreshDashboard()` → render cache-first, then `refreshChangedLedgers()`.
- **Rendering**: `renderStats`, `renderFilterTabs`, `renderList`,
  `buildCitizenCardHTML` (dashboard); `openCitizen` → `renderCitizenDetail` →
  `renderEntryRow` (person account).
- **Defer**: Manage Periods buttons (`togglePeriodDeferred`) and per-charge
  switches (`attachHistoryListeners` → `setCitizenChargeOverride`), both
  optimistic with rollback on write failure.
- **Backup/Restore**: `doBackup` → `store.exportAll` → optional AES-GCM
  encryption; `doRestore` → decrypt → `validateBackupSchema` →
  `store.importAll`.
- **Upload**: `openUpload`/`runUpload` map an Excel sheet to charges/payments
  via `bulkAppendCharges`/`bulkAppendPayments`.

---

## 8. Development & verification

There is **no build step and no dependency install**. To run locally:

```
python -m http.server 8080      # or any static server, then open /
```

The app runs in **local test mode** (localStorage + sample data, password
`dev-mode-only`) when `firebaseConfig` still contains `PASTE_HERE`, and switches
to Firebase once real config is pasted in.

### Safety checklist for a change

1. `node --check` the extracted module (it uses top-level `await`, so treat it
   as an ES module).
2. If you touch `ledger.js`, run `npm test`.
3. If you touch the defer rules, re-check §4.1.
4. If you add a new asset, add it to `sw.js`'s `urlsToCache` (or the fetch
   strategy), or offline mode breaks (this includes any new `.js` module).
5. Bump `VERSION` and run `scripts/sync-version.sh` so all three strings match.
6. Smoke-test on a real browser: dashboard, person account, defer, export
   (CSV/PDF), backup/restore, and an offline reload.

### Known gaps / next steps

- CI only checks version sync. Adding a `node --test` step (the ledger tests
  already exist) is the next improvement.
- `deferSource` on ledger entries is read but never written (always `null`).
- Remaining extraction candidates: the store layer and the UI/rendering code.
  Do those incrementally, with a real-browser smoke test between each.

---

## 9. Git conventions

- `main` is the deploy branch; pushing to it triggers Pages and the version check.
- Commit messages here use a short `type: summary` line (`feat:`, `fix:`,
  `perf:`, `ui:`, `chore:`, `refactor:`) plus a short body.
- Version: patch for fixes, minor for features/behaviour changes, major for
  breaking changes. Always bump for a deploy.
