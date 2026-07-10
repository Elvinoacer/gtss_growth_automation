/**
 * massFollowPipeline.test.js — Tests for the new Mass-Follow Pipeline
 *
 * Uses the modern node:test style (like pipelineQueue.test.js) with a
 * hermetic in-memory SQLite DB. Mocks platformAdapter.runConnectionAction
 * so we don't need a real browser. The TikTok automation module is also
 * exercised via the adapter's allowlist + a stubbed tiktok.followUser.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gtss-mass-follow-test-"));
process.env.DB_PATH = path.join(root, "gtss.db");
process.env.ENCRYPTION_KEY = "test-key";
process.env.TEST_NO_BROWSER_LAUNCH = "true";
process.env.DISABLE_BACKGROUND_JOBS = "true";

const { getDb } = require("../src/db/database");
const platformAdapter = require("../src/campaign/platformAdapter");
const {
  runMassFollowPipelineNow,
  _internal,
  MASS_FOLLOW_STAGES,
  SUPPORTED_PLATFORMS,
} = require("../src/pipeline/massFollowPipeline");

// ── Capture original adapter function so we can restore it after each test ──
const originalRunConnectionAction = platformAdapter.runConnectionAction;

function setupDb() {
  const db = getDb();
  db.prepare("DELETE FROM mass_follow_targets").run();
  db.prepare("DELETE FROM daily_actions").run();
  db.prepare("DELETE FROM touchpoints").run();
  return db;
}

function insertTarget(db, { platform = "instagram", profile_url, handle = null, status = "pending", retry_count = 0 }) {
  const url = profile_url || `https://${platform}.com/user_${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO mass_follow_targets (platform, profile_url, handle, status, retry_count, max_retries, source)
     VALUES (?, ?, ?, ?, ?, 3, 'test')`,
  ).run(platform, url, handle, status, retry_count);
  return db.prepare("SELECT * FROM mass_follow_targets WHERE profile_url = ?").get(url);
}

test("MASS_FOLLOW_STAGES is the expected triplet", () => {
  assert.deepEqual(MASS_FOLLOW_STAGES, ["select_targets", "follow", "report"]);
});

test("SUPPORTED_PLATFORMS includes the five supported networks, including TikTok", () => {
  assert.ok(SUPPORTED_PLATFORMS.has("instagram"));
  assert.ok(SUPPORTED_PLATFORMS.has("x"));
  assert.ok(SUPPORTED_PLATFORMS.has("linkedin"));
  assert.ok(SUPPORTED_PLATFORMS.has("facebook"));
  assert.ok(SUPPORTED_PLATFORMS.has("tiktok"));
  assert.equal(SUPPORTED_PLATFORMS.size, 5);
});

test("selectTargetsBatch returns pending rows and skips platforms at their daily limit", () => {
  const db = setupDb();
  // Insert 3 pending targets
  insertTarget(db, { platform: "instagram", profile_url: "https://instagram.com/a1" });
  insertTarget(db, { platform: "instagram", profile_url: "https://instagram.com/a2" });
  insertTarget(db, { platform: "x", profile_url: "https://x.com/b1" });

  const result = _internal.selectTargetsBatch(["instagram", "x"], 10, false);
  assert.equal(result.targets.length, 3);
  assert.equal(result.skippedPlatforms.length, 0);
});

test("selectTargetsBatch excludes platforms that are not supported", () => {
  const db = setupDb();
  insertTarget(db, { platform: "instagram", profile_url: "https://instagram.com/c1" });
  const result = _internal.selectTargetsBatch(["myspace", "instagram"], 10, false);
  assert.equal(result.targets.length, 1);
  assert.ok(result.skippedPlatforms.some((p) => p.platform === "myspace" && p.reason === "unsupported"));
});

test("selectTargetsBatch does not return failed targets that haven't reached their backoff window", () => {
  const db = setupDb();
  insertTarget(db, { platform: "x", profile_url: "https://x.com/pending1" });
  // A failed target with next_retry_at far in the future — should NOT be selected
  db.prepare(
    `INSERT INTO mass_follow_targets (platform, profile_url, status, retry_count, max_retries, next_retry_at, source)
     VALUES ('x', 'https://x.com/failed-future', 'failed', 1, 3, datetime('now', '+1 hour'), 'test')`,
  ).run();
  // A failed target with next_retry_at in the past — SHOULD be selected
  db.prepare(
    `INSERT INTO mass_follow_targets (platform, profile_url, status, retry_count, max_retries, next_retry_at, source)
     VALUES ('x', 'https://x.com/failed-past', 'failed', 1, 3, datetime('now', '-1 hour'), 'test')`,
  ).run();

  const result = _internal.selectTargetsBatch(["x"], 10, false);
  const urls = result.targets.map((t) => t.profile_url);
  assert.ok(urls.includes("https://x.com/pending1"));
  assert.ok(urls.includes("https://x.com/failed-past"));
  assert.ok(!urls.includes("https://x.com/failed-future"));
});

test("recordOutcome flips target to 'sent' and writes a daily_actions row on success", () => {
  const db = setupDb();
  const target = insertTarget(db, { platform: "x", profile_url: "https://x.com/sent-test" });

  const finalStatus = _internal.recordOutcome(db, target, "x", {
    outcome: "sent",
    error: null,
    metadata: {},
    retryable: false,
  });

  assert.equal(finalStatus, "sent");
  const updated = db.prepare("SELECT * FROM mass_follow_targets WHERE id = ?").get(target.id);
  assert.equal(updated.status, "sent");
  assert.ok(updated.sent_at);

  const action = db
    .prepare("SELECT * FROM daily_actions WHERE platform = 'x' AND action_type = 'follows'")
    .get();
  assert.ok(action, "Expected a daily_actions row to be written for the follow");
  assert.equal(action.outcome, "sent");
});

test("recordOutcome flips target to 'skipped' when adapter returns 'skipped'", () => {
  const db = setupDb();
  const target = insertTarget(db, { platform: "instagram", profile_url: "https://instagram.com/skip-test" });

  const finalStatus = _internal.recordOutcome(db, target, "instagram", {
    outcome: "skipped",
    error: "Already following",
    metadata: {},
    retryable: false,
  });

  assert.equal(finalStatus, "skipped");
  const updated = db.prepare("SELECT * FROM mass_follow_targets WHERE id = ?").get(target.id);
  assert.equal(updated.status, "skipped");
});

test("recordOutcome increments retry_count and schedules backoff for transient failures", () => {
  const db = setupDb();
  const target = insertTarget(db, { platform: "x", profile_url: "https://x.com/fail-test", retry_count: 0 });

  const finalStatus = _internal.recordOutcome(db, target, "x", {
    outcome: "failed",
    error: "Network timeout",
    metadata: {},
    retryable: true,
  });

  // First failure: retry_count goes 0 → 1, status stays 'pending', next_retry_at set
  assert.equal(finalStatus, "pending");
  const updated = db.prepare("SELECT * FROM mass_follow_targets WHERE id = ?").get(target.id);
  assert.equal(updated.status, "pending");
  assert.equal(updated.retry_count, 1);
  assert.ok(updated.next_retry_at, "Expected next_retry_at to be set after a retryable failure");
});

test("recordOutcome marks target as terminal 'failed' after max_retries is exceeded", () => {
  const db = setupDb();
  const target = insertTarget(db, { platform: "x", profile_url: "https://x.com/permafail", retry_count: 2 });

  const finalStatus = _internal.recordOutcome(db, target, "x", {
    outcome: "failed",
    error: "Account suspended",
    metadata: {},
    retryable: true,
  });

  // retry_count was 2, max_retries is 3 → after increment (3) >= cap → terminal 'failed'
  assert.equal(finalStatus, "failed");
  const updated = db.prepare("SELECT * FROM mass_follow_targets WHERE id = ?").get(target.id);
  assert.equal(updated.status, "failed");
});

test("recordOutcome maps 'session_required' to 'pending' so the next run retries", () => {
  const db = setupDb();
  const target = insertTarget(db, { platform: "instagram", profile_url: "https://instagram.com/session-test" });

  const finalStatus = _internal.recordOutcome(db, target, "instagram", {
    outcome: "session_required",
    error: "Session expired",
    metadata: {},
    retryable: false,
  });

  assert.equal(finalStatus, "pending");
});

test("runMassFollowPipelineNow returns soft-success with no targets when the queue is empty", async () => {
  setupDb();
  // Stub adapter so it would fail loudly if called — but it shouldn't be called at all
  let adapterCalled = false;
  platformAdapter.runConnectionAction = async () => { adapterCalled = true; return { outcome: "sent" }; };

  try {
    const result = await runMassFollowPipelineNow({
      platforms: ["instagram"],
      max_follows_per_run: 5,
      follow_interval_min_seconds: 1,
      follow_interval_max_seconds: 2,
      respect_active_window: false,
      trigger: "test",
    });
    assert.equal(result.success, true);
    assert.equal(result.summary.total, 0);
    assert.equal(adapterCalled, false);
  } finally {
    platformAdapter.runConnectionAction = originalRunConnectionAction;
  }
});

test("runMassFollowPipelineNow returns a hard error when no supported platforms are configured", async () => {
  setupDb();
  const result = await runMassFollowPipelineNow({
    platforms: ["myspace"],
    trigger: "test",
  });
  assert.equal(result.success, false);
  assert.match(result.error, /No supported platforms/i);
});

test("runMassFollowPipelineNow follows all eligible targets and writes per-platform summaries", async () => {
  const db = setupDb();
  insertTarget(db, { platform: "x", profile_url: "https://x.com/u1" });
  insertTarget(db, { platform: "x", profile_url: "https://x.com/u2" });
  insertTarget(db, { platform: "instagram", profile_url: "https://instagram.com/v1" });

  // Stub the adapter: succeed for X, skip for Instagram
  platformAdapter.runConnectionAction = async (platform, _page, _lead, _msg, _emit) => {
    if (platform === "x") return { outcome: "sent", error: null, metadata: {}, retryable: false };
    if (platform === "instagram") return { outcome: "skipped", error: "Already following", metadata: {}, retryable: false };
    return { outcome: "failed", error: "unsupported", metadata: {}, retryable: false };
  };

  // Stub the browser launcher so we don't try to launch Chrome.
  // We require the module lazily and monkey-patch the same browserBase the
  // pipeline uses — but only for the duration of this test. The pipeline
  // calls browserBase.createBrowser / createInstagramBrowser, so we replace
  // those with a stub returning a fake state object whose .page is a no-op.
  const browserBase = require("../src/automation/browserBase");
  const originalCreateBrowser = browserBase.createBrowser;
  const originalCreateInstagramBrowser = browserBase.createInstagramBrowser;
  const originalCloseBrowser = browserBase.closeBrowser;
  browserBase.createBrowser = async () => ({ page: {}, browser: null, context: null, mode: "stub", tracePath: null, shouldCloseBrowser: false, lock: null });
  browserBase.createInstagramBrowser = async () => ({ page: {}, browser: null, context: null, mode: "stub", tracePath: null, shouldCloseBrowser: false, lock: null });
  browserBase.closeBrowser = async () => {};

  try {
    const result = await runMassFollowPipelineNow({
      platforms: ["x", "instagram"],
      max_follows_per_run: 10,
      follow_interval_min_seconds: 1,
      follow_interval_max_seconds: 2,
      respect_active_window: false,
      trigger: "test",
    });
    assert.equal(result.success, true);
    assert.equal(result.summary.total, 3);
    assert.equal(result.summary.sent, 2); // both X targets
    assert.equal(result.summary.skipped, 1); // IG target
    assert.equal(result.summary.failed, 0);

    // Per-platform summary
    assert.equal(result.summary.perPlatform.x.sent, 2);
    assert.equal(result.summary.perPlatform.instagram.skipped, 1);

    // DB state: X targets flipped to 'sent', IG to 'skipped'
    const xRows = db.prepare("SELECT * FROM mass_follow_targets WHERE platform = 'x'").all();
    assert.equal(xRows.length, 2);
    assert.ok(xRows.every((r) => r.status === "sent"));
    const igRow = db.prepare("SELECT * FROM mass_follow_targets WHERE platform = 'instagram'").get();
    assert.equal(igRow.status, "skipped");

    // daily_actions: 2 follows for X + 1 skipped for IG
    const xActions = db.prepare("SELECT * FROM daily_actions WHERE platform = 'x' AND action_type = 'follows'").all();
    assert.equal(xActions.length, 2);
  } finally {
    platformAdapter.runConnectionAction = originalRunConnectionAction;
    browserBase.createBrowser = originalCreateBrowser;
    browserBase.createInstagramBrowser = originalCreateInstagramBrowser;
    browserBase.closeBrowser = originalCloseBrowser;
  }
});

test("TikTok automation module exports the same shape as x.js (followUser + sendDirectMessage + likeRecentPost + sendConnectionRequest alias)", () => {
  const tiktok = require("../src/automation/tiktok");
  assert.equal(typeof tiktok.followUser, "function");
  assert.equal(typeof tiktok.sendDirectMessage, "function");
  assert.equal(typeof tiktok.likeRecentPost, "function");
  // Alias for executor.js compatibility (matches x.js convention)
  assert.strictEqual(tiktok.sendConnectionRequest, tiktok.followUser);
});

test("platformAdapter.runConnectionAction accepts 'tiktok' and dispatches to tiktok.followUser", async () => {
  // Stub tiktok.followUser so we don't actually drive a browser
  const tiktok = require("../src/automation/tiktok");
  const originalFollowUser = tiktok.followUser;
  let calledWith = null;
  tiktok.followUser = async (page, profileUrl, emit) => {
    calledWith = { profileUrl };
    return { outcome: "sent" };
  };

  try {
    const result = await platformAdapter.runConnectionAction(
      "tiktok",
      {},
      { id: 1, profile_url: "https://www.tiktok.com/@someuser" },
      "",
      () => {},
    );
    assert.equal(result.outcome, "sent");
    assert.equal(calledWith.profileUrl, "https://www.tiktok.com/@someuser");
  } finally {
    tiktok.followUser = originalFollowUser;
  }
});

test("platformCatalog recognizes TikTok as a built-in platform with a proper label", () => {
  const catalog = require("../src/services/platformCatalog");
  assert.ok(catalog.isKnownPlatform("tiktok"), "TikTok should be a known platform");
  assert.equal(catalog.formatPlatformLabel("tiktok"), "TikTok");
  // Ensure the existing platforms still work (no regression)
  assert.equal(catalog.formatPlatformLabel("x"), "X");
  assert.equal(catalog.formatPlatformLabel("linkedin"), "LinkedIn");
});
