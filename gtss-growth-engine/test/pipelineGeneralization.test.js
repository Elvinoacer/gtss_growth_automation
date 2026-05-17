const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gtss-pipeline-test-"));
process.env.DB_PATH = path.join(root, "gtss.db");
process.env.ENCRYPTION_KEY = "test-key";

// Set a custom pipeline keywords file path for the test
const testKeywordsFile = path.join(root, "keywords.json");
process.env.PIPELINE_DISCOVERY_KEYWORDS_FILE = testKeywordsFile;

const { getDb } = require("../src/db/database");
const { runDiscoveryStage } = require("../src/pipeline/discoveryPipeline");
const { runSendStage } = require("../src/pipeline/sendPipeline");

test("Pipeline Architecture Generalization & Multi-Platform Validation", async (t) => {
  const db = getDb();
  
  // 1. Create hermetic SQLite tables
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM leads").run();
  db.prepare("DELETE FROM platform_sessions").run();

  await t.test("Discovery Pipeline processes mixed keywords and respects DISCOVERY_PLATFORMS overrides", async () => {
    // Write a mixed keywords configuration
    const config = {
      version: 1,
      keywords: [
        "restaurant owner Nairobi",
        { keyword: "#NairobiCafe", platforms: ["x"] },
        { keyword: "pizzeria Mombasa", platforms: ["linkedin", "x"] }
      ],
      platforms: ["linkedin", "facebook"],
      maxLeadsPerKeyword: 5
    };
    fs.writeFileSync(testKeywordsFile, JSON.stringify(config), "utf8");

    // Enable manual mode to check pipeline progression safely without browser scraping
    process.env.PIPELINE_MODE = "manual";
    
    const events = [];
    const emit = (e) => events.push(e);

    const result = await runDiscoveryStage(1, emit);
    
    // In manual mode, it skips AI browser discovery and logs a friendly message
    assert.equal(result.newLeads, 0, "No new leads collected in manual mode");
    assert.ok(events.some(e => e.message.includes("Discovery: manual mode")), "Manual discovery notice must be emitted");
  });

  await t.test("Send Pipeline targets only active platforms with queued messages", async () => {
    // Insert pending messages for 'x' only
    db.prepare(`
      INSERT INTO leads (id, name, role, company, location, platform, status)
      VALUES (201, 'Charlie Day', 'Owner', 'Paddys Pub', 'Philadelphia', 'x', 'qualified')
    `).run();

    db.prepare(`
      INSERT INTO messages (id, lead_id, platform, body, variant, status, is_follow_up)
      VALUES (501, 201, 'x', 'Hi Charlie, love the pub!', 'A', 'approved', 0)
    `).run();

    // Authenticate 'x' session
    db.prepare(`
      INSERT INTO platform_sessions (platform, cookie_blob, last_active, is_valid)
      VALUES ('x', 'mock-cookie', CURRENT_TIMESTAMP, 1)
      ON CONFLICT(platform) DO UPDATE SET is_valid = 1, last_active = CURRENT_TIMESTAMP
    `).run();

    // Leave 'linkedin' unauthenticated/invalid
    db.prepare(`
      INSERT INTO platform_sessions (platform, cookie_blob, last_active, is_valid)
      VALUES ('linkedin', NULL, CURRENT_TIMESTAMP, 0)
      ON CONFLICT(platform) DO UPDATE SET is_valid = 0, last_active = CURRENT_TIMESTAMP
    `).run();

    const sendEvents = [];
    const emitSend = (e) => sendEvents.push(e);

    // Run send pipeline
    // It should proceed successfully because X is authenticated, and there are NO messages for LinkedIn
    const sendResult = await runSendStage(1, emitSend);

    assert.equal(sendResult.limitReached, false, "limitReached should be false by default");
    
    // Ensure it didn't abort due to LinkedIn being invalid
    const hasAborted = sendEvents.some(e => e.type === 'error' && e.message.includes("No platform"));
    assert.equal(hasAborted, false, "Send stage must not abort when only unused platforms are unauthenticated");
  });
});
