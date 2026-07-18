process.env.DB_PATH = "./data/test_observability.db";
require("dotenv").config();
const path = require("path");
const assert = require("assert");
const { getDb } = require("../src/db/database");

// Boot test server on unique port
const TEST_PORT = 4569;
process.env.PORT = TEST_PORT;
process.env.DISABLE_BACKGROUND_JOBS = "true";

// ── 1. PRE-SEED REQUIRE CACHE FOR IN Isolated MOCKING ────────────────────────
const socketServicePath = require.resolve("../src/services/socketService");
const socketServiceMock = {
  emitted: [],
  initSocketIO() {},
  getIO() { return {}; },
  emitTo(room, event, data) {
    this.emitted.push({ room, event, data });
  },
  broadcast(event, data) {
    this.emitted.push({ room: null, event, data });
  }
};
require.cache[socketServicePath] = {
  id: socketServicePath,
  filename: socketServicePath,
  loaded: true,
  exports: socketServiceMock
};

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

// Now safely load utility functions and servers
const {
  recordCampaignEvent,
  registerCampaignStream,
  queueLog
} = require("../src/campaign/utils/campaignUtils");

const { server } = require("../src/server");
const BASE_URL = `http://localhost:${TEST_PORT}`;

// We will also mock connection/DM queues and platforms adapters for queue testing
const platformAdapter = require("../src/campaign/platformAdapter");
const connectionQueue = require("../src/campaign/connectionQueue");
const dmQueue = require("../src/campaign/dmQueue");
const platformPolicies = require("../src/config/platformPolicies");

async function runObservabilityTests() {
  console.log("=== RUNNING CAMPAIGN OBSERVABILITY LAYER INTEGRATION TESTS ===");
  const db = getDb();

  // Clean up any remnants of previous test runs
  db.pragma("foreign_keys = OFF");
  db.prepare("DELETE FROM campaign_events WHERE campaign_id >= 9990").run();
  db.prepare("DELETE FROM connection_jobs WHERE campaign_id >= 9990").run();
  db.prepare("DELETE FROM dm_jobs WHERE campaign_id >= 9990").run();
  db.prepare("DELETE FROM daily_actions WHERE campaign_id >= 9990").run();
  db.prepare("DELETE FROM campaigns WHERE id >= 9990").run();
  db.prepare("DELETE FROM leads WHERE id >= 9990").run();
  db.pragma("foreign_keys = ON");

  // Create mock campaigns and leads
  db.prepare(`
    INSERT INTO campaigns (id, name, platform, status)
    VALUES (9990, 'Observability Test Campaign', 'linkedin', 'active')
  `).run();

  db.prepare(`
    INSERT INTO leads (id, platform, name, profile_url, status)
    VALUES (9990, 'linkedin', 'Jane Observability', 'https://linkedin.com/in/jane_obs', 'qualified')
  `).run();

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 1: SSE registration, append-only Event Recording, Socket.IO & SSE emitting
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T1 — Event recording DB write, Socket.IO emits, and SSE streams...");

  // Set up mock SSE client stream
  const sseWritten = [];
  const mockSseRes = {
    on(event, cb) {
      this.closeCb = cb;
    },
    write(chunk) {
      sseWritten.push(chunk);
    },
    close() {
      if (this.closeCb) this.closeCb();
    }
  };

  // Register SSE stream for campaign 9990
  registerCampaignStream(9990, mockSseRes);

  // Clear mock spies
  socketServiceMock.emitted = [];

  // Record campaign event
  recordCampaignEvent(db, 9990, 9990, "dm_sent", { text: "observability works!", attempt: 1 });

  // 1. Assert DB Persistence (Append-only historical verification)
  const rows = db.prepare("SELECT * FROM campaign_events WHERE campaign_id = 9990").all();
  assert.strictEqual(rows.length, 1, "Exactly one campaign event row should be inserted.");
  assert.strictEqual(rows[0].event_type, "dm_sent");
  const parsedDetails = JSON.parse(rows[0].details_json);
  assert.strictEqual(parsedDetails.text, "observability works!");
  assert.strictEqual(parsedDetails.attempt, 1);

  // 2. Assert Socket.IO Emissions
  assert.strictEqual(socketServiceMock.emitted.length, 2, "Should emit to two Socket.IO rooms.");
  assert.strictEqual(socketServiceMock.emitted[0].room, "campaigns");
  assert.strictEqual(socketServiceMock.emitted[0].event, "campaign:event");
  assert.strictEqual(socketServiceMock.emitted[0].data.event_type, "dm_sent");
  assert.strictEqual(socketServiceMock.emitted[0].data.metadata.text, "observability works!");

  assert.strictEqual(socketServiceMock.emitted[1].room, "campaigns:9990");
  assert.strictEqual(socketServiceMock.emitted[1].event, "event");
  assert.strictEqual(socketServiceMock.emitted[1].data.event_type, "dm_sent");

  // 3. Assert SSE Client Output
  assert.strictEqual(sseWritten.length, 1, "SSE client response should have written exactly 1 event.");
  assert(sseWritten[0].startsWith("data: "), "SSE output should start with data wrapper prefix.");
  const sseParsed = JSON.parse(sseWritten[0].replace("data: ", "").trim());
  assert.strictEqual(sseParsed.campaign_id, 9990);
  assert.strictEqual(sseParsed.event_type, "dm_sent");
  assert.strictEqual(sseParsed.metadata.text, "observability works!");

  // Clean up SSE registry dynamically on close
  mockSseRes.close();

  console.log("✅ T1 Event Recording & Broadcasts — PASS");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 2: Real-time queue log stream
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T2 — Queue log streaming via Socket.IO...");

  socketServiceMock.emitted = [];
  queueLog("warn", "dm_queue", 1024, "Slow platform page load detected.", { latencyMs: 5000 });

  assert.strictEqual(socketServiceMock.emitted.length, 1, "Should broadcast queue log via Socket.IO.");
  const emittedLog = socketServiceMock.emitted[0];
  assert.strictEqual(emittedLog.room, "campaigns");
  assert.strictEqual(emittedLog.event, "queue:log");
  assert.strictEqual(emittedLog.data.level, "WARN");
  assert.strictEqual(emittedLog.data.queue, "DM_QUEUE");
  assert.strictEqual(emittedLog.data.jobId, 1024);
  assert.strictEqual(emittedLog.data.message, "Slow platform page load detected.");
  assert.strictEqual(emittedLog.data.latencyMs, 5000);

  console.log("✅ T2 Queue Log Streaming — PASS");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 3: Live SSE HTTP Stream Route
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T3 — Live SSE stream router endpoint /api/campaigns/:id/stream...");

  const streamController = new AbortController();
  const streamRes = await fetch(`${BASE_URL}/api/campaigns/9990/stream`, {
    signal: streamController.signal
  });

  assert.strictEqual(streamRes.status, 200);
  assert(streamRes.headers.get("Content-Type").includes("text/event-stream"), "Content-Type header must contain text/event-stream.");
  assert.strictEqual(streamRes.headers.get("Cache-Control"), "no-cache");
  assert.strictEqual(streamRes.headers.get("Connection"), "keep-alive");

  // Abort request to close connection
  streamController.abort();

  console.log("✅ T3 SSE HTTP Endpoint — PASS");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 4: Campaign paginated events query parser details_json to metadata
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T4 — GET /api/campaigns/:id/events JSON metadata parser...");

  const eventsRes = await fetch(`${BASE_URL}/api/campaigns/9990/events`);
  assert.strictEqual(eventsRes.status, 200);
  const eventsBody = await eventsRes.json();

  assert.strictEqual(eventsBody.events.length, 1, "Should return 1 campaign event.");
  const fetchedEvt = eventsBody.events[0];
  assert.strictEqual(fetchedEvt.event_type, "dm_sent");
  assert.deepStrictEqual(fetchedEvt.metadata, { text: "observability works!", attempt: 1 }, "Details JSON must be parsed and returned inside metadata.");

  console.log("✅ T4 Event Metadata Parsing Route — PASS");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 5: Session Expiry Email Alert integration (Connection Queue)
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T5 — Session expiry email notification triggers...");

  // Mock platformAdapter connections and DM returns
  const originalRunConnectionAction = platformAdapter.runConnectionAction;
  const originalRunDmAction = platformAdapter.runDmAction;
  const originalLinkedinWindow = { ...platformPolicies.linkedin.activeWindow };

  platformAdapter.runConnectionAction = async () => {
    return { outcome: "session_required", error: "Session token expired." };
  };

  platformAdapter.runDmAction = async () => {
    return { outcome: "session_required", error: "Session cookie invalidated." };
  };
  platformPolicies.linkedin.activeWindow = {
    ...platformPolicies.linkedin.activeWindow,
    startHour: 0,
    endHour: 24,
  };

  // Enqueue a connection job and a DM job
  db.prepare(`
    INSERT INTO connection_jobs (id, campaign_id, lead_id, status, retry_count, next_retry_at)
    VALUES (9990, 9990, 9990, 'pending', 0, CURRENT_TIMESTAMP)
  `).run();

  db.prepare(`
    INSERT INTO dm_jobs (id, campaign_id, lead_id, status, retry_count, next_retry_at)
    VALUES (9990, 9990, 9990, 'pending', 0, CURRENT_TIMESTAMP)
  `).run();
  db.prepare(`
    INSERT INTO messages (lead_id, platform, body, status, generated_by, approved_by, approved_at, is_follow_up)
    VALUES (9990, 'linkedin', 'Hi Jane, this is a session expiry test message.', 'approved', 'ai', 'system', CURRENT_TIMESTAMP, 0)
  `).run();

  // Reset notification mock
  notificationServiceMock.sent = [];

  // Run connection queue cycle
  await connectionQueue.processConnectionQueue(null, { skipDelays: true });

  assert.strictEqual(notificationServiceMock.sent.length, 1, "Should send exactly one email notification.");
  assert(notificationServiceMock.sent[0].subject.includes("Session Expired"), "Notification subject should indicate session expiry.");
  assert(notificationServiceMock.sent[0].subject.includes("linkedin"), "Notification subject should specify platform.");
  assert(notificationServiceMock.sent[0].text.includes("Session token expired."), "Notification body should contain error details.");

  // Reset notifications mock and run DM queue cycle
  notificationServiceMock.sent = [];
  db.prepare("UPDATE connection_jobs SET status = 'accepted' WHERE id = 9990").run();
  await dmQueue.processDmQueue(null, { skipDelays: true });

  assert.strictEqual(notificationServiceMock.sent.length, 1, "Should send exactly one DM session expiration notification.");
  assert(notificationServiceMock.sent[0].subject.includes("Session Expired"), "DM notification subject should indicate session expiry.");
  assert(notificationServiceMock.sent[0].text.includes("Session cookie invalidated."), "DM notification body should contain error details.");

  // Restore original functions
  platformAdapter.runConnectionAction = originalRunConnectionAction;
  platformAdapter.runDmAction = originalRunDmAction;
  platformPolicies.linkedin.activeWindow = originalLinkedinWindow;

  console.log("✅ T5 Session Expiry Notifications — PASS");

  // ───────────────────────────────────────────────────────────────────────────
  // Clean up
  // ───────────────────────────────────────────────────────────────────────────
  db.pragma("foreign_keys = OFF");
  db.prepare("DELETE FROM campaign_events WHERE campaign_id >= 9990").run();
  db.prepare("DELETE FROM connection_jobs WHERE campaign_id >= 9990").run();
  db.prepare("DELETE FROM dm_jobs WHERE campaign_id >= 9990").run();
  db.prepare("DELETE FROM campaigns WHERE id >= 9990").run();
  db.prepare("DELETE FROM leads WHERE id >= 9990").run();
  db.pragma("foreign_keys = ON");

  server.close(() => {
    console.log("Observability test server shut down.");
  });

  console.log("🎉 ALL CAMPAIGN OBSERVABILITY TESTS PASSED SUCCESSFULLY! EXITING 0.");
}

runObservabilityTests().catch(err => {
  console.error("❌ OBSERVABILITY TESTS FAILED:", err);
  process.exit(1);
});
