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
| `store.js` | **Data stores** (`makeLocalStore` / `makeFirebaseStore`), extracted in stage 2b. Handed a `host` object; identical `store.*` interface. |
| `tests/ledger.test.js` | Node unit tests for `ledger.js` (`npm run test:unit`). |
| `tests/errors.test.js` | Node unit tests for the Firebase error classifier. |
| `tests/smoke.spec.js` | Playwright browser smoke test (boots the app in local test mode). |
| `playwright.config.js` | Playwright config (starts `scripts/serve-for-tests.mjs`). |
| `scripts/serve-for-tests.mjs` | Dependency-free static server used by the smoke test. |
| `scripts/check-module-eval.mjs` | CI: executes the module's top-level code; fails on any runtime error it logs. |
| `package.json` | Marks `.js` as ES modules, defines the test scripts, pins Playwright. |
| `sw.js` | Service worker. Precache list + stale-while-revalidate strategy. |
| `manifest.json` | PWA manifest (name, icons, colours). |
| `VERSION` | The current version string. |
| `icon-192.png`, `icon-512.png` | PWA icons, referenced by `manifest.json`. |
| `scripts/sync-version.sh` | Writes the `VERSION` value into the footer and `sw.js`. |
| `scripts/check-version-sync.sh` | CI check that the three version strings match. |
| `.github/workflows/checks.yml` | CI: version sync, script parse, module eval, unit tests, browser smoke. |
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

- CI runs, in order of how much of the app they exercise:
  1. `scripts/check-scripts.mjs` — the inline scripts parse.
  2. `scripts/check-module-eval.mjs` — the module's top-level code actually
     executes, **and fails on any `ReferenceError` / "is not defined" logged
     during evaluation even if the app caught it** (this caught neither of the
     stage-2 bugs at the time; it does now).
  3. `node --test tests/ledger.test.js tests/errors.test.js` — ledger maths and
     the Firebase error classifier.
  4. `tests/smoke.spec.js` (Playwright) — boots the app in local mode and on the
     Firebase path and drives a login. Required check.
- `deferSource` on ledger entries is read but never written (always `null`).
- **Free-plan read quota.** The Firebase project is on the free (Spark) plan and
  has hit its daily limit more than once. The app now avoids needless full
  scans — `getAllLedgers()` caches a snapshot for `FULL_LEDGER_TTL_MS`, and
  `recalcAll()` only writes households whose totals changed. If the dashboard
  ever shows all zeros, suspect quota first: a raw
  `GET https://firestore.googleapis.com/v1/projects/nsnvc-contribution/databases/(default)/documents/citizens?pageSize=1`
  returning `429 RESOURCE_EXHAUSTED` confirms it. It resets at midnight Pacific
  Time. The app shows a "Data limit reached" screen in that case (see §7).
  Heavy actions to use sparingly: **Recalculate all balances** (always a full
  read scan), **backup/export**, and **bulk import**.


### Refactoring roadmap (splitting `index.html`)

Goal: shrink `index.html` so it is easier to maintain. Done so far:

| Stage | What moved | File(s) | Status |
| --- | --- | --- | --- |
| 0 | a map of the codebase | `MAINTAINERS.md` | ✅ |
| 1 | pure ledger engine (`calculateLedgerState`, defer resolution, normalizers, `periodKey`) | `ledger.js` + `tests/ledger.test.js` | ✅ |
| 2 | the two store factories (`makeLocalStore`, `makeFirebaseStore`) | `store.js` | ✅ done, but see the incident notes below |

Progress: `index.html` went from ~172 KB to ~125 KB. Stage 3 (UI/rendering)
is still outstanding — see the end of this section.

#### Stage 2 in detail (done)

The factories could not simply be moved: they closed over ~20 app-scope
identifiers, so they were first given a **host object** (stage 2a), then moved
(stage 2b). The signature is `makeLocalStore(host)` /
`makeFirebaseStore(fb, host)`, and `index.html` builds one `storeHost` and passes
it in.

Host contents (state is exposed as **getters** because the app *reassigns* it —
a plain snapshot would go stale):

```
ledgerCache, ledgerCacheSyncAt, periodStatsCache,
deferredPeriods, deferredPeriodUpdatedAt, deferredPeriodOverrides,
rawCitizens,
fullLedgerSnapshotAt, fullLedgerSnapshotCount, fullLedgerTtlMs,
writeDashboardCache, invalidateLedgerCache, invalidateStatsMemo,
nextDeferTimestamp, firestoreTimeMs,
recalcFromLedger, allocateLedgerPayments, getEffectiveBalance,
todayISO, entryLabel, esc, fmt
```

**Deliberate boundary — do not blur it:** `loadFirebase()` stays in
`index.html`. It loads the Firebase SDK and is app *startup glue*, not store
logic. It was accidentally moved into `store.js` during 2b (and left unexported),
which broke the whole app — see the incident notes.

#### Incidents caused by this refactor (read before doing stage 3)

Six of these reached production and took real debugging time. They are the
reason to move slowly, in small steps, with checks between each.

1. **`markSyncing is not defined`** (stage 2a). `markSyncing` is defined *inside*
   `makeFirebaseStore`, but it was briefly listed on `storeHost` as if it were a
   global. Evaluating `storeHost` threw and aborted the module. → `loadFirebase`
   and `markSyncing` are not host properties.
2. **`loadFirebase is not defined`** (stage 2b). It was moved into `store.js`
   **without an export**, so `index.html`'s call was `undefined`; Firebase never
   initialised and the app showed an error screen. The app's own try/catch hid
   it, and the module-eval check's output *contained the error* but was misread
   as sandbox noise.
3. **`Cannot access 'periodsReady' before initialization`** (1.33.7). A `let`
   was declared below a top-level read of it (dashboard cache-hydration path).
4. **`Cannot access 'syncPendingWrites' before initialization`** (1.33.8).
   `bootWithStore()` runs at top level and calls `renderSyncIndicator()`, which
   reads `syncPendingWrites` — but that `let` was declared *after* the call. The
   throw aborted the module mid-evaluation, so **everything** wired below it
   never ran: settings button listener, filter/search/period listeners, and the
   deferral-state sync. Symptoms looked unrelated (dead settings button,
   "deferred reversed", logout error) but all were one abort.
5. **`host.` prefix leaked into string literals** (1.33.9). Stage 2b's blanket
   `name → host.name` replace also rewrote **string literals**: `meta` doc ids
   became `"meta/host.deferredPeriods"` and `"meta/host.deferredPeriodOverrides"`.
   Defer writes, `deleteAll` and `importAll` then targeted documents nothing
   reads. Quoted `"host.x"` forms are unambiguous to find and fix.
6. **`updateDoc` NOT_FOUND on a never-created `meta` doc** (1.33.10). The firebase
   store wrote per-charge deferrals with `updateDoc`, which throws `NOT_FOUND`
   if the document doesn't exist. Because of incident 5, the real
   `meta/deferredPeriodOverrides` doc had never been created (reads tolerate a
   missing doc and return `{}`, so the app loaded, but the write failed). Fix:
   `setDoc` with an explicit `mergeFields` path creates the doc on first use.

All are now covered by CI where possible: `check-module-eval.mjs` fails on any
`ReferenceError` / `is not defined` / `is not a function` / `Cannot read propert`
/ `before initialization` / `Cannot access` message logged during evaluation,
even when the app swallows it. Incidents 5–6 were string/data bugs that
module-eval cannot catch — they need a real write test, so the smoke test
should eventually exercise a small Firestore write.

#### How to do the next extraction safely

1. **Move one coherent thing at a time** (one module per commit).
2. **Prefer pure code.** Anything that only transforms data (no DOM, no globals)
   can be tested in Node — that is why `ledger.js` was low-risk.
3. If it touches app state, **inject a host object** rather than reaching into
   globals; expose reassigned state as getters.
4. **Export everything you move.** Then grep `index.html` for the old name to
   confirm nothing still calls a bare identifier.
5. **Add the new file to `sw.js`'s `urlsToCache`**, or offline mode breaks.
6. Run the checks in order, and **do not skip the smoke test**:
   - `node scripts/check-scripts.mjs`
   - `node scripts/check-module-eval.mjs`
   - `node --test tests/ledger.test.js tests/errors.test.js`
   - `npx playwright test` (or let CI run it — it is a required check)
7. **Verify on a real browser against real data** before trusting it.

#### Stage 3: UI / rendering (outstanding)

Still in `index.html`: ~36 `render*` / `build*` / `attach*` / `open*` functions
plus the event wiring. This is the highest-risk part because it is tightly
coupled to the DOM and to element ids that only exist in the HTML at the top of
the file.

Suggested slicing, lowest risk first:

1. **Pure formatters** that take data and return strings
   (`buildCitizenCardHTML`, `renderEntryRow`, `renderHistoryRows`,
   `buildPeriodRowHTML`) — no DOM reads, easy to move and even unit-test.
2. **Sheet HTML builders** (`buildCitizenDetailHTML`, the `open*Sheet`
   helpers) — still string-building, but reference element ids.
3. **Event wiring / DOM mutation** last (`renderList`, `attach*Listeners`,
   `openCitizen`, `renderCitizenDetail`) — these read the DOM and are the most
   likely to break silently.

Anything that renders must keep working when a `store.*` call fails; the app
already has a blocking-failure screen for that (see §7) — reuse it rather than
inventing another.



---

## 9. Git conventions

- `main` is the deploy branch; pushing to it triggers Pages and the version check.
- Commit messages here use a short `type: summary` line (`feat:`, `fix:`,
  `perf:`, `ui:`, `chore:`, `refactor:`) plus a short body.
- Version: patch for fixes, minor for features/behaviour changes, major for
  breaking changes. Always bump for a deploy.
