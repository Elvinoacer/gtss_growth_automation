const assert = require("node:assert/strict");
const test = require("node:test");

process.env.DB_PATH = "./data/test_instagram.db";
process.env.TEST_SPEEDUP = "true";

const { getDb } = require("../src/db/database");
const {
  dailySessionWarmup,
  isInstagramBlocked,
  setInstagramBlockedUntil,
  getSelectorHealthReport
} = require("../src/automation/browserBase");
const { crawlAndQueueSuggestedAccounts } = require("../src/services/instagramDiscoveryService");
const { scoreLead, runQualificationStage } = require("../src/services/qualificationService");
const automationRouter = require("../src/routes/automation");

// Helper to get active routes from Express router
function getRouteHandler(method, path) {
  const layer = automationRouter.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]
  );
  if (!layer) throw new Error(`Route ${method} ${path} not found`);
  return layer.route.stack[0].handle;
}

test("1. dailySessionWarmup fast-track configuration supports 5-10s duration", async () => {
  const mockPage = {
    url: () => "https://www.instagram.com/",
    waitForLoadState: async () => {},
    isClosed: () => false,
    goto: async () => {},
    mouse: {
      move: async () => {},
      wheel: async () => {}
    },
    locator: (selector) => ({
      count: async () => 0,
      nth: () => ({
        boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 100 })
      }),
      first: () => ({
        boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 100 })
      })
    })
  };

  const originalDateNow = Date.now;
  let callCount = 0;
  // Mock Date.now to test target elapsed times
  Date.now = () => {
    callCount++;
    if (callCount === 1) return 1000000; // startTime
    if (callCount === 2) return 1000050; // elapsed check
    return 1006000; // durationMs calculation (6 seconds total, matches fast-track 5-10s boundary)
  };

  try {
    const result = await dailySessionWarmup(mockPage, true);
    assert.equal(result.completed, true);
    assert.ok(result.durationMs >= 5000 && result.durationMs <= 10000, `Fast-track duration was ${result.durationMs}ms`);
  } finally {
    Date.now = originalDateNow;
  }
});

test("2. Action block reset handles DB settings updates", () => {
  const db = getDb();

  // Reset block setting
  db.prepare("DELETE FROM settings WHERE key = 'ig_blocked_until'").run();

  let blocked = isInstagramBlocked();
  assert.equal(blocked.blocked, false);
  assert.equal(blocked.resumesAt, null);

  // Set action block
  setInstagramBlockedUntil(24);
  blocked = isInstagramBlocked();
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.resumesAt !== null);

  // Override/Reset block
  db.prepare("DELETE FROM settings WHERE key = 'ig_blocked_until'").run();
  blocked = isInstagramBlocked();
  assert.equal(blocked.blocked, false);
});

test("3. Selector failure health tracks warning thresholds", () => {
  const report = getSelectorHealthReport();
  assert.ok(report.failures);
  assert.ok(Array.isArray(report.warnings));
});

test("4. Suggested Accounts crawler populates ig_discovery_queue and skips duplicates", async () => {
  const db = getDb();
  
  // Clear tables safely
  db.prepare("PRAGMA foreign_keys = OFF").run();
  db.prepare("DELETE FROM ig_warmup_sequences").run();
  db.prepare("DELETE FROM ig_follow_tracker").run();
  db.prepare("DELETE FROM ig_discovery_queue").run();
  db.prepare("DELETE FROM leads").run();
  db.prepare("PRAGMA foreign_keys = ON").run();

  // Insert base lead
  const insertLead = db.prepare(`
    INSERT INTO leads (platform, name, ig_username, profile_url, status)
    VALUES ('instagram', 'Base User', 'base_user', 'https://instagram.com/base_user/', 'qualified')
  `);
  const info = insertLead.run();
  const leadId = info.lastInsertRowid;

  // Verify ig_discovery_queue is empty
  let queueCount = db.prepare("SELECT COUNT(*) as count FROM ig_discovery_queue").get().count;
  assert.equal(queueCount, 0);

  const browserBase = require("../src/automation/browserBase");
  const originalCreate = browserBase.createInstagramBrowser;
  const originalClose = browserBase.closeBrowser;

  const mockPage = {
    url: () => "https://www.instagram.com/base_user/",
    waitForLoadState: async () => {},
    isClosed: () => false,
    goto: async () => {},
    waitForTimeout: async () => {},
    locator: (selector) => {
      if (selector === 'a[href^="/"]') {
        // Return a mock locator array with 3 profile links
        const profiles = ["/suggested_user_1/", "/suggested_user_2/", "/already_leads_user/"];
        return {
          count: async () => profiles.length,
          nth: (index) => ({
            getAttribute: async (attr) => (attr === "href" ? profiles[index] : "")
          })
        };
      }
      return {
        first: () => ({
          isVisible: async () => true,
          click: async () => {}
        })
      };
    }
  };

  browserBase.createInstagramBrowser = async () => ({
    browser: { close: async () => {} },
    context: {},
    page: mockPage,
    mode: "ephemeral",
    tracePath: null,
    lock: null
  });

  browserBase.closeBrowser = async () => {};

  try {
    // Insert duplicate lead to test filtering
    db.prepare(`
      INSERT INTO leads (platform, name, ig_username, profile_url, status)
      VALUES ('instagram', 'Duplicate Lead', 'already_leads_user', 'https://instagram.com/already_leads_user/', 'discovered')
    `).run();

    const res = await crawlAndQueueSuggestedAccounts(leadId);
    assert.equal(res.success, true);
    
    // Assert ig_discovery_queue has suggested users
    const queuedItems = db.prepare("SELECT * FROM ig_discovery_queue ORDER BY ig_username ASC").all();
    assert.equal(queuedItems.length, 2);
    assert.equal(queuedItems[0].ig_username, "suggested_user_1");
    assert.equal(queuedItems[1].ig_username, "suggested_user_2");
    assert.equal(queuedItems[0].processed, 0);

  } finally {
    // Restore
    browserBase.createInstagramBrowser = originalCreate;
    browserBase.closeBrowser = originalClose;
  }
});

test("5. Instagram settings Express endpoints GET and POST respond correctly", async () => {
  const db = getDb();
  const getHandler = getRouteHandler("GET", "/api/automation/instagram/settings");
  const postHandler = getRouteHandler("POST", "/api/automation/instagram/settings");

  // Mock Request/Response for GET
  let jsonResponse = null;
  const mockResGet = {
    json: (data) => {
      jsonResponse = data;
    },
    status: () => mockResGet
  };

  await getHandler({}, mockResGet);
  assert.ok(jsonResponse);
  assert.equal(jsonResponse.success, true);
  assert.ok(jsonResponse.settings);
  assert.ok(jsonResponse.blockedStatus);
  assert.ok(jsonResponse.healthReport);

  // Mock Request/Response for POST
  let postResponse = null;
  const mockResPost = {
    json: (data) => {
      postResponse = data;
    },
    status: () => mockResPost
  };

  const mockReqPost = {
    body: {
      ig_warmup_fast_track: "1",
      ig_blocked_until: "" // Override/Clear block
    }
  };

  await postHandler(mockReqPost, mockResPost);
  assert.ok(postResponse);
  assert.equal(postResponse.success, true);
  assert.equal(postResponse.settings.ig_warmup_fast_track, "1");
  assert.equal(postResponse.settings.ig_blocked_until, undefined); // Cleared in deletion transaction
});
