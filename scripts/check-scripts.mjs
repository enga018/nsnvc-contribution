#!/usr/bin/env node
/*
 * Checks that index.html's inline scripts parse, and that the extracted
 * module can be loaded as an ES module.
 *
 * This catches syntax errors and (importantly) can be extended to catch more.
 * Note it does NOT execute the module (that needs a browser), so it can't
 * catch runtime errors like use-before-define in its temporal dead zone — those
 * still need a browser smoke test. See MAINTAINERS.md.
 *
 * Usage: node scripts/check-scripts.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");

const moduleMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!moduleMatch) {
  console.error("::error::Could not find the module <script> in index.html");
  process.exit(1);
}
const classicMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!classicMatches.length) {
  console.error("::error::Could not find any classic <script> in index.html");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "nsnvc-"));
const moduleFile = join(dir, "module.mjs");
writeFileSync(moduleFile, moduleMatch[1]);
classicMatches.forEach((m, i) => writeFileSync(join(dir, `classic${i}.js`), m[1]));

function syntaxCheck(file, label) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    console.log(`  ok  ${label}`);
  } catch (err) {
    console.error(`::error::${label} failed to parse`);
    console.error(err.stderr ? err.stderr.toString() : String(err));
    process.exit(1);
  }
}

console.log("Parsing inline scripts from index.html:");
syntaxCheck(moduleFile, "module script");
classicMatches.forEach((_, i) => syntaxCheck(join(dir, `classic${i}.js`), `classic script #${i + 1}`));

// Also verify the engine module parses.
syntaxCheck(join(root, "ledger.js"), "ledger.js");
syntaxCheck(join(root, "store.js"), "store.js");

/* ---------- storeHost assignment safety ----------
   Store factories are handed `storeHost`, whose reassignable state is exposed
   as accessors. If a property has only a `get` and store.js assigns to it
   (`host.<prop> = ...`), the assignment throws in strict mode:
   "Cannot set property <prop> of #<Object> which has only a getter".
   That silently broke every payment write once (v1.33.12 incident #8) before
   any Firestore call, with no error code on screen. Enforce that every
   property store.js writes to has a setter. */
const storeBlockMatch = html.match(/const storeHost\s*=\s*\{([\s\S]*?)\n\};/);
if (!storeBlockMatch) {
  console.error("::error::Could not locate the storeHost object in index.html");
  process.exit(1);
}
const storeBlock = storeBlockMatch[1];
const hostSetters = new Set([...storeBlock.matchAll(/set (\w+)\(/g)].map(m => m[1]));
const storeJs = readFileSync(join(root, "store.js"), "utf8");
const hostWrites = [...storeJs.matchAll(/host\.(\w+)\s*=/g)].map(m => m[1]);
const missing = [...new Set(hostWrites)].filter(p => !hostSetters.has(p));
if (missing.length) {
  console.error(`::error::store.js assigns to storeHost property${missing.length > 1 ? "ies" : ""} with no setter: ${missing.join(", ")}`);
  console.error("Add a matching `set` accessor to storeHost in index.html (see MAINTAINERS.md incident #8).");
  process.exit(1);
}
console.log(`  ok  storeHost setter check (${hostWrites.length} store.js writes, ${hostSetters.size} setters)`);

/* ---------- storeHost member presence ----------
   Same family as above, flipped: store.js READS `host.<name>` (host.setSyncPending,
   host.FIRESTORE_BATCH_SIZE, ...). If the name never existed on storeHost the
   call/read throws `X is not defined` / `Cannot read properties of undefined`
   at runtime, again before any Firestore work. Incident #9 — deferCharge died
   on `host.setSyncPending` missing until it was added. Every name store.js
   reads from host must be present on storeHost (as getter, setter or plain
   member). */
const hostMembers = new Set([
  ...[...storeBlock.matchAll(/(?:get|set)\s+(\w+)\(/g)].map(m => m[1]),
  ...[...storeBlock.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*,?\s*$/gm)].map(m => m[1]),
]);
const hostReads = [...storeJs.matchAll(/host\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]);
const unknown = [...new Set(hostReads)].filter(p => !hostMembers.has(p));
if (unknown.length) {
  console.error(`::error::store.js reads storeHost member${unknown.length > 1 ? "s" : ""} that do not exist on storeHost: ${unknown.join(", ")}`);
  console.error("Add each name to storeHost in index.html (getter, setter or plain member). See MAINTAINERS.md incident #9.");
  process.exit(1);
}
console.log(`  ok  storeHost member check (${hostReads.length} store.js reads, ${hostMembers.size} members)`);

console.log("All inline scripts parse.");
