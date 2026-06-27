"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeTotals,
  getEffectiveBalance,
  statusOf,
  unpaidPeriods
} = require("../logic.js");

/* Small helpers to build ledger entries the way the app stores them. */
const charge = (amount, opts = {}) => ({ type: "charge", amount, ...opts });
const payment = (amount, opts = {}) => ({ type: "payment", amount, ...opts });
const forgive = (amount) => ({ type: "forgive", amount });

test("computeTotals: empty ledger is all zero", () => {
  assert.deepEqual(computeTotals([]), {
    totalCharged: 0, totalPaid: 0, deferredTotal: 0, balance: 0
  });
});

test("computeTotals: handles missing/undefined ledger", () => {
  assert.deepEqual(computeTotals(undefined), {
    totalCharged: 0, totalPaid: 0, deferredTotal: 0, balance: 0
  });
});

test("computeTotals: charges minus payments give the balance", () => {
  const t = computeTotals([charge(100), charge(100), payment(150)]);
  assert.equal(t.totalCharged, 200);
  assert.equal(t.totalPaid, 150);
  assert.equal(t.balance, 50);
  assert.equal(t.deferredTotal, 0);
});

test("computeTotals: deferred charges count in totalCharged but are tracked separately", () => {
  const t = computeTotals([charge(100), charge(100, { deferred: true })]);
  assert.equal(t.totalCharged, 200, "deferred is still part of totalCharged");
  assert.equal(t.deferredTotal, 100);
  // balance includes deferred at the raw-total level (effective balance handles the exclusion)
  assert.equal(t.balance, 200);
});

test("computeTotals: forgiveness reduces the charged total and the balance", () => {
  const t = computeTotals([charge(100), forgive(40), payment(20)]);
  assert.equal(t.totalCharged, 60);
  assert.equal(t.totalPaid, 20);
  assert.equal(t.balance, 40);
});

test("computeTotals: deferred + partial payment + later forgiveness interact correctly", () => {
  const t = computeTotals([
    charge(100),
    charge(100, { deferred: true }),
    payment(30),
    forgive(20)
  ]);
  // active charged = 100 - 20 forgive = 80; deferred = 100
  assert.equal(t.deferredTotal, 100);
  assert.equal(t.totalCharged, 180);   // 80 active + 100 deferred
  assert.equal(t.totalPaid, 30);
  assert.equal(t.balance, 150);        // 180 - 30
});

test("getEffectiveBalance: excludes deferred charges (not yet due)", () => {
  // From computeTotals above: totalCharged 180, deferred 100, paid 30
  const c = { totalCharged: 180, deferredTotal: 100, totalPaid: 30 };
  // effective = (180 - 100) - 30 = 50
  assert.equal(getEffectiveBalance(c), 50);
});

test("getEffectiveBalance: tolerates missing fields", () => {
  assert.equal(getEffectiveBalance({}), 0);
});

test("statusOf: cleared when nothing effectively owed", () => {
  assert.equal(statusOf({ totalCharged: 100, totalPaid: 100 }), "paid");
});

test("statusOf: overpayment is still cleared", () => {
  assert.equal(statusOf({ totalCharged: 100, totalPaid: 120 }), "paid");
});

test("statusOf: partial when some paid but balance remains", () => {
  assert.equal(statusOf({ totalCharged: 100, totalPaid: 40 }), "partial");
});

test("statusOf: due when charged and nothing paid", () => {
  assert.equal(statusOf({ totalCharged: 100, totalPaid: 0 }), "due");
});

test("statusOf: fully-deferred household reads as cleared (nothing due yet)", () => {
  assert.equal(statusOf({ totalCharged: 100, deferredTotal: 100, totalPaid: 0 }), "paid");
});

/* ---- unpaidPeriods: FIFO allocation of unearmarked payments ---- */

test("unpaidPeriods: nothing paid means every charged period is owed", () => {
  const owed = unpaidPeriods([
    charge(100, { note: "JAN", createdAt: 1 }),
    charge(100, { note: "FEB", createdAt: 2 })
  ]);
  assert.deepEqual(owed, ["JAN", "FEB"]);
});

test("unpaidPeriods: a payment clears the oldest period first", () => {
  const owed = unpaidPeriods([
    charge(100, { note: "JAN", createdAt: 1 }),
    charge(100, { note: "FEB", createdAt: 2 }),
    payment(100, { createdAt: 3 })
  ]);
  assert.deepEqual(owed, ["FEB"]);
});

test("unpaidPeriods: full payment clears everything", () => {
  const owed = unpaidPeriods([
    charge(100, { note: "JAN", createdAt: 1 }),
    charge(100, { note: "FEB", createdAt: 2 }),
    payment(200, { createdAt: 3 })
  ]);
  assert.deepEqual(owed, []);
});

test("unpaidPeriods: a partial payment does NOT clear the period it falls short on", () => {
  const owed = unpaidPeriods([
    charge(100, { note: "JAN", createdAt: 1 }),
    charge(100, { note: "FEB", createdAt: 2 }),
    payment(50, { createdAt: 3 })
  ]);
  // 50 < 100, so JAN is not cleared and the leftover does not roll forward
  assert.deepEqual(owed, ["JAN", "FEB"]);
});

test("unpaidPeriods: deferred charges are skipped entirely", () => {
  const owed = unpaidPeriods([
    charge(100, { note: "JAN", createdAt: 1, deferred: true }),
    charge(100, { note: "FEB", createdAt: 2 })
  ]);
  assert.deepEqual(owed, ["FEB"]);
});

test("unpaidPeriods: allocation follows createdAt order, not array order", () => {
  const owed = unpaidPeriods([
    charge(100, { note: "FEB", createdAt: 2 }),
    payment(100, { createdAt: 3 }),
    charge(100, { note: "JAN", createdAt: 1 })
  ]);
  // chronologically JAN is oldest, so the payment clears JAN
  assert.deepEqual(owed, ["FEB"]);
});
