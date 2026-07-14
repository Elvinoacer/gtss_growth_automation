/**
 * T5 — Block Detection
 *
 * Verifies setInstagramBlockedUntil(24) and isInstagramBlocked() drive the
 * ig_blocked_until settings key correctly: after setting the block,
 * isInstagramBlocked() returns blocked:true; after deleting the settings key,
 * it returns blocked:false.
 */

const assert = require("assert");

/**
 * @param {{ db: import('better-sqlite3').Database }} ctx
 */
async function runPhase5({ db }) {
  console.log("Running T5 — Block detection...");
  const {
    setInstagramBlockedUntil,
    isInstagramBlocked,
  } = require("../../src/automation/browserBase");

  // Set block
  setInstagramBlockedUntil(24);
  let blockCheck = isInstagramBlocked();
  assert.strictEqual(
    blockCheck.blocked,
    true,
    "Instagram should return blocked: true after triggering blocks.",
  );

  // Clear block
  db.prepare("DELETE FROM settings WHERE key = 'ig_blocked_until'").run();
  blockCheck = isInstagramBlocked();
  assert.strictEqual(
    blockCheck.blocked,
    false,
    "Instagram should return blocked: false after database key cleanup.",
  );
  console.log("✅ T5 Block detection — PASS\n");
}

module.exports = { runPhase5 };
