process.env.DB_PATH = "./data/test_campaign_utils.db";
const assert = require("assert");
const { getDb } = require("../src/db/database");
const utils = require("../src/campaign/utils/campaignUtils");

function testPureCalculations() {
  console.log("--- TEST PURE CALCULATIONS ---");

  // 1. Backoff calculation
  console.log("Testing calculateBackoffDelay...");
  const t1 = utils.calculateBackoffDelay(0, 1000, 10000);
  const d1 = new Date(t1) - Date.now();
  assert(d1 > 0 && d1 <= 2000, "Backoff for retry 0 should be around 1 second with jitter.");

  const t2 = utils.calculateBackoffDelay(3, 1000, 10000);
  const d2 = new Date(t2) - Date.now();
  assert(d2 > 0 && d2 <= 10000, "Backoff for retry 3 should be capped at 10 seconds.");
  console.log("✅ calculateBackoffDelay OK");

  // 2. Fingerprint stability
  console.log("Testing generateCampaignFingerprint...");
  const fp1 = utils.generateCampaignFingerprint("linkedin", 10, 20, "connection", 1);
  const fp2 = utils.generateCampaignFingerprint("LINKEDIN", 10, 20, "CONNECTION", 1);
  assert.strictEqual(fp1, fp2, "Fingerprint should be stable across case variations.");
  assert.strictEqual(fp1.length, 64, "Fingerprint must be a valid 64-character SHA-256 hex string.");
  console.log("✅ generateCampaignFingerprint OK");

  // 3. DM promotion
  console.log("Testing shouldPromoteToDm...");
  assert.strictEqual(utils.shouldPromoteToDm("replied", "sent"), true);
  assert.strictEqual(utils.shouldPromoteToDm("messaged", "accepted"), true);
  assert.strictEqual(utils.shouldPromoteToDm("messaged", "sent"), false);
  console.log("✅ shouldPromoteToDm OK");

  // 4. Outcome classification
  console.log("Testing classifyOutcome...");
  assert.deepStrictEqual(utils.classifyOutcome("Account Suspended for abuse"), { isTerminal: true, action: "fail" });
  assert.deepStrictEqual(utils.classifyOutcome("Network timeout happened"), { isTerminal: false, action: "retry" });
  console.log("✅ classifyOutcome OK");

  // 5. Next business window
  console.log("Testing getNextDayBusinessHourWindow...");
  const windowStr = utils.getNextDayBusinessHourWindow("instagram");
  const windowDate = new Date(windowStr);
  assert.strictEqual(windowDate.getHours(), 9, "Active window must start at 9 AM.");
  assert.strictEqual(windowDate.getMinutes(), 0, "Active window must start at 9:00 AM.");
  console.log("✅ getNextDayBusinessHourWindow OK");

  // 6. Queue Logging
  console.log("Testing queueLog...");
  const log = utils.queueLog("info", "test_queue", 101, "Test Message log", { meta: "test" });
  assert.strictEqual(log.level, "INFO");
  assert.strictEqual(log.queue, "TEST_QUEUE");
  assert.strictEqual(log.jobId, 101);
  assert.strictEqual(log.message, "Test Message log");
  assert.strictEqual(log.meta, "test");
  console.log("✅ queueLog OK");
}

function testSideEffectsAndTransactions() {
  console.log("--- TEST SIDE EFFECTS & TRANSACTIONS ---");
  const db = getDb();

  // Provision campaigns, connection_jobs, dm_jobs, campaign_events mock states
  try {
    db.exec(`
      DROP TABLE IF EXISTS campaign_events;
      DROP TABLE IF EXISTS dm_jobs;
      DROP TABLE IF EXISTS connection_jobs;
      DROP TABLE IF EXISTS campaigns;
    `);
  } catch (_) {}

  db.exec(`
    CREATE TABLE campaigns (id INTEGER PRIMARY KEY, status TEXT);
    CREATE TABLE connection_jobs (id INTEGER PRIMARY KEY, campaign_id INTEGER, lead_id INTEGER, status TEXT, error_message TEXT, updated_at DATETIME);
    CREATE TABLE dm_jobs (id INTEGER PRIMARY KEY, campaign_id INTEGER, lead_id INTEGER, message_id INTEGER, status TEXT, error_message TEXT, sent_at DATETIME, updated_at DATETIME);
    CREATE TABLE campaign_events (id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER, lead_id INTEGER, event_type TEXT, details_json TEXT);
  `);

  // Insert mock campaign
  db.prepare("INSERT INTO campaigns (id, status) VALUES (1, 'active'), (2, 'paused')").run();

  // Test isCampaignPaused
  assert.strictEqual(utils.isCampaignPaused(db, 1), false);
  assert.strictEqual(utils.isCampaignPaused(db, 2), true);
  assert.strictEqual(utils.isCampaignPaused(db, 999), true);
  console.log("✅ isCampaignPaused OK");

  // Test recordCampaignEvent
  utils.recordCampaignEvent(db, 1, 100, "test_event", { detail: "yes" });
  const evt = db.prepare("SELECT * FROM campaign_events WHERE campaign_id = 1").get();
  assert(evt, "Campaign event should be recorded.");
  assert.strictEqual(evt.event_type, "test_event");
  assert.strictEqual(JSON.parse(evt.details_json).detail, "yes");
  console.log("✅ recordCampaignEvent OK");

  // Setup connection and DM jobs mock data
  db.prepare("INSERT INTO connection_jobs (id, status) VALUES (10, 'pending')").run();
  db.prepare("INSERT INTO dm_jobs (id, status) VALUES (20, 'pending')").run();

  // Test Job status updates
  utils.updateConnectionJobStatus(db, 10, "sent", "no error");
  const connJob = db.prepare("SELECT * FROM connection_jobs WHERE id = 10").get();
  assert.strictEqual(connJob.status, "sent");
  assert.strictEqual(connJob.error_message, "no error");

  utils.updateDmJobStatus(db, 20, "sent", null, "2026-05-18");
  const dmJob = db.prepare("SELECT * FROM dm_jobs WHERE id = 20").get();
  assert.strictEqual(dmJob.status, "sent");
  assert.strictEqual(dmJob.sent_at, "2026-05-18");
  console.log("✅ updateConnectionJobStatus & updateDmJobStatus OK");

  // Test transaction safe execution and Rollback logic
  console.log("Testing runInTransaction with successful commit...");
  utils.runInTransaction(db, (txDb) => {
    txDb.prepare("UPDATE connection_jobs SET status = 'accepted' WHERE id = 10").run();
  });
  const connJobAfterTx = db.prepare("SELECT status FROM connection_jobs WHERE id = 10").get();
  assert.strictEqual(connJobAfterTx.status, "accepted", "Transaction updates should commit successfully.");

  console.log("Testing runInTransaction with error rollback...");
  try {
    utils.runInTransaction(db, (txDb) => {
      txDb.prepare("UPDATE connection_jobs SET status = 'failed' WHERE id = 10").run();
      throw new Error("Force Rollback Error");
    });
  } catch (err) {
    assert.strictEqual(err.message, "Force Rollback Error");
  }
  const connJobAfterRollback = db.prepare("SELECT status FROM connection_jobs WHERE id = 10").get();
  assert.strictEqual(connJobAfterRollback.status, "accepted", "Transaction updates should roll back successfully on error.");
  console.log("✅ runInTransaction & Rollback OK");
}

async function runTest() {
  console.log("=== RUNNING CAMPAIGN UTILS TEST SUITE ===");
  testPureCalculations();
  testSideEffectsAndTransactions();
  console.log("🎉 ALL CAMPAIGN UTILS TESTS PASSED SUCCESSFULLY!\n");
}

runTest().catch(err => {
  console.error("❌ CAMPAIGN UTILS TEST FAILED:", err);
  process.exit(1);
});
