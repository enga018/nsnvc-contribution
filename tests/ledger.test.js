// Unit tests for the pure ledger engine. Run with: npm test  (node --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setDeferralState, normalizeDeferredPeriodState, normalizeDeferredPeriodOverrides,
  isPeriodDeferredForCitizen, calculateLedgerState, allocateLedgerPayments,
  getOwedBreakdown, recalcFromLedger, periodKey, entryTimeMs, sortLedgerEntries
} from "../ledger.js";

const charge = (id, note, amount) => ({ entryId:id, type:"charge", note, amount });
const payment = (id, amount, note="cash") => ({ entryId:id, type:"payment", amount, note });

test("deferral is latest-wins", () => {
  const e = charge("E1","MAY1",500);

  setDeferralState({ deferredPeriods:["MAY1"], deferredPeriodUpdatedAt:{MAY1:1000}, deferredPeriodOverrides:{} });
  assert.equal(isPeriodDeferredForCitizen(e,"C1"), true, "bulk defer");

  setDeferralState({ deferredPeriods:["MAY1"], deferredPeriodUpdatedAt:{MAY1:1000}, deferredPeriodOverrides:{C1:{E1:{value:false,at:2000}}} });
  assert.equal(isPeriodDeferredForCitizen(e,"C1"), false, "later per-charge restore wins");

  setDeferralState({ deferredPeriods:["MAY1"], deferredPeriodUpdatedAt:{MAY1:3000}, deferredPeriodOverrides:{C1:{E1:{value:false,at:2000}}} });
  assert.equal(isPeriodDeferredForCitizen(e,"C1"), true, "even later bulk defer wins again");

  // Legacy override stored with at:0 must beat a 0-timestamp bulk defer (>=).
  setDeferralState({ deferredPeriods:["MAY1"], deferredPeriodUpdatedAt:{MAY1:0}, deferredPeriodOverrides:{C2:{E1:{value:false,at:0}}} });
  assert.equal(isPeriodDeferredForCitizen(e,"C2"), false, "legacy at:0 override wins tie");
});

test("deferred charges leave the balance but are tracked", () => {
  setDeferralState({ deferredPeriods:["MAY1"], deferredPeriodUpdatedAt:{}, deferredPeriodOverrides:{} });
  const entries = [charge("a","MAY1",500), charge("b","JUN",300), payment("c",100)];
  const st = calculateLedgerState(entries,"C1");
  assert.equal(st.totalCharged, 300);
  assert.equal(st.deferredRemaining, 500);
  assert.equal(st.balance, 200);
  assert.equal(allocateLedgerPayments(entries,"C1").balance, 200);
  assert.equal(getOwedBreakdown(entries,"C1").length, 1);
});

test("personal restore re-includes a charge", () => {
  setDeferralState({ deferredPeriods:["MAY1"], deferredPeriodUpdatedAt:{}, deferredPeriodOverrides:{C1:{a:{value:false,at:9}}} });
  const entries = [charge("a","MAY1",500), charge("b","JUN",300), payment("c",100)];
  const st = calculateLedgerState(entries,"C1");
  assert.equal(st.totalCharged, 800);
  assert.equal(st.deferredRemaining, 0);
  assert.equal(st.balance, 700);
});

test("waivers reduce active owed", () => {
  setDeferralState({});
  const st = calculateLedgerState([
    charge("x","JUL",500), { entryId:"y", type:"forgive", amount:200, note:"relief" }, payment("z",100)
  ],"C9");
  assert.equal(st.totalCharged, 500);
  assert.equal(st.appliedWaiver, 200);
  assert.equal(st.balance, 200);
  assert.equal(st.unappliedPayment, 0);
});

test("overpayment produces a negative balance and unapplied credit", () => {
  setDeferralState({});
  const st = calculateLedgerState([payment("p",900)],"C9");
  assert.equal(st.balance, -900);
  assert.equal(st.unappliedPayment, 900);
});

test("a sanitation fee flagged deferred is out of the balance", () => {
  setDeferralState({});
  const st = calculateLedgerState([{ entryId:"s", type:"sanitationFee", amount:150, deferred:true }],"C9");
  assert.equal(st.totalCharged, 0);
  assert.equal(st.deferredRemaining, 150);
});

test("recalcFromLedger writes the cached summary fields", () => {
  setDeferralState({ deferredPeriods:["MAY1"], deferredPeriodUpdatedAt:{}, deferredPeriodOverrides:{} });
  const rec = recalcFromLedger([charge("a","MAY1",500), charge("b","JUN",300), payment("c",100)],"C1");
  assert.deepEqual(rec, { totalCharged:800, totalPaid:100, balance:200, deferredTotal:500 });
});

test("normalization accepts legacy shapes and flags migration", () => {
  assert.equal(normalizeDeferredPeriodState(["MAY1"]).updatedAt.MAY1, 0);
  assert.equal(normalizeDeferredPeriodState(["MAY1"]).migrated, true);
  assert.equal(normalizeDeferredPeriodState({ periods:["A"] }).migrated, true);
  assert.equal(normalizeDeferredPeriodOverrides({ C1:["MAY1"] }).overrides.C1.MAY1.value, false);
});

test("periodKey sorts month buckets correctly", () => {
  assert.ok(periodKey("MAY1") < periodKey("MAY2"));
  assert.ok(periodKey("MAY2") < periodKey("JUN"));
  assert.equal(periodKey("MAY"), 50);
  assert.ok(periodKey("APRIL 2026") > periodKey("DEC"));
});

test("entryTimeMs accepts numbers, Firestore timestamps and missing values", () => {
  assert.equal(entryTimeMs({ createdAt: Date.now() }) > 0, true);
  // Firestore serverTimestamp comes back as { seconds, nanoseconds }.
  assert.equal(entryTimeMs({ createdAt: { seconds: 1700000000, nanoseconds: 500000000 } }), 1700000000500);
  assert.equal(entryTimeMs({ createdAt: 42 }), 42);
  assert.equal(entryTimeMs({}), 0);
  assert.equal(entryTimeMs(null), 0);
});

test("sortLedgerEntries handles mixed Firestore timestamps and numbers (newest first)", () => {
  // Firestore serverTimestamps come back as { seconds, nanoseconds } on the
  // epoch-seconds scale; freshly-created in-memory entries carry Date.now()
  // (epoch millis). Both scales are epoch-aligned, so seconds*1000 is
  // comparable with plain millis — that is exactly the mix that used to make
  // the sort a NaN no-op in the UI.
  const firebaseOld = { entryId:"a", createdAt:{ seconds:100, nanoseconds:500000000 } }; // 100500ms
  const localNew    = { entryId:"b", createdAt:200000 };                                 // 200000ms
  const missing     = { entryId:"c" };                                                   // 0
  const firebaseNew = { entryId:"d", createdAt:{ seconds:300, nanoseconds:0 } };         // 300000ms
  const sorted = sortLedgerEntries([firebaseOld, localNew, missing, firebaseNew]);
  // newest-first: d (300000) → b (200000) → a (100500) → c (0)
  assert.deepEqual(sorted.map(e=>e.entryId), ["d","b","a","c"]);
});

test("sortLedgerEntries can return oldest-first", () => {
  const a = { entryId:"a", createdAt:{ seconds:2, nanoseconds:0 } };
  const b = { entryId:"b", createdAt:{ seconds:1, nanoseconds:0 } };
  const sorted = sortLedgerEntries([a, b], false);
  assert.deepEqual(sorted.map(e=>e.entryId), ["b","a"]);
});
