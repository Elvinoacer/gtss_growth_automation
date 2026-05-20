process.env.DB_PATH = "./data/test_dm_queue.db";
const assert = require("assert");
const { getDb } = require("../src/db/database");
require("../src/campaign/connectionQueue"); // Ensure schema upgrades run for connection_jobs
const platformAdapter = require("../src/campaign/platformAdapter");
const platformPolicies = require("../src/config/platformPolicies");
const limits = require("../src/config/limits");
const queue = require("../src/campaign/dmQueue");

// Capture original adapter function to prevent permanent pollution
const originalRunDmAction = platformAdapter.runDmAction;

async function runDmQueueTests() {
  console.log("=== RUNNING DM MESSAGING QUEUE TESTS ===");
  const db = getDb();
  db.pragma("foreign_keys = OFF");

  // ── Clean up any remnants of previous test runs ────────────────────────────
  db.prepare("DELETE FROM campaign_events WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM connection_jobs WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM dm_jobs WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM campaigns WHERE id = 9999").run();
  db.prepare("DELETE FROM leads WHERE id = 9999").run();
  db.prepare("DELETE FROM daily_actions WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM touchpoints WHERE lead_id = 9999").run();

  // ── Setup Mock Campaign and Lead data ──────────────────────────────────────
  db.prepare(`
    INSERT INTO campaigns (id, name, platform, status, created_at)
    VALUES (9999, 'Test DM Campaign', 'linkedin', 'active', datetime('now', '-2 days'))
  `).run();

  db.prepare(`
    INSERT INTO leads (id, name, platform, status, profile_url, x_handle)
    VALUES (9999, 'Test DM Lead', 'linkedin', 'qualified', 'https://linkedin.com/in/test_dm_user', 'test_dm_user')
  `).run();

  db.prepare(`
    INSERT INTO connection_jobs (campaign_id, lead_id, status, retry_count)
    VALUES (9999, 9999, 'pending', 0)
  `).run();

  db.prepare(`
    INSERT INTO dm_jobs (campaign_id, lead_id, status)
    VALUES (9999, 9999, 'pending')
  `).run();

  db.pragma("foreign_keys = ON");
  const mockPage = {};

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 1: LinkedIn Waiting Behavior (Gating)
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T1 — LinkedIn Waiting Gate (Not Accepted yet)...");
  
  platformAdapter.runDmAction = async (platform, page, lead, msg, emit) => {
    return { outcome: "sent", error: null, metadata: {}, retryable: false };
  };

  const report1 = await queue.processDmQueue(mockPage, { skipDelays: true, snoozeIntervalHours: 6 });
  
  assert.strictEqual(report1.processed, 0, "LinkedIn DM should not execute if connection status is 'pending'.");

  const dmState1 = db.prepare("SELECT status, scheduled_at FROM dm_jobs WHERE campaign_id = 9999").get();
  assert.strictEqual(dmState1.status, "scheduled");
  assert(dmState1.scheduled_at !== null, "LinkedIn DM should be snoozed/scheduled for later check.");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 2: LinkedIn DM Successful Execution & Multi-Table Data Sync
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T2 — LinkedIn Outreach Success & Atomic Data Sync...");

  // Update connection status to accepted so the gate opens!
  db.prepare("UPDATE connection_jobs SET status = 'accepted' WHERE campaign_id = 9999").run();
  // Set scheduled_at behind now so it is eligible to run
  db.prepare("UPDATE dm_jobs SET status = 'scheduled', scheduled_at = datetime('now', '-10 seconds') WHERE campaign_id = 9999").run();

  const report2 = await queue.processDmQueue(mockPage, { skipDelays: true });

  assert.strictEqual(report2.processed, 1);
  assert.strictEqual(report2.success, 1);

  // Assert DM Job updated
  const dmState2 = db.prepare("SELECT status, sent_at FROM dm_jobs WHERE campaign_id = 9999").get();
  assert.strictEqual(dmState2.status, "sent");
  assert(dmState2.sent_at !== null);

  // Assert Lead Status changed
  const leadState2 = db.prepare("SELECT status FROM leads WHERE id = 9999").get();
  assert.strictEqual(leadState2.status, "messaged", "Successful DM must update lead status to 'messaged'.");

  // Assert Touchpoints registered
  const touchpoint2 = db.prepare("SELECT type, outcome, notes FROM touchpoints WHERE lead_id = 9999").get();
  assert.strictEqual(touchpoint2.type, "dm");
  assert.strictEqual(touchpoint2.outcome, "sent");

  // Assert Daily Actions recorded
  const daily2 = db.prepare("SELECT COUNT(*) as count FROM daily_actions WHERE campaign_id = 9999 AND action_type = 'dm'").get();
  assert.strictEqual(daily2.count, 1);

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 3: Anti-Duplication spam blocker
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T3 — Anti-Duplication Spam Blocker...");

  // Make DM job pending/eligible again
  db.prepare("UPDATE dm_jobs SET status = 'pending', scheduled_at = datetime('now', '-10 seconds') WHERE campaign_id = 9999").run();

  const report3 = await queue.processDmQueue(mockPage, { skipDelays: true });

  assert.strictEqual(report3.processed, 0, "Outreach must skip execution because touchpoints history shows message was already sent.");
  assert.strictEqual(report3.skipped, 1);

  const dmState3 = db.prepare("SELECT status, error_message FROM dm_jobs WHERE campaign_id = 9999").get();
  assert.strictEqual(dmState3.status, "sent", "Duplicate job should be resolved to 'sent' to prevent repeating attempts.");
  assert.strictEqual(dmState3.error_message, "Duplicate message blocked");

  // Assert Campaign Events skips logged
  const eventCount3 = db.prepare("SELECT COUNT(*) as count FROM campaign_events WHERE campaign_id = 9999 AND event_type = 'dm_skipped'").get();
  assert(eventCount3.count > 0);

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 4: Failure Retry Backoffs
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T4 — Temporary Failures & Retry scheduling...");

  db.prepare("DELETE FROM touchpoints WHERE lead_id = 9999").run();
  db.prepare("UPDATE dm_jobs SET status = 'pending', retry_count = 0, error_message = NULL, scheduled_at = datetime('now', '-10 seconds') WHERE campaign_id = 9999").run();

  platformAdapter.runDmAction = async () => {
    return { outcome: "failed", error: "Message UI Locked", metadata: {}, retryable: true };
  };

  const report4 = await queue.processDmQueue(mockPage, { skipDelays: true });

  assert.strictEqual(report4.processed, 1);
  assert.strictEqual(report4.failed, 1);

  const dmState4 = db.prepare("SELECT status, retry_count, next_retry_at, error_message FROM dm_jobs WHERE campaign_id = 9999").get();
  assert.strictEqual(dmState4.status, "failed");
  assert.strictEqual(dmState4.retry_count, 1);
  assert(dmState4.next_retry_at !== null);
  assert.strictEqual(dmState4.error_message, "Message UI Locked");

  // ── Clean up Database after tests commit ───────────────────────────────────
  db.pragma("foreign_keys = OFF");
  db.prepare("DELETE FROM campaign_events WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM connection_jobs WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM dm_jobs WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM campaigns WHERE id = 9999").run();
  db.prepare("DELETE FROM leads WHERE id = 9999").run();
  db.prepare("DELETE FROM daily_actions WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM touchpoints WHERE lead_id = 9999").run();
  db.pragma("foreign_keys = ON");

  // Restore adapter behaviors
  platformAdapter.runDmAction = originalRunDmAction;

  console.log("🎉 ALL DM MESSAGING QUEUE TESTS PASSED SUCCESSFULLY!\n");
}

runDmQueueTests().catch(err => {
  console.error("❌ DM MESSAGING QUEUE TEST FAILED:", err);
  process.exit(1);
});
