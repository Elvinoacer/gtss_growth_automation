const assert = require("node:assert/strict");
const test = require("node:test");

// Force test database environment
process.env.DB_PATH = "./data/test_instagram.db";
process.env.TEST_SPEEDUP = "true";

const { getDb, initializeDatabase } = require("../src/db/database");
const router = require("../src/routes/instagram");

// Helper to create mocked Request and Response objects
function mockRequest(params = {}, body = {}, query = {}) {
  return {
    params,
    body,
    query
  };
}

function mockResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    typeStr: null,
    status: function (code) {
      this.statusCode = code;
      return this;
    },
    type: function (t) {
      this.typeStr = t;
      return this;
    },
    json: function (payload) {
      this.body = payload;
      return this;
    },
    send: function (payload) {
      this.body = payload;
      return this;
    }
  };
  return res;
}

test.describe("Instagram Warmup Pages & API Router Integration Tests", () => {
  let db;

  test.before(() => {
    // Reinitialize database to clean state
    initializeDatabase();
    db = getDb();

    // Clean tables
    db.prepare("DELETE FROM messages").run();
    db.prepare("DELETE FROM ig_warmup_sequences").run();
    db.prepare("DELETE FROM leads").run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'warmup_%'").run();

    // Populate mock leads
    db.prepare(`
      INSERT INTO leads (id, name, ig_username, platform, ig_follower_count, company, status, ig_warmup_status)
      VALUES 
        (101, 'Alpha Lead', 'alpha_ig', 'instagram', 1500, 'Alpha Corp', 'pending_qualification', 'pending'),
        (102, 'Beta Lead', 'beta_ig', 'instagram', 2000, 'Beta LLC', 'pending_qualification', 'story_viewed')
    `).run();

    // Populate mock warmup sequences
    db.prepare(`
      INSERT INTO ig_warmup_sequences (id, lead_id, status, next_step, last_action_at, created_at)
      VALUES 
        (501, 101, 'following', 'story_view', datetime('now', '-1 day'), datetime('now', '-2 days')),
        (502, 102, 'story_viewed', 'like', datetime('now', '-2 hours'), datetime('now', '-3 days'))
    `).run();

    // Prepopulate settings table
    db.prepare("INSERT INTO settings (key, value) VALUES ('warmup_min_follow_to_story_hours', '12')").run();
  });

  test("GET /api/instagram/warmup-pipeline returns correct structure, stats and pipeline cards", () => {
    // 1. Resolve router handler for the GET /api/instagram/warmup-pipeline path
    const getPipelineHandler = router.stack.find(
      layer => layer.route && layer.route.path === "/api/instagram/warmup-pipeline" && layer.route.methods.get
    ).route.stack[0].handle;

    const req = mockRequest();
    const res = mockResponse();

    getPipelineHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.success);
    
    // Validate stats calculations
    const stats = res.body.stats;
    assert.equal(stats.total, 2);
    assert.equal(stats.following, 1);
    assert.equal(stats.story_viewed, 1);
    assert.equal(stats.liked, 0);
    assert.equal(stats.dm_ready, 0);

    // Validate settings population
    const settings = res.body.settings;
    assert.equal(settings.warmup_min_follow_to_story_hours, 12);
    assert.equal(settings.warmup_max_follow_to_story_hours, 48); // defaults

    // Validate pipeline card items mapping
    const pipeline = res.body.pipeline;
    assert.equal(pipeline.length, 2);
    const alphaCard = pipeline.find(c => c.leadId === 101);
    assert.equal(alphaCard.username, "alpha_ig");
    assert.equal(alphaCard.displayName, "Alpha Lead");
    assert.equal(alphaCard.followersCount, 1500);
    assert.equal(alphaCard.company, "Alpha Corp");
    assert.equal(alphaCard.daysInStep, 1);
    assert.equal(alphaCard.canSkipToDm, true);
  });

  test("POST /api/settings/instagram saves step delay variables into SQLite database", () => {
    const postSettingsHandler = router.stack.find(
      layer => layer.route && layer.route.path === "/api/settings/instagram" && layer.route.methods.post
    ).route.stack[0].handle;

    const req = mockRequest({}, {
      warmup_min_follow_to_story_hours: 6,
      warmup_max_follow_to_story_hours: 18,
      warmup_min_story_to_like_hours: 8
    });
    const res = mockResponse();

    postSettingsHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.success);

    // Confirm DB updates
    const minFollow = db.prepare("SELECT value FROM settings WHERE key = 'warmup_min_follow_to_story_hours'").get().value;
    const maxFollow = db.prepare("SELECT value FROM settings WHERE key = 'warmup_max_follow_to_story_hours'").get().value;
    const minStory = db.prepare("SELECT value FROM settings WHERE key = 'warmup_min_story_to_like_hours'").get().value;

    assert.equal(minFollow, "6");
    assert.equal(maxFollow, "18");
    assert.equal(minStory, "8");
  });

  test("POST /api/instagram/warmup/:sequenceId/skip completes sequence, generates draft messages", () => {
    const postSkipHandler = router.stack.find(
      layer => layer.route && layer.route.path === "/api/instagram/warmup/:sequenceId/skip" && layer.route.methods.post
    ).route.stack[0].handle;

    const req = mockRequest({ sequenceId: "501" });
    const res = mockResponse();

    postSkipHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.success);

    // Verify sequence is now warmup_complete
    const seq = db.prepare("SELECT status, next_step FROM ig_warmup_sequences WHERE id = 501").get();
    assert.equal(seq.status, "warmup_complete");
    assert.equal(seq.next_step, "done");

    // Verify lead's warmup status is synced
    const lead = db.prepare("SELECT ig_warmup_status FROM leads WHERE id = 101").get();
    assert.equal(lead.ig_warmup_status, "warmup_complete");

    // Verify a message draft has been generated for lead 101 in messages table
    const msg = db.prepare("SELECT * FROM messages WHERE lead_id = 101").get();
    assert.ok(msg);
    assert.equal(msg.platform, "instagram");
    assert.equal(msg.status, "draft");
  });

  test("POST /api/instagram/warmup/:sequenceId/abandon marks sequence and lead as skipped", () => {
    const postAbandonHandler = router.stack.find(
      layer => layer.route && layer.route.path === "/api/instagram/warmup/:sequenceId/abandon" && layer.route.methods.post
    ).route.stack[0].handle;

    const req = mockRequest({ sequenceId: "502" });
    const res = mockResponse();

    postAbandonHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.success);

    // Verify sequence is marked as skipped
    const seq = db.prepare("SELECT status, next_step FROM ig_warmup_sequences WHERE id = 502").get();
    assert.equal(seq.status, "skipped");
    assert.equal(seq.next_step, "none");

    // Verify lead is synced to skipped
    const lead = db.prepare("SELECT ig_warmup_status FROM leads WHERE id = 102").get();
    assert.equal(lead.ig_warmup_status, "skipped");
  });

  test("POST /api/jobs/instagram-warmup/run triggers warmup job runner asynchronously", () => {
    const postRunHandler = router.stack.find(
      layer => layer.route && layer.route.path === "/api/jobs/instagram-warmup/run" && layer.route.methods.post
    ).route.stack[0].handle;

    const req = mockRequest();
    const res = mockResponse();

    postRunHandler(req, res);

    assert.equal(res.statusCode, 202);
    assert.ok(res.body.success);
    assert.equal(res.body.message, "Warmup job runner triggered successfully.");
  });
});
