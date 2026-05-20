process.env.DB_PATH = "./data/test_campaign_integrity.db";
require("dotenv").config();
const assert = require("assert");

// Mock session notification service cache to capture and verify triggers
const notificationServicePath = require.resolve("../src/services/notificationService");
const notificationServiceMock = {
  sent: [],
  async sendNotification(subject, text) {
    notificationServiceMock.sent.push({ subject, text });
    return true;
  }
};
require.cache[notificationServicePath] = {
  id: notificationServicePath,
  filename: notificationServicePath,
  loaded: true,
  exports: notificationServiceMock
};

const { getDb } = require("../src/db/database");
const platformAdapter = require("../src/campaign/platformAdapter");
const platformPolicies = require("../src/config/platformPolicies");
const limits = require("../src/config/limits");
const connectionQueue = require("../src/campaign/connectionQueue");
const dmQueue = require("../src/campaign/dmQueue");
const backgroundJobs = require("../src/jobs/backgroundJobs");

// Store original adapter layers to restore post-testing
const originalRunConnectionAction = platformAdapter.runConnectionAction;
const originalRunDmAction = platformAdapter.runDmAction;

async function runCampaignIntegrityTests() {
  console.log("=== RUNNING CAMPAIGN INTEGRITY & RELIABILITY INTEGRATION TESTS ===");
  const db = getDb();
  
  // Disable foreign keys temporarily for clean setup
  db.pragma("foreign_keys = OFF");
  
  const cleanup = () => {
    db.prepare("DELETE FROM campaign_events WHERE campaign_id >= 9900").run();
    db.prepare("DELETE FROM connection_jobs WHERE campaign_id >= 9900").run();
    db.prepare("DELETE FROM dm_jobs WHERE campaign_id >= 9900").run();
    db.prepare("DELETE FROM campaigns WHERE id >= 9900").run();
    db.prepare("DELETE FROM leads WHERE id >= 9900").run();
  };
  cleanup();

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 1: Startup Sweeper & Persistent Advisory Lock Reset
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T1 — Startup Sweeper & Lock Initialization...");
  
  // Seed stuck 'running' jobs in DB
  db.prepare(`
    INSERT INTO campaigns (id, name, platform, status, created_at)
    VALUES (9901, 'Test Startup Campaign', 'linkedin', 'active', datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO leads (id, name, platform, status, profile_url)
    VALUES (9901, 'Lead Stuck', 'linkedin', 'qualified', 'https://linkedin.com/in/stuck')
  `).run();
  db.prepare(`
    INSERT INTO connection_jobs (campaign_id, lead_id, status, retry_count)
    VALUES (9901, 9901, 'running', 0)
  `).run();
  db.prepare(`
    INSERT INTO dm_jobs (campaign_id, lead_id, status)
    VALUES (9901, 9901, 'running')
  `).run();

  // Manually lock settings table to simulate stuck run before boot
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('campaign_queue_lock', 'true')
    ON CONFLICT(key) DO UPDATE SET value = 'true'
  `).run();

  // Trigger background start / sweep
  backgroundJobs.startBackgroundJobs();

  // Verify stuck jobs reset to 'pending'
  const connJob1 = db.prepare("SELECT status FROM connection_jobs WHERE campaign_id = 9901").get();
  const dmJob1 = db.prepare("SELECT status FROM dm_jobs WHERE campaign_id = 9901").get();
  const lockState1 = db.prepare("SELECT value FROM settings WHERE key = 'campaign_queue_lock'").get();

  assert.strictEqual(connJob1.status, "pending", "Stuck 'running' connection jobs must be swept to 'pending' on startup.");
  assert.strictEqual(dmJob1.status, "pending", "Stuck 'running' DM jobs must be swept to 'pending' on startup.");
  assert.strictEqual(lockState1.value, "false", "Campaign queue advisory lock must be initialized to 'false' on startup.");
  console.log("✅ T1 Startup Sweeper & Lock Initialization — PASS");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 2: Cluster-Safe Advisory Queue Lock Mutual Exclusion
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T2 — Persistent advisory lock mutual exclusion...");
  
  // Set lock to true
  db.prepare("UPDATE settings SET value = 'true' WHERE key = 'campaign_queue_lock'").run();

  // Mock process connection queue to check execution skip
  let processConnectionQueueCalled = false;
  const originalProcessConnectionQueue = connectionQueue.processConnectionQueue;
  // We temporarily wrap it
  const connectionQueueModule = require("../src/campaign/connectionQueue");
  
  // Let's verify lock behavior: runConnectionQueueJob and runDmQueueJob should skip running if lock is already true
  // Let's verify by checking if queue execution skips when lock is acquired
  const originalLogInfo = console.log;
  let skippedLogTriggered = false;
  // We'll watch for the logger message
  const logger = require("../src/utils/logger");
  const originalLoggerInfo = logger.info;
  logger.info = (source, message) => {
    if (message.includes("Skipping execution: another cluster instance or runner has acquired the queue lock.")) {
      skippedLogTriggered = true;
    }
    originalLoggerInfo(source, message);
  };

  await backgroundJobs.__private.runConnectionQueueJob({ skipDelays: true });
  assert.strictEqual(skippedLogTriggered, true, "Queue runner must skip run when advisory lock is already acquired.");

  // Restore logger and settings lock
  logger.info = originalLoggerInfo;
  db.prepare("UPDATE settings SET value = 'false' WHERE key = 'campaign_queue_lock'").run();
  console.log("✅ T2 Persistent Advisory Lock Mutual Exclusion — PASS");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 3: Warm Leads Connection Bypass Gate
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T3 — Warm Lead Connection Bypass Gate...");
  cleanup();

  // Seed campaign & lead
  db.prepare(`
    INSERT INTO campaigns (id, name, platform, status, created_at)
    VALUES (9903, 'Warm Lead Campaign', 'linkedin', 'active', datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO leads (id, name, platform, status, profile_url)
    VALUES (9903, 'Jane Warm', 'linkedin', 'qualified', 'https://linkedin.com/in/jane_warm')
  `).run();
  db.prepare(`
    INSERT INTO connection_jobs (campaign_id, lead_id, status, retry_count)
    VALUES (9903, 9903, 'pending', 0)
  `).run();
  db.prepare(`
    INSERT INTO dm_jobs (campaign_id, lead_id, status)
    VALUES (9903, 9903, 'pending')
  `).run();

  // Mock adapter response as 'skipped' (already connected)
  platformAdapter.runConnectionAction = async () => {
    return { outcome: "skipped", error: "Already connected", metadata: {}, retryable: false };
  };

  const mockPage = {};
  await connectionQueue.processConnectionQueue(mockPage, { skipDelays: true });

  // Verify connection status transitioned to 'accepted' (instead of 'sent')
  const connJob3 = db.prepare("SELECT status FROM connection_jobs WHERE campaign_id = 9903").get();
  assert.strictEqual(connJob3.status, "accepted", "Skipped already-connected leads must transition connection status directly to 'accepted'.");

  // Verify DM job promoted to 'scheduled' immediately (no snooze interval!)
  const dmJob3 = db.prepare("SELECT status FROM dm_jobs WHERE campaign_id = 9903").get();
  assert.strictEqual(dmJob3.status, "scheduled", "Warm leads bypass must immediately schedule DM job without wait intervals.");

  console.log("✅ T3 Warm Lead Connection Bypass Gate — PASS");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 4: Cascade Connection Terminal Failures
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T4 — Cascade Connection Terminal Failures to DM Jobs...");
  cleanup();

  db.prepare(`
    INSERT INTO campaigns (id, name, platform, status, created_at)
    VALUES (9904, 'Terminal Fail Campaign', 'linkedin', 'active', datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO leads (id, name, platform, status, profile_url)
    VALUES (9904, 'John Terminal', 'linkedin', 'qualified', 'https://linkedin.com/in/john_terminal')
  `).run();
  db.prepare(`
    INSERT INTO connection_jobs (campaign_id, lead_id, status, retry_count)
    VALUES (9904, 9904, 'pending', 4)
  `).run();
  db.prepare(`
    INSERT INTO dm_jobs (campaign_id, lead_id, status)
    VALUES (9904, 9904, 'pending')
  `).run();

  // Mock adapter response as failed (terminal)
  platformAdapter.runConnectionAction = async () => {
    return { outcome: "failed", error: "Fatal profile restricted", retryable: false };
  };

  await connectionQueue.processConnectionQueue(mockPage, { skipDelays: true, maxRetries: 5 });

  // Verify connection job failed terminally
  const connJob4 = db.prepare("SELECT status, retry_count FROM connection_jobs WHERE campaign_id = 9904").get();
  assert.strictEqual(connJob4.status, "failed");
  assert.strictEqual(connJob4.retry_count, 5);

  // Verify DM job is cascade-cancelled to 'failed' terminally
  const dmJob4 = db.prepare("SELECT status, error_message FROM dm_jobs WHERE campaign_id = 9904").get();
  assert.strictEqual(dmJob4.status, "failed", "Terminal connection failure must cascade to failed status on related pending DM job.");
  assert.strictEqual(dmJob4.error_message, "Connection failed terminally", "Orphaned DM jobs must explicitly specify terminal connection failure context.");

  console.log("✅ T4 Cascade Connection Terminal Failures — PASS");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 5: Session Expiry Email Alert Deduplication & Batch Skip
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T5 — Session Expiry Alarm Deduplication & Queue Skip...");
  cleanup();
  notificationServiceMock.sent = [];

  // Seed two leads/jobs for the same platform campaign to verify deduplication
  db.prepare(`
    INSERT INTO campaigns (id, name, platform, status, created_at)
    VALUES (9905, 'Session Expiry Campaign', 'linkedin', 'active', datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO leads (id, name, platform, status, profile_url)
    VALUES (9905, 'Lead A', 'linkedin', 'qualified', 'https://linkedin.com/in/lead_a'),
           (9906, 'Lead B', 'linkedin', 'qualified', 'https://linkedin.com/in/lead_b')
  `).run();
  db.prepare(`
    INSERT INTO connection_jobs (campaign_id, lead_id, status, retry_count)
    VALUES (9905, 9905, 'pending', 0),
           (9905, 9906, 'pending', 0)
  `).run();

  // Mock adapter response as session_required
  let runConnectionActionCallCount = 0;
  platformAdapter.runConnectionAction = async () => {
    runConnectionActionCallCount++;
    return { outcome: "session_required", error: "Session cookie invalidated.", retryable: false };
  };

  const report5 = await connectionQueue.processConnectionQueue(mockPage, { skipDelays: true });

  // Verify only ONE adapter launch occurred (second job skipped due to early out!)
  assert.strictEqual(runConnectionActionCallCount, 1, "Should only invoke browser outreach action ONCE. Subsequent jobs must skip due to session expiry cached flag.");
  assert.strictEqual(report5.sessionExpired, 2, "Both jobs must report sessionExpired outcome status.");

  // Verify database updates for both jobs
  const connJobs5 = db.prepare("SELECT status, next_retry_at FROM connection_jobs WHERE campaign_id = 9905").all();
  assert.strictEqual(connJobs5.length, 2);
  assert.strictEqual(connJobs5[0].status, "pending");
  assert.strictEqual(connJobs5[1].status, "pending");
  assert(connJobs5[0].next_retry_at !== null);
  assert(connJobs5[1].next_retry_at !== null);

  // Verify exactly ONE alarm notification was sent
  assert.strictEqual(notificationServiceMock.sent.length, 1, "Should send exactly one platform alert email per run to prevent flood.");
  assert.strictEqual(notificationServiceMock.sent[0].subject, "GTSS Session Expired - linkedin");

  console.log("✅ T5 Session Expiry Alarm Deduplication — PASS");

  // ───────────────────────────────────────────────────────────────────────────
  // Restore original modules & clean up
  // ───────────────────────────────────────────────────────────────────────────
  platformAdapter.runConnectionAction = originalRunConnectionAction;
  platformAdapter.runDmAction = originalRunDmAction;
  cleanup();
  
  db.pragma("foreign_keys = ON");
  console.log("🎉 ALL CAMPAIGN INTEGRITY & RELIABILITY TESTS PASSED SUCCESSFULLY! EXITING 0.");
}

runCampaignIntegrityTests()
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    console.error("❌ CAMPAIGN INTEGRITY TESTS FAILED:", err);
    process.exit(1);
  });
