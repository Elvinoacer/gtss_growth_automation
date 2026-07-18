/**
 * Setup helpers for the test-instagram-pipeline integration test suite.
 *
 * Extracted from the original scripts/test-instagram-pipeline.js monolith
 * (~627 lines) so each phase file (phase1-migration.js, phase2-discovery.js,
 * etc.) can re-use the same CDP endpoint helpers, DB cleanup, and server
 * handle.
 *
 * Side effects on require: loads dotenv, sets TEST_PORT /
 * DISABLE_BACKGROUND_JOBS env vars, and imports the programmatic server
 * (../src/server) so it boots on first require.
 *
 * Exports:
 *   - TEST_PORT
 *   - server                       — the http server instance from src/server
 *   - getDb                        — test database handle getter
 *   - getSharedCdpEndpoint()       — resolves the shared CDP endpoint URL
 *   - getPortFromEndpoint(endpoint)
 *   - isPortOpen(port)             — Promise<boolean>
 *   - ensureSharedCdpChrome(endpoint) — spawns launch-chrome.sh if needed
 *   - cleanupDb(db, leadId)        — purges mock integration test fixtures
 */

require("dotenv").config();
const path = require("path");
const { spawn } = require("child_process");
const net = require("net");

// Standard Test Port & Flag configuration to run server programmatically without worker crons
const TEST_PORT = process.env.PORT || 4567;
process.env.PORT = TEST_PORT;
process.env.DISABLE_BACKGROUND_JOBS = "true";

const { getDb } = require("../../src/db/database");
// Import Server Programmatically
const { server } = require("../../src/server");

function getSharedCdpEndpoint() {
  return (
    process.env.INSTAGRAM_CDP_ENDPOINT ||
    process.env.CDP_ENDPOINT ||
    `http://127.0.0.1:${process.env.CDP_PORT || process.env.BROWSER_CDP_PORT || 9222}`
  );
}

function getPortFromEndpoint(endpoint) {
  try {
    return Number(new URL(endpoint).port) || 9222;
  } catch (_) {
    const match = String(endpoint).match(/:(\d+)/);
    return match ? Number(match[1]) : 9222;
  }
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1000);
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
    socket.connect(port, "127.0.0.1", () => done(true));
  });
}

async function ensureSharedCdpChrome(endpoint) {
  const port = getPortFromEndpoint(endpoint);
  if (await isPortOpen(port)) return;

  // Optional skip for CI / machines without Chrome or Playwright browsers.
  if (
    process.env.TEST_NO_BROWSER_LAUNCH === "true" ||
    process.env.SKIP_CDP_CHROME === "true"
  ) {
    throw new Error(
      `Shared CDP Chrome is not listening on ${endpoint} and TEST_NO_BROWSER_LAUNCH/SKIP_CDP_CHROME is set. ` +
        `Start Chrome with --remote-debugging-port=${port}, or run: bash scripts/launch-chrome.sh`,
    );
  }

  console.log(
    `[cdp] Shared Chrome is not listening on ${endpoint}; starting the shared CDP launcher once...`,
  );
  const launcher = path.resolve(__dirname, "..", "launch-chrome.sh");
  if (!require("fs").existsSync(launcher)) {
    throw new Error(
      `Shared CDP Chrome did not become ready at ${endpoint}: launcher missing at ${launcher}. ` +
        `Install Google Chrome and run: bash scripts/launch-chrome.sh`,
    );
  }

  const child = spawn("bash", [launcher], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CDP_PORT: String(port) },
  });
  child.unref();

  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await isPortOpen(port)) return;
  }

  throw new Error(
    `Shared CDP Chrome did not become ready at ${endpoint}. ` +
      `Ensure Google Chrome is installed, then run: bash scripts/launch-chrome.sh\n` +
      `(Playwright's bundled Chromium is not used for CDP — this app attaches to real Chrome.)`,
  );
}

// Cleanup helper
function cleanupDb(db, leadId) {
  try {
    if (leadId) {
      db.prepare("DELETE FROM ig_warmup_sequences WHERE lead_id = ?").run(
        leadId,
      );
      db.prepare("DELETE FROM ig_follow_tracker WHERE lead_id = ?").run(leadId);
      db.prepare("DELETE FROM messages WHERE lead_id = ?").run(leadId);
      db.prepare("DELETE FROM leads WHERE id = ?").run(leadId);
    }
    db.prepare(
      "DELETE FROM leads WHERE ig_username = 'test_account_gtss'",
    ).run();
    db.prepare("DELETE FROM settings WHERE key = 'ig_blocked_until'").run();
  } catch (err) {
    console.error("[TEST CLEANUP] Warning during DB cleanup:", err.message);
  }
}

module.exports = {
  TEST_PORT,
  server,
  getDb,
  getSharedCdpEndpoint,
  getPortFromEndpoint,
  isPortOpen,
  ensureSharedCdpChrome,
  cleanupDb,
};
