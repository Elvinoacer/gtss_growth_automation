const assert = require("assert");
const Database = require("better-sqlite3");

// Create isolated sandboxed database in-memory
const db = new Database(":memory:");
db.pragma("foreign_keys = ON");

// Monkey-patch db module to return this sandboxed database during tests
const dbModule = require("../src/db/database");
const originalGetDb = dbModule.getDb;
dbModule.getDb = () => db;

const orchestrator = require("../src/campaign/campaignOrchestrator");

function setupTestDatabase() {
  // Re-create standard mock tables matching specifications
  db.exec(`
    CREATE TABLE campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      profile_url TEXT UNIQUE,
      status TEXT DEFAULT 'discovered'
    );

    CREATE TABLE connection_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
      lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(campaign_id, lead_id)
    );

    CREATE TABLE dm_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
      lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
      message_id INTEGER,
      status TEXT DEFAULT 'pending',
      scheduled_at DATETIME,
      sent_at DATETIME,
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(campaign_id, lead_id, message_id)
    );

    CREATE TABLE campaign_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      details_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE action_fingerprints (
      fingerprint TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      action_type TEXT NOT NULL,
      target TEXT NOT NULL,
      message_id INTEGER,
      lead_id INTEGER REFERENCES leads(id),
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function runOrchestratorTest() {
  console.log("=== RUNNING CAMPAIGN ORCHESTRATOR TESTS ===");
  setupTestDatabase();

  // 1. Provision campaign and qualified leads
  db.prepare("INSERT INTO campaigns (id, name, platform, status) VALUES (10, 'LinkedIn Outreach', 'linkedin', 'draft')").run();
  db.prepare("INSERT INTO leads (id, platform, profile_url, status) VALUES (1, 'linkedin', 'https://linkedin.com/in/user1', 'qualified')").run();
  db.prepare("INSERT INTO leads (id, platform, profile_url, status) VALUES (2, 'linkedin', 'https://linkedin.com/in/user2', 'qualified')").run();
  db.prepare("INSERT INTO leads (id, platform, profile_url, status) VALUES (3, 'linkedin', 'https://linkedin.com/in/user3', 'discovered')").run(); // non-qualified

  // 2. Start the campaign
  console.log("Starting campaign...");
  orchestrator.startCampaign(10);

  // Validate status transition
  const campaign = db.prepare("SELECT status FROM campaigns WHERE id = 10").get();
  assert.strictEqual(campaign.status, "active", "Campaign status should transition to 'active'.");

  // Validate start events
  const startEvent = db.prepare("SELECT * FROM campaign_events WHERE campaign_id = 10 AND event_type = 'campaign_started'").get();
  assert(startEvent, "Kickoff campaign_started event must exist.");

  // Validate atomic job enqueues (should be enqueued for qualified leads 1 and 2, but NOT non-qualified lead 3)
  const connectionJobs = db.prepare("SELECT * FROM connection_jobs WHERE campaign_id = 10").all();
  const dmJobs = db.prepare("SELECT * FROM dm_jobs WHERE campaign_id = 10").all();
  assert.strictEqual(connectionJobs.length, 2, "Should have enqueued connection jobs for exactly 2 qualified leads.");
  assert.strictEqual(dmJobs.length, 2, "Should have enqueued DM jobs for exactly 2 qualified leads.");

  // Validate that no orphan jobs exist (each enqueued lead must have BOTH a connection job and a DM job)
  const connLeadIds = connectionJobs.map(j => j.lead_id).sort();
  const dmLeadIds = dmJobs.map(j => j.lead_id).sort();
  assert.deepStrictEqual(connLeadIds, [1, 2]);
  assert.deepStrictEqual(dmLeadIds, [1, 2]);
  console.log("✅ Campaign Start & Pair-Enqueue enqueued perfectly.");

  // Validate action fingerprints exist for enqueued actions
  const fingerprintsCount = db.prepare("SELECT COUNT(*) as count FROM action_fingerprints").get().count;
  assert.strictEqual(fingerprintsCount, 4, "Should have registered 4 unique action fingerprints (2 per lead).");
  console.log("✅ Idempotency action fingerprints successfully registered.");

  // 3. Pause campaign
  console.log("Pausing campaign...");
  orchestrator.pauseCampaign(10);
  const campaignPaused = db.prepare("SELECT status FROM campaigns WHERE id = 10").get();
  assert.strictEqual(campaignPaused.status, "paused", "Campaign status should transition to 'paused'.");

  const pauseEvent = db.prepare("SELECT * FROM campaign_events WHERE campaign_id = 10 AND event_type = 'campaign_paused'").get();
  assert(pauseEvent, "Campaign pause event must exist.");
  console.log("✅ Campaign Pause OK.");

  // 4. Resume campaign and add newly qualified lead
  console.log("Adding newly qualified lead and resuming campaign...");
  db.prepare("INSERT INTO leads (id, platform, profile_url, status) VALUES (4, 'linkedin', 'https://linkedin.com/in/user4', 'qualified')").run();
  
  orchestrator.resumeCampaign(10);
  const campaignResumed = db.prepare("SELECT status FROM campaigns WHERE id = 10").get();
  assert.strictEqual(campaignResumed.status, "active", "Campaign status should transition to 'active'.");

  // Verify that only the newly qualified lead gets enqueued
  const connectionJobsAfterResume = db.prepare("SELECT * FROM connection_jobs WHERE campaign_id = 10").all();
  const dmJobsAfterResume = db.prepare("SELECT * FROM dm_jobs WHERE campaign_id = 10").all();
  assert.strictEqual(connectionJobsAfterResume.length, 3, "New connection job should be enqueued.");
  assert.strictEqual(dmJobsAfterResume.length, 3, "New DM job should be enqueued.");
  
  const resumeEvent = db.prepare("SELECT * FROM campaign_events WHERE campaign_id = 10 AND event_type = 'campaign_resumed'").get();
  assert(resumeEvent, "Campaign resume event must exist.");
  console.log("✅ Campaign Resume & Incremental-Enqueue enqueued perfectly.");

  // 5. Get campaign status metrics
  console.log("Retrieving campaign status report...");
  const statusReport = orchestrator.getCampaignStatus(10);
  assert.strictEqual(statusReport.id, 10);
  assert.strictEqual(statusReport.status, "active");
  assert.strictEqual(statusReport.connectionJobs.pending, 3);
  assert.strictEqual(statusReport.dmJobs.pending, 3);
  assert.strictEqual(statusReport.eventsCount, 6, "Total logged event metrics should match.");
  console.log("✅ Campaign Status Metrics resolved perfectly.");

  console.log("🎉 ALL CAMPAIGN ORCHESTRATOR TESTS PASSED SUCCESSFULLY!\n");
}

try {
  runOrchestratorTest();
} catch (err) {
  console.error("❌ CAMPAIGN ORCHESTRATOR TEST FAILED:", err);
  process.exit(1);
} finally {
  dbModule.getDb = originalGetDb;
}
