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

console.log("All inline scripts parse.");
