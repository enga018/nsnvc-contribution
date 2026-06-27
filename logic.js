/* ============================================================
   Pure contribution-ledger logic — single source of truth.

   Shared by index.html (browser) and the test suite (Node).
   In the browser this is loaded as a classic <script>, which
   exposes the functions as globals. In Node it is required as a
   CommonJS module. No dependencies, no build step.
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;          // Node / tests
  } else {
    Object.assign(root, api);      // Browser: expose as globals
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  /* Roll a ledger up into the stored totals. This is the money math:
     - charges add to totalCharged (deferred ones are tracked separately
       in deferredTotal but still included in totalCharged)
     - payments add to totalPaid
     - forgiven amounts reduce the charged total
     balance = everything charged − everything paid. */
  function computeTotals(ledger) {
    let tc = 0, tp = 0, dt = 0;
    for (const e of (ledger || [])) {
      if (e.type === "charge") {
        if (e.deferred) dt += e.amount;
        else tc += e.amount;
      } else if (e.type === "payment") {
        tp += e.amount;
      } else if (e.type === "forgive") {
        tc -= e.amount;
      }
    }
    return {
      totalCharged: tc + dt,
      totalPaid: tp,
      deferredTotal: dt,
      balance: (tc + dt) - tp
    };
  }

  /* What a citizen still owes today: charged (minus deferred, which
     isn't due yet) minus paid. */
  function getEffectiveBalance(c) {
    const deferredTotal = (c.deferredTotal || 0);
    const charged = (c.totalCharged || 0) - deferredTotal;
    return charged - (c.totalPaid || 0);
  }

  const statusLabel = { paid: "Cleared", partial: "Partly paid", due: "Due" };

  function statusOf(c) {
    const bal = getEffectiveBalance(c);
    if (bal <= 0) return "paid";
    if ((c.totalPaid || 0) > 0) return "partial";
    return "due";
  }

  /* Which periods are still unpaid, allocating unearmarked payments
     to charges oldest-first (FIFO). Deferred charges are skipped. */
  function unpaidPeriods(entries) {
    const chrono = [...entries].sort((a, b) => a.createdAt - b.createdAt);
    let pay = 0;
    for (const e of chrono) if (e.type === "payment") pay += (e.amount || 0);
    const owed = [];
    for (const e of chrono) {
      if (e.type !== "charge" || e.deferred) continue;
      if (pay >= (e.amount || 0)) { pay -= (e.amount || 0); }
      else { if (e.note) owed.push(e.note); pay = 0; }
    }
    return owed;
  }

  return { computeTotals, getEffectiveBalance, statusLabel, statusOf, unpaidPeriods };
});
