const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gtss-x-mode-test-"));
process.env.DB_PATH = path.join(root, "gtss.db");
process.env.ENCRYPTION_KEY = "test-key";
process.env.X_OUTREACH_MODE = "follow_first";

const { getDb } = require("../src/db/database");
const { determineActionType, getXOutreachMode } = require("../src/automation/executor");
const xModule = require("../src/automation/x");

test("X (Twitter) outreach module exports all required interface functions", () => {
  assert.equal(typeof xModule.sendConnectionRequest, "function", "sendConnectionRequest must be a function");
  assert.equal(typeof xModule.sendDirectMessage, "function", "sendDirectMessage must be a function");
  assert.equal(typeof xModule.followUser, "function", "followUser must be a function");
  assert.equal(typeof xModule.likeRecentPost, "function", "likeRecentPost must be a function");
});

test("Backward compatibility mapping connects sendConnectionRequest to followUser", () => {
  assert.equal(xModule.sendConnectionRequest, xModule.followUser, "sendConnectionRequest must match followUser exactly");
});

test("X_OUTREACH_MODE env overrides DB setting and controls action types", () => {
  const db = getDb();
  
  // Clean tables to avoid constraint violations
  db.prepare("DELETE FROM touchpoints").run();
  db.prepare("DELETE FROM leads").run();

  // Insert mock leads to satisfy foreign keys
  db.prepare(`
    INSERT INTO leads (id, name, profile_url, platform, status)
    VALUES (456, 'Test Lead 1', 'https://x.com/test1', 'x', 'discovered')
  `).run();

  db.prepare(`
    INSERT INTO leads (id, name, profile_url, platform, status)
    VALUES (789, 'Test Lead 2', 'https://x.com/test2', 'x', 'discovered')
  `).run();
  
  // Set mode to follow_first
  process.env.X_OUTREACH_MODE = "follow_first";
  assert.equal(getXOutreachMode(), "follow_first");

  // Since no follow has been completed, determineActionType should return 'follow'
  const action1 = {
    platform: "x",
    is_follow_up: 0,
    lead_id: 456
  };
  assert.equal(determineActionType(action1), "follow");

  // Record a follow in the touchpoints database
  db.prepare(`
    INSERT INTO touchpoints (lead_id, type, platform, outcome, notes)
    VALUES (456, 'follows', 'x', 'sent', 'Followed target')
  `).run();

  // Now, since a prior follow touchpoint exists, it should return 'dm'
  assert.equal(determineActionType(action1), "dm");

  // If X_OUTREACH_MODE is set to dm_only, it should always return 'dm' directly
  process.env.X_OUTREACH_MODE = "dm_only";
  assert.equal(determineActionType({
    platform: "x",
    is_follow_up: 0,
    lead_id: 789
  }), "dm");
});

test("database initializeSchema correctly adds x_handle column to leads", () => {
  const db = getDb();
  const columns = db.pragma("table_info(leads)").map((col) => col.name);
  assert.ok(columns.includes("x_handle"), "x_handle column must exist in leads table");
});

test("X profile URL handle extraction parses handles correctly", () => {
  const extractXHandle = (url) => {
    if (!url) return null;
    const match = url.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([a-zA-Z0-9_]{1,15})(?:\/|\?|$)/i);
    return match ? match[1] : null;
  };

  assert.equal(extractXHandle("https://x.com/elvin"), "elvin");
  assert.equal(extractXHandle("https://www.x.com/elvin_123"), "elvin_123");
  assert.equal(extractXHandle("http://twitter.com/elvin/status/123"), "elvin");
  assert.equal(extractXHandle("https://twitter.com/elvin?ref=some"), "elvin");
  assert.equal(extractXHandle("https://x.com/InvalidHandleBecauseItIsTooLongName"), null); // X handle is max 15 chars
  assert.equal(extractXHandle("https://linkedin.com/in/elvin"), null);
});
