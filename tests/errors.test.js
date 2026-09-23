// Unit tests for classifyFirebaseError (defined in index.html).
//
// A Firestore quota error (code "resource-exhausted" / HTTP 429) is NOT a
// connectivity problem, but the app used to report it as "check your internet".
// These tests pin the classification so that can't regress.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const src = (html.match(/function classifyFirebaseError\([\s\S]*?\n\}/) || [])[0];
if (!src) throw new Error("classifyFirebaseError not found in index.html");
const classifyFirebaseError = new Function(src + "\nreturn classifyFirebaseError;")();

test("quota errors are classified as quota, not connectivity", () => {
  assert.equal(classifyFirebaseError({ code: "resource-exhausted", message: "Quota exceeded." }), "quota");
  assert.equal(classifyFirebaseError({ code: "429", message: "Quota exceeded." }), "quota");
  assert.equal(classifyFirebaseError({ message: "8 RESOURCE_EXHAUSTED: Quota exceeded." }), "quota");
  // Firestore wraps server errors: outer code "unknown", real code on cause.
  assert.equal(classifyFirebaseError({ code: "unknown", cause: { code: "resource-exhausted" } }), "quota");
});

test("permission errors are distinct", () => {
  assert.equal(
    classifyFirebaseError({ code: "permission-denied", message: "Missing or insufficient permissions." }),
    "permission"
  );
});

test("genuine connectivity errors are classified as offline", () => {
  assert.equal(classifyFirebaseError({ code: "unavailable", message: "client is offline" }), "offline");
  assert.equal(classifyFirebaseError({ message: "TypeError: Failed to fetch" }), "offline");
  assert.equal(classifyFirebaseError({ message: "timeout after 15s" }), "offline");
});

test("anything else is unknown (and never guessed as quota)", () => {
  assert.equal(classifyFirebaseError({ code: "internal", message: "Something odd" }), "unknown");
  assert.equal(classifyFirebaseError(null), "unknown");
  assert.equal(classifyFirebaseError("Some random failure"), "unknown");
});
