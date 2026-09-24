#!/usr/bin/env node
/*
 * Evaluates index.html's module script under Node with minimal DOM stubs.
 *
 * This catches TOP-LEVEL runtime errors — e.g. a ReferenceError from
 * storeHost referencing something that doesn't exist, or reading a `let` before
 * its declaration. It is exactly the class of bug that `node --check` and the
 * unit tests cannot see, and that once shipped as "store never became ready".
 *
 * It cannot run the whole app (no real DOM, no network for the Firebase CDN),
 * so it only proves the module evaluates up to its first browser-only call.
 * The browser smoke test (tests/smoke.spec.js) is the full check.
 *
 * Usage: node scripts/check-module-eval.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const mod = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!mod) {
  console.error("::error::Could not find the module <script> in index.html");
  process.exit(1);
}

// The module is a folder-mate of ledger.js and expects ES-module semantics.
const dir = mkdtempSync(join(tmpdir(), "nsnvc-eval-"));
writeFileSync(join(dir, "module.mjs"), mod[1]);
writeFileSync(join(dir, "ledger.js"), readFileSync(join(root, "ledger.js")));
writeFileSync(join(dir, "store.js"), readFileSync(join(root, "store.js")));
writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));

const noop = () => {};
const el = () => ({
  classList: { add: noop, remove: noop, toggle: noop },
  style: {}, dataset: {}, appendChild: noop, insertAdjacentHTML: noop,
  addEventListener: noop, remove: noop, querySelector: () => null,
  querySelectorAll: () => [], setAttribute: noop, focus: noop,
  innerHTML: "", textContent: "", value: ""
});
// Node 20+ defines some of these as read-only getters (e.g. `navigator` became
// read-only in Node 22), so use defineProperty rather than assignment.
function define(name, value) {
  try { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); }
  catch { /* already non-configurable; the check will report a real failure */ }
}
define("window", globalThis);
define("document", {
  getElementById: () => el(), querySelector: () => el(),
  querySelectorAll: () => [], createElement: () => el(),
  body: el(), head: el(), addEventListener: noop
});
define("navigator", { onLine: true });
define("localStorage", { getItem: () => null, setItem: noop, removeItem: noop });
define("addEventListener", noop);
define("location", { reload: noop });
define("scrollTo", noop);
// Any dynamic import of the Firebase CDN will fail in Node; that's fine — we
// only care that the module's own top-level code evaluated first.
define("fetch", () => Promise.reject(new Error("no network in evaluation")));

// Capture console output. A ReferenceError/TypeError ("X is not defined") that
// the app's own try/catch swallows is still a real bug — that is exactly how the
// stage-2b extraction shipped "loadFirebase is not defined" and showed users an
// error screen. Fail on any such message even if evaluation completes.
const suspicious = [];
for (const level of ["error", "warn", "log"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    const text = args.map(a => (a && a.stack) ? a.stack : (a && a.message) ? a.message : String(a)).join(" ");
    if (/is not defined|ReferenceError|is not a function|Cannot read propert|before initialization|Cannot access/i.test(text)) {
      suspicious.push(text.split("\n")[0].slice(0, 200));
    }
    original(...args);
  };
}

// Evaluate the module. The module sets window.__nsnvcBootComplete as its LAST
// top-level statement, so we assert on that positive signal instead of trying to
// classify whatever error a browser-only call happens to throw in Node.
try {
  await import(pathToFileURL(join(dir, "module.mjs")).href);
} catch (e) {
  // A throw is fine ONLY if the module still reached its final statement
  // (i.e. everything above ran). Anything else is a real top-level error.
  if (!globalThis.__nsnvcBootComplete) {
    console.error("::error::index.html module threw during evaluation:");
    console.error(`  ${e && e.name}: ${(e && e.message) || e}`);
    if (e && e.stack) console.error(e.stack.split("\n").slice(0, 6).join("\n"));
    process.exit(1);
  }
}

if (suspicious.length) {
  console.error("::error::the module logged a runtime error while evaluating:");
  for (const s of [...new Set(suspicious)]) console.error("  " + s);
  console.error("  (these are real bugs even though the app caught them)");
  process.exit(1);
}

if (!globalThis.__nsnvcBootComplete) {
  console.error("::error::index.html module did not reach its final statement");
  console.error("  (window.__nsnvcBootComplete was never set — top-level code did not complete)");
  process.exit(1);
}
console.log("module evaluated to completion (reached its final statement)");
