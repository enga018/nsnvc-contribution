# NSNVC Contribution App — UI/UX Changes

This file previously described a set of changes as already shipped and scored
them 9+/10. They weren't in `index.html` at the time — this revision
describes what's actually implemented, as of v1.28.0.

## Dashboard
- Summary cards: **Still to Collect, Overdue, Deferred, Overpaid** (2x2 grid)
- Filter dropdown replaced with segmented tabs, each showing a live count:
  `[ Pending N ] [ Overdue N ] [ Deferred N ] [ Overpaid N ] [ All N ]`

Pending/Deferred/Overpaid/All counts are computed synchronously from the live
citizen list. Overdue needs each pending household's ledger (which the app
doesn't keep in memory for everyone, to avoid an N+1 read on every dashboard
refresh — see `getAllLedgers()`'s cost), so it loads lazily in the background
a few seconds after the dashboard settles, or immediately if you open the
Overdue tab first. It shows "…" until that finishes.

---

## Citizen Details
- Renamed **MARK PAID → PAY FULL BALANCE**
- Added a financial breakdown panel: Overdue / Current Due / Deferred / Total
  Remaining (only shown when there's something to break down)
- Renamed **HISTORY → TRANSACTION HISTORY**

---

## Overdue logic (as actually implemented)

The original spec here compared `charge.period` strings directly
(`charge.period < currentPeriod`). That doesn't work in this app: period
names are free text typed by the admin (`MAY2`, `April 2026`, historical
imports, ...) with no consistent, sortable format — comparing them as
strings or trying to parse a shared ordering out of them silently produces
wrong answers when formats mix (verified against this repo's own seed data,
where a legacy `"April 2026"` charge and a `"MAY1"` charge sort backwards
under a naive numeric-suffix comparison).

Instead, Overdue/Current Due are derived from ledger order, not the period
label's text:

1. FIFO-allocate payments against non-deferred, non-excluded charges in
   chronological (`createdAt`) order — same rule `getEffectiveBalance()`
   already uses — to get each still-owed charge's remaining amount.
2. The **last** owed charge chronologically is **Current Due**.
3. Everything owed **before** it is **Overdue**.

This means "current" tracks whichever period was most recently charged to
that household, not the real-world calendar month — appropriate here since
the council bills in arrears and different households can be a period or two
apart.

---

## Not changed from the original mockup

Kept out of this pass as cosmetic-only and lower value relative to risk:
- Emoji → SVG icon replacement in transaction history
- Settings screen restyled as chevron nav rows (still plain buttons)
- Backup/Restore direction-arrow labels
- Overpaid color (still green/`--paid`, not blue — it's shared with the
  existing "Cleared" badge styling; splitting it out was more churn than the
  color swap was worth on its own)

Manage Periods' layout already matched the original description before this
pass (toggle + period name + edit icon, count/amount below) — no change
needed there.
