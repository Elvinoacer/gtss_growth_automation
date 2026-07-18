process.env.DB_PATH = "./data/test_connection_queue.db";
const assert = require("assert");
const { getDb } = require("../src/db/database");
const platformAdapter = require("../src/campaign/platformAdapter");
const platformPolicies = require("../src/config/platformPolicies");
const limits = require("../src/config/limits");
const queue = require("../src/campaign/connectionQueue");

// Capture original adapter function to prevent permanent pollution
const originalRunConnectionAction = platformAdapter.runConnectionAction;

async function runConnectionQueueTests() {
  console.log("=== RUNNING CONNECTION QUEUE TESTS ===");
  const db = getDb();
  db.pragma("foreign_keys = OFF");

  // ── Clean up any remnants of previous test runs ────────────────────────────
  db.prepare("DELETE FROM campaign_events WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM connection_jobs WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM dm_jobs WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM daily_actions WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM campaigns WHERE id = 9999").run();
  db.prepare("DELETE FROM leads WHERE id = 9999").run();

  // ── Setup Mock Campaign and Lead data ──────────────────────────────────────
  db.prepare(`
    INSERT INTO campaigns (id, name, platform, status, created_at)
    VALUES (9999, 'Test Queue Campaign', 'instagram', 'active', datetime('now', '-2 days'))
  `).run();

  db.prepare(`
    INSERT INTO leads (id, name, platform, status, profile_url, x_handle)
    VALUES (9999, 'Test Lead', 'instagram', 'qualified', 'https://instagram.com/test_queue_user', 'test_queue_user')
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

  // Disable active-window gating for success/failure paths so these tests are
  // hermetic regardless of wall-clock hour. T3 re-enables a closed window.
  const originalActiveWindow = platformPolicies.instagram.activeWindow;
  platformPolicies.instagram.activeWindow = null;

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 1: Connection Action Success & DM Job Promotion
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T1 — Connection Action Success & DM Job Promotion...");
  
  platformAdapter.runConnectionAction = async (platform, page, lead, msg, emit) => {
    return { outcome: "sent", error: null, metadata: { requestPending: false }, retryable: false };
  };

  const report1 = await queue.processConnectionQueue(mockPage, { skipDelays: true });
  
  assert.strictEqual(report1.processed, 1);
  assert.strictEqual(report1.success, 1);

  // Check database persistence states
  const jobState1 = db.prepare("SELECT status, retry_count FROM connection_jobs WHERE campaign_id = 9999").get();
  assert.strictEqual(jobState1.status, "sent", "Successful connection job should be updated to 'sent'.");

  const dmState1 = db.prepare("SELECT status FROM dm_jobs WHERE campaign_id = 9999").get();
  assert.strictEqual(dmState1.status, "scheduled", "Instagram connection success must promote pending DM job to 'scheduled'.");

  const eventCount1 = db.prepare("SELECT COUNT(*) as count FROM campaign_events WHERE campaign_id = 9999 AND event_type = 'dm_promoted'").get();
  assert(eventCount1.count > 0, "Event 'dm_promoted' should be recorded.");

  const dailyCount1 = db.prepare("SELECT COUNT(*) as count FROM daily_actions WHERE campaign_id = 9999").get();
  assert.strictEqual(dailyCount1.count, 1, "Connection outreach action must record to daily_actions.");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 2: Daily Outreach limits & Warmup Compliances
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T2 — Daily limits & Warmup Snoozing...");
  
  // Re-pending the connection job to run again
  db.prepare("UPDATE connection_jobs SET status = 'pending', retry_count = 0 WHERE campaign_id = 9999").run();
  db.prepare("UPDATE dm_jobs SET status = 'pending' WHERE campaign_id = 9999").run();

  // Temporarily customize Warmup limits for Instagram to guarantee block trigger
  const originalWarmup = platformPolicies.instagram.warmup;
  platformPolicies.instagram.warmup = {
    enabled: true,
    startDailyCount: 0, // 0 allows today
    dailyIncrement: 0,
    warmupDays: 10
  };

  const report2 = await queue.processConnectionQueue(mockPage, { skipDelays: true });

  assert.strictEqual(report2.processed, 0, "No jobs should be processed because daily limits are hit immediately.");
  
  const jobState2 = db.prepare("SELECT status, next_retry_at FROM connection_jobs WHERE campaign_id = 9999").get();
  assert.strictEqual(jobState2.status, "pending");
  assert(jobState2.next_retry_at !== null, "Job next_retry_at must be set when rate limit is hit.");

  // Restore Warmup policy
  platformPolicies.instagram.warmup = originalWarmup;

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 3: Active Window Hours Compliance
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T3 — Active Business Hours Window Compliance...");

  db.prepare("UPDATE connection_jobs SET status = 'pending', next_retry_at = NULL WHERE campaign_id = 9999").run();

  // Set operational window to be completely closed relative to "now".
  // Use a 1-hour window that starts one hour after the current hour so
  // the test is hermetic at any wall-clock time (including 23:00).
  const closedStart = (new Date().getHours() + 1) % 24;
  const closedEnd = (closedStart + 1) % 24;
  platformPolicies.instagram.activeWindow = {
    startHour: closedStart,
    endHour: closedEnd === 0 ? 24 : closedEnd,
    timezone: "local"
  };

  const report3 = await queue.processConnectionQueue(mockPage, { skipDelays: true });

  assert.strictEqual(report3.processed, 0, "Job must not be processed outside active hours window.");
  
  const jobState3 = db.prepare("SELECT status, next_retry_at FROM connection_jobs WHERE campaign_id = 9999").get();
  assert.strictEqual(jobState3.status, "pending");
  assert(jobState3.next_retry_at !== null, "Job must be snoozed with next_retry_at timestamp.");

  // Restore Active window limits
  // NOTE: we restore to `null` (not `originalActiveWindow`) so T4 — which
  // runs immediately after this and tests retry backoff, not active-window
  // compliance — is not gated by the real Instagram window (8–20 local).
  // On the Linux CI runner (UTC), a test run at 07:33 UTC would otherwise
  // snooze T4's job to the next business-hour window, producing
  // `processed=0` instead of the expected `processed=1`. The real
  // `originalActiveWindow` is restored in the final cleanup block below.
  platformPolicies.instagram.activeWindow = null;

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 4: Retry Backoff Schedule
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T4 — Failure Retry Backoffs...");

  db.prepare("UPDATE connection_jobs SET status = 'pending', next_retry_at = NULL, retry_count = 0 WHERE campaign_id = 9999").run();

  platformAdapter.runConnectionAction = async () => {
    return { outcome: "failed", error: "Connection Timeout", metadata: {}, retryable: true };
  };

  const report4 = await queue.processConnectionQueue(mockPage, { skipDelays: true });
  
  assert.strictEqual(report4.processed, 1);
  assert.strictEqual(report4.failed, 1);

  const jobState4 = db.prepare("SELECT status, retry_count, next_retry_at, error_message FROM connection_jobs WHERE campaign_id = 9999").get();
  assert.strictEqual(jobState4.status, "failed");
  assert.strictEqual(jobState4.retry_count, 1, "Retry count must be incremented on failures.");
  assert(jobState4.next_retry_at !== null, "Retry backoff time must be set.");
  assert.strictEqual(jobState4.error_message, "Connection Timeout");

  // ── Clean up Database after tests commit ───────────────────────────────────
  db.pragma("foreign_keys = OFF");
  db.prepare("DELETE FROM campaign_events WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM connection_jobs WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM dm_jobs WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM daily_actions WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM campaigns WHERE id = 9999").run();
  db.prepare("DELETE FROM leads WHERE id = 9999").run();
  db.pragma("foreign_keys = ON");

  // Restore adapter behaviors and policies
  platformAdapter.runConnectionAction = originalRunConnectionAction;
  platformPolicies.instagram.activeWindow = originalActiveWindow;

  console.log("🎉 ALL CONNECTION QUEUE TESTS PASSED SUCCESSFULLY!\n");
}

runConnectionQueueTests().catch(err => {
  console.error("❌ CONNECTION QUEUE TEST FAILED:", err);
  process.exit(1);
});
