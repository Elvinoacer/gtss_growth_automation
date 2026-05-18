process.env.DB_PATH = "./data/test_campaign_migrations.db";
const assert = require("assert");
const { getDb } = require("../src/db/database");
const { migrateCampaigns } = require("../scripts/migrate-campaigns");

async function runCampaignTest() {
  console.log("=== RUNNING CAMPAIGN MIGRATION INTEGRATION TEST ===");
  const db = getDb();

  // Ensure clean slate by dropping test artifacts if they exist
  try {
    db.exec(`
      DROP TABLE IF EXISTS campaign_events;
      DROP TABLE IF EXISTS dm_jobs;
      DROP TABLE IF EXISTS connection_jobs;
      DROP TABLE IF EXISTS campaigns;
    `);
  } catch (_) {}

  // 1. Run Migration first time
  console.log("Running migrateCampaigns first time...");
  migrateCampaigns();

  // 2. Run assertions on table existence
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  assert(tables.includes("campaigns"), "Table 'campaigns' was not created.");
  assert(tables.includes("connection_jobs"), "Table 'connection_jobs' was not created.");
  assert(tables.includes("dm_jobs"), "Table 'dm_jobs' was not created.");
  assert(tables.includes("campaign_events"), "Table 'campaign_events' was not created.");
  console.log("✅ T1: Table existence verified successfully.");

  // 3. Assert columns exist
  const dailyActionsCols = db.prepare("PRAGMA table_info(daily_actions)").all().map(c => c.name);
  assert(dailyActionsCols.includes("campaign_id"), "Column 'campaign_id' is missing in 'daily_actions'.");
  console.log("✅ T2: Column 'campaign_id' exists in 'daily_actions'.");

  // 4. Assert indexes exist
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(i => i.name);
  const expectedIndexes = [
    "idx_connection_jobs_campaign_id",
    "idx_connection_jobs_lead_id",
    "idx_dm_jobs_campaign_id",
    "idx_dm_jobs_lead_id",
    "idx_dm_jobs_message_id",
    "idx_campaign_events_campaign_id",
    "idx_campaign_events_lead_id",
    "idx_daily_actions_campaign_id"
  ];
  for (const idx of expectedIndexes) {
    assert(indexes.includes(idx), `Index '${idx}' was not created.`);
  }
  console.log("✅ T3: All high-performance indexes created successfully.");

  // 5. Test foreign key constraints
  db.pragma("foreign_keys = ON");
  try {
    db.prepare(`
      INSERT INTO connection_jobs (campaign_id, lead_id, status)
      VALUES (99999, 1, 'pending')
    `).run();
    assert.fail("Should have failed due to foreign key violation (campaign_id = 99999 does not exist).");
  } catch (err) {
    assert(err.message.includes("FOREIGN KEY constraint failed"), `Expected FOREIGN KEY failure, got: ${err.message}`);
    console.log("✅ T4: Foreign Key constraints enforce validation cleanly.");
  }

  // 6. Test Idempotency
  console.log("Running migrateCampaigns a second time to verify complete idempotency...");
  try {
    migrateCampaigns();
    console.log("✅ T5: Idempotency check passed (no duplicate or structural error thrown).");
  } catch (err) {
    assert.fail(`Idempotency check failed: ${err.message}`);
  }

  console.log("🎉 ALL CAMPAIGN MIGRATION TESTS PASSED SUCCESSFULLY!\n");
}

runCampaignTest().catch(err => {
  console.error("❌ CAMPAIGN MIGRATION TEST FAILED:", err);
  process.exit(1);
});
