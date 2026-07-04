#!/usr/bin/env node
/**
 * validate-js.js — syntax-check every .js file we created under desktop/.
 *
 * We don't try to require() them (Electron and electron-updater aren't
 * installed in this environment) — we only parse them with `node --check`,
 * which catches syntax errors without executing.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "desktop");

const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith(".js")) files.push(p);
  }
}
walk(ROOT);

let failures = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    console.log(`✓ ${path.relative(ROOT, f)}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${path.relative(ROOT, f)}`);
    console.error(`  ${err.stderr?.toString().trim() || err.message}`);
  }
}

console.log(`\n${files.length - failures}/${files.length} files OK`);
process.exit(failures === 0 ? 0 : 1);
