#!/usr/bin/env node
/**
 * Cross-platform developer setup for gtss-growth-engine.
 *
 * Replaces setup.sh so `npm run setup` works on Windows (cmd/PowerShell),
 * macOS, and Linux without a bash dependency.
 *
 * Usage:
 *   node scripts/setup.js [passphrase]
 *   npm run setup
 *   npm run setup -- mypassphrase
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const passphrase = process.argv[2] || "gtss2026";

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function ensureDirs() {
  const dirs = [
    "data/browser-locks",
    "sessions",
    "profiles",
    "artifacts/automation",
    "media",
    "public/pages",
    "public/css",
    "public/js",
    "public/uploads",
  ];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
  }
}

console.log("Setting up encryption passphrase...");
run(process.execPath, [
  path.join(ROOT, "src", "utils", "setupPassphrase.js"),
  passphrase,
]);

console.log("Creating runtime directories...");
ensureDirs();

console.log("Setup complete. Run: npm start");
console.log(`(Default passphrase used: ${passphrase === "gtss2026" ? "gtss2026" : "(custom)"})`);
