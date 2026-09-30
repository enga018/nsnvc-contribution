import test from "node:test";
import assert from "node:assert/strict";
import {
  fmt,
  esc,
  todayISO,
  entryLabel,
  suffixOf,
  fullKey,
  seqNum,
  byCardNo,
  firestoreTimeMs
} from "../util.js";

test("fmt preserves Indian currency formatting", () => {
  assert.equal(fmt(123456), "₹1,23,456");
  assert.equal(fmt(0), "₹0");
});

test("esc escapes HTML-sensitive characters", () => {
  assert.equal(esc(`<a x='1'>&\"</a>`), "&lt;a x=&#39;1&#39;&gt;&amp;&quot;&lt;/a&gt;");
  assert.equal(esc(null), "");
});

test("todayISO returns an ISO calendar date", () => {
  assert.match(todayISO(), /^\d{4}-\d{2}-\d{2}$/);
});

test("entryLabel preserves transaction labels", () => {
  assert.equal(entryLabel({type:"payment", note:"cash"}), "Cash");
  assert.equal(entryLabel({type:"payment", note:"bank"}), "Bank");
  assert.equal(entryLabel({type:"forgive"}), "Waived");
  assert.equal(entryLabel({type:"return", note:"Return"}), "Return");
  assert.equal(entryLabel({type:"charge", note:"Return"}), "Return");
  assert.equal(entryLabel({type:"sanitationFee"}), "Sanitation Fee");
  assert.equal(entryLabel({type:"charge", note:"JAN26"}), "JAN26");
  assert.equal(entryLabel(null), "Unknown");
});

test("suffixOf and fullKey preserve storage-key behavior", () => {
  assert.equal(suffixOf("foo/bar/Baz"), "baz");
  assert.equal(fullKey("foo/bar"), "foo%2Fbar");
  assert.equal(fullKey("..."), "_");
  assert.equal(fullKey(""), "_");
});

test("seqNum and byCardNo sort card numbers numerically", () => {
  assert.equal(seqNum("JC-12"), 12);
  assert.equal(seqNum("none"), Number.MAX_SAFE_INTEGER);
  const rows = [{cardNo:"10",jobCard:"B"},{cardNo:"2",jobCard:"A"}];
  rows.sort(byCardNo);
  assert.deepEqual(rows.map(x => x.cardNo), ["2","10"]);
});

test("firestoreTimeMs handles supported timestamp shapes", () => {
  assert.equal(firestoreTimeMs(1234), 1234);
  assert.equal(firestoreTimeMs({seconds:12}), 12000);
  assert.equal(firestoreTimeMs({toMillis:() => 5678}), 5678);
  assert.equal(firestoreTimeMs(null), 0);
});
