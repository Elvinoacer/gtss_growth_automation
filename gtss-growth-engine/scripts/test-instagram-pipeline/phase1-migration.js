/**
 * T1 — Migration Integrity
 *
 * Verifies the ig_warmup_sequences & ig_follow_tracker tables exist and the
 * leads table has all the required Instagram-specific columns
 * (ig_username, ig_follower_count, ig_following_count, ig_post_count,
 * ig_is_business, ig_business_category, ig_has_email, ig_has_phone, ig_bio,
 * ig_warmup_status).
 */

const assert = require("assert");

/**
 * @param {{ db: import('better-sqlite3').Database }} ctx
 */
async function runPhase1({ db }) {
  console.log("=== GTSS INSTAGRAM PIPELINE INTEGRATION TEST SUITE ===\n");
  console.log("Running T1 — Migration integrity...");
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((t) => t.name);
  assert(
    tables.includes("ig_warmup_sequences"),
    "Table 'ig_warmup_sequences' is missing.",
  );
  assert(
    tables.includes("ig_follow_tracker"),
    "Table 'ig_follow_tracker' is missing.",
  );

  const columns = db
    .prepare("PRAGMA table_info(leads)")
    .all()
    .map((c) => c.name);
  const expectedIgColumns = [
    "ig_username",
    "ig_follower_count",
    "ig_following_count",
    "ig_post_count",
    "ig_is_business",
    "ig_business_category",
    "ig_has_email",
    "ig_has_phone",
    "ig_bio",
    "ig_warmup_status",
  ];

  for (const col of expectedIgColumns) {
    assert(
      columns.includes(col),
      `leads table is missing the required Instagram column '${col}'.`,
    );
  }
  console.log("✅ T1 Migration — PASS\n");
}

module.exports = { runPhase1 };
