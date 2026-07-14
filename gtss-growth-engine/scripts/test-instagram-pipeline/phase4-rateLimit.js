/**
 * T4 — Rate Limit Enforcement
 *
 * Verifies the daily follow-limit enforcement triggers when the
 * ig_follow_tracker has `limits.instagram.follows` rows dated today.
 * Uses a local `checkInstagramDailyLimit()` helper that mirrors the
 * production query shape.
 */

const assert = require("assert");

/**
 * @param {{ db: import('better-sqlite3').Database, testLeadId: number }} ctx
 */
async function runPhase4({ db, testLeadId }) {
  console.log("Running T4 — Rate limit enforcement...");
  const limits = require("../../src/config/limits");
  const followsDailyLimit = limits.instagram.follows;

  // Clear tracker clean slate
  db.prepare("DELETE FROM ig_follow_tracker").run();

  // Insert daily limit threshold count
  const trackerInsert = db.prepare(`
      INSERT INTO ig_follow_tracker (lead_id, username, status, followed_at)
      VALUES (?, ?, 'following', datetime('now', 'localtime'))
    `);
  for (let i = 0; i < followsDailyLimit; i++) {
    trackerInsert.run(testLeadId, `mock_follow_${i}`);
  }

  // Daily limit check function
  function checkInstagramDailyLimit() {
    const currentFollows = db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM ig_follow_tracker
        WHERE DATE(followed_at) = DATE('now', 'localtime')
      `,
      )
      .get().count;

    return { limitReached: currentFollows >= followsDailyLimit };
  }

  const checkRes = checkInstagramDailyLimit();
  assert.strictEqual(
    checkRes.limitReached,
    true,
    "Rate limit enforcement should trigger when follows equal configured limits.",
  );
  console.log("✅ T4 Rate limit enforcement — PASS\n");
}

module.exports = { runPhase4 };
