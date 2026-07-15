/**
 * Regression: daily DM/action limits must only count successful sends.
 *
 * premium_required, identity/metadata failures, not_connected, etc. must NOT
 * burn the daily budget — otherwise a run of 20 premium walls falsely reports
 * "Daily limit reached" with zero DMs actually delivered.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const testDbPath = path.join(__dirname, "..", "data", "test_daily_limit_counting.db");

before(() => {
  process.env.DB_PATH = testDbPath;
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      fs.unlinkSync(testDbPath + suffix);
    } catch (_) {
      /* ignore */
    }
  }
});

after(() => {
  try {
    const { db } = require("../src/db/database");
    if (db) db.close();
  } catch (_) {
    /* ignore */
  }
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      fs.unlinkSync(testDbPath + suffix);
    } catch (_) {
      /* ignore */
    }
  }
});

test("getDailyActionCount ignores premium_required and failed outcomes", () => {
  const {
    getDb,
    getDailyActionCount,
    increment_action_count,
    isWithinLimit,
    outcomeCountsTowardLimit,
  } = require("../src/db/database");
  const { initializeDatabase } = require("../src/db/database");
  initializeDatabase();

  const db = getDb();
  db.prepare("DELETE FROM daily_actions").run();

  // Seed non-consuming outcomes that used to exhaust the budget incorrectly
  for (let i = 0; i < 25; i++) {
    db.prepare(
      `INSERT INTO daily_actions (platform, action_type, outcome, reason, performed_at)
       VALUES ('linkedin', 'dms', ?, ?, datetime('now', 'localtime'))`,
    ).run(
      i % 2 === 0 ? "premium_required" : "failed",
      i % 2 === 0
        ? "LinkedIn Premium required to message this profile"
        : "relationship metadata, not a real person's name",
    );
  }

  assert.equal(
    getDailyActionCount("linkedin", "dms"),
    0,
    "premium/failed rows must not count toward the daily limit",
  );
  assert.equal(
    isWithinLimit("linkedin", "dm"),
    true,
    "should still be within limit when no DMs were actually sent",
  );

  // Real sends DO count
  for (let i = 0; i < 3; i++) {
    assert.equal(increment_action_count("linkedin", "dm", null, "sent"), true);
  }
  assert.equal(getDailyActionCount("linkedin", "dms"), 3);
  assert.equal(getDailyActionCount("linkedin", "dm"), 3, "alias dm → dms");

  // Non-sent increments are no-ops (not inserted)
  assert.equal(
    increment_action_count(
      "linkedin",
      "dm",
      null,
      "premium_required",
      "Premium wall",
    ),
    false,
  );
  assert.equal(
    increment_action_count("linkedin", "dm", null, "failed", "metadata"),
    false,
  );
  assert.equal(
    getDailyActionCount("linkedin", "dms"),
    3,
    "non-sent increment_action_count must not insert rows",
  );

  assert.equal(outcomeCountsTowardLimit("sent"), true);
  assert.equal(outcomeCountsTowardLimit("premium_required"), false);
  assert.equal(outcomeCountsTowardLimit("failed"), false);
  assert.equal(outcomeCountsTowardLimit("not_connected"), false);
  assert.equal(outcomeCountsTowardLimit("skipped"), false);

  db.prepare("DELETE FROM daily_actions").run();
});

test("isWithinLimit only trips after real successful sends reach the cap", () => {
  const {
    getDb,
    getDailyLimits,
    isWithinLimit,
    increment_action_count,
  } = require("../src/db/database");
  const { initializeDatabase } = require("../src/db/database");
  initializeDatabase();

  const db = getDb();
  db.prepare("DELETE FROM daily_actions").run();

  // Ensure linkedin.dms limit is known (default from seeds / limits.js is 20)
  const limits = getDailyLimits();
  const dmLimit =
    typeof limits.linkedin?.dms === "number"
      ? limits.linkedin.dms
      : require("../src/config/limits").linkedin.dms;

  // Flood with non-sent noise
  for (let i = 0; i < dmLimit + 5; i++) {
    db.prepare(
      `INSERT INTO daily_actions (platform, action_type, outcome, performed_at)
       VALUES ('linkedin', 'dms', 'premium_required', datetime('now', 'localtime'))`,
    ).run();
  }
  assert.equal(isWithinLimit("linkedin", "dm"), true);

  // Exactly limit successful sends → over limit
  for (let i = 0; i < dmLimit; i++) {
    increment_action_count("linkedin", "dm", null, "sent");
  }
  assert.equal(
    isWithinLimit("linkedin", "dm"),
    false,
    `after ${dmLimit} real sends, daily limit should be reached`,
  );

  db.prepare("DELETE FROM daily_actions").run();
});
