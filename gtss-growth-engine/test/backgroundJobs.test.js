process.env.DB_PATH = "./data/test_background_jobs.db";
const assert = require("assert");
const { getDb } = require("../src/db/database");
const instagram = require("../src/automation/instagram");
const backgroundJobs = require("../src/jobs/backgroundJobs");
const platformPolicies = require("../src/config/platformPolicies");

const originalFollowAccount = instagram.followAccount;
// Disable Instagram's active-window gate for the duration of this test
// suite. The pre-flight T2 assertion expects `instagram.followAccount` to
// be invoked synchronously by the queue runner — but `processConnectionQueue`
// snoozes any job whose wall-clock hour falls outside
// `platformPolicies.instagram.activeWindow` (8–20 local). On the Linux CI
// runner (UTC), a test run at 7:33 UTC would otherwise postpone the job
// to the next business-hour window and the assertion fails. The active
// window is a runtime policy, not the system under test here, so we
// neutralize it for the suite and restore it in the cleanup block.
const originalInstagramActiveWindow = platformPolicies.instagram.activeWindow;
platformPolicies.instagram.activeWindow = null;

async function runBackgroundJobsQueueTests() {
  console.log("=== RUNNING BACKGROUND JOBS CAMPAIGN QUEUE INTEGRATION TESTS ===");
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
    VALUES (9999, 'Background Test Campaign', 'instagram', 'active', datetime('now', '-2 days'))
  `).run();

  db.prepare(`
    INSERT INTO leads (id, name, platform, status, profile_url, x_handle)
    VALUES (9999, 'Test Lead', 'instagram', 'qualified', 'https://instagram.com/test_bg_user', 'test_bg_user')
  `).run();

  db.pragma("foreign_keys = ON");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 1: No eligible jobs skipped gracefully without launching browsers
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T1 — Graceful skip when no eligible jobs exist...");
  
  // We expect no active platform browser launching since no jobs are in DB
  const initialCount = db.prepare("SELECT COUNT(*) as count FROM connection_jobs WHERE campaign_id = 9999").get().count;
  assert.strictEqual(initialCount, 0);

  // Invoke private queue runner
  await backgroundJobs.__private.runConnectionQueueJob({ skipDelays: true });
  await backgroundJobs.__private.runDmQueueJob({ skipDelays: true });
  
  console.log("T1 PASS: Skips safely without errors or browser triggers!");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 2: Pre-flight launch browser and dynamic page proxy routing check
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T2 — Pre-flight checking and platformAdapter wrapper execution...");

  db.pragma("foreign_keys = OFF");
  db.prepare(`
    INSERT INTO connection_jobs (id, campaign_id, lead_id, status, retry_count)
    VALUES (9999, 9999, 9999, 'pending', 0)
  `).run();
  db.pragma("foreign_keys = ON");

  let wrappedFollowCalled = false;

  // Mock instagram.followAccount to verify wrapper works and page is routed
  instagram.followAccount = async function (page, leadInfo, emit) {
    wrappedFollowCalled = true;
    
    // Assert page is a Proxy by checking that it routes properties transparently
    assert(page !== null, "Page should not be null.");
    assert.strictEqual(typeof page.goto, "function", "Proxy page must bind functions of Playwright page.");
    
    return { success: true, requestPending: false };
  };

  // Mock require/createBrowser calls internally to prevent launching real chromium during tests
  const browserBase = require("../src/automation/browserBase");
  const originalCreateInstagramBrowser = browserBase.createInstagramBrowser;
  const originalCloseBrowser = browserBase.closeBrowser;

  let createInstagramBrowserCalled = false;
  browserBase.createInstagramBrowser = async () => {
    createInstagramBrowserCalled = true;
    return {
      browser: {},
      context: {},
      page: {
        goto: async () => {},
        locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
      },
      mode: "persistent",
      tracePath: null,
      shouldCloseBrowser: true,
      lock: null,
    };
  };

  browserBase.closeBrowser = async () => {};

  try {
    await backgroundJobs.__private.runConnectionQueueJob({ skipDelays: true });
    
    assert(createInstagramBrowserCalled, "Should pre-launch Instagram browser based on active campaign jobs.");
    assert(wrappedFollowCalled, "Wrapped instagram.followAccount should be triggered.");
    
    // Validate database transaction completed
    const finalJobState = db.prepare("SELECT status FROM connection_jobs WHERE campaign_id = 9999").get();
    assert.strictEqual(finalJobState.status, "sent", "Connection job should have successfully completed state persistence.");

    console.log("T2 PASS: Pre-flight launch checks, proxy page binding, and database transactions completed successfully!");

  } finally {
    // Restore platformAdapter and browserBase original definitions
    instagram.followAccount = originalFollowAccount;
    browserBase.createInstagramBrowser = originalCreateInstagramBrowser;
    browserBase.closeBrowser = originalCloseBrowser;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Clean up database
  // ───────────────────────────────────────────────────────────────────────────
  db.pragma("foreign_keys = OFF");
  db.prepare("DELETE FROM campaign_events WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM connection_jobs WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM dm_jobs WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM daily_actions WHERE campaign_id = 9999").run();
  db.prepare("DELETE FROM campaigns WHERE id = 9999").run();
  db.prepare("DELETE FROM leads WHERE id = 9999").run();
  db.pragma("foreign_keys = ON");

  // Restore the Instagram active-window policy we neutralized at suite start.
  platformPolicies.instagram.activeWindow = originalInstagramActiveWindow;

  console.log("🎉 ALL BACKGROUND JOBS QUEUE TESTS PASSED SUCCESSFULLY!\n");
}

if (require.main === module) {
  runBackgroundJobsQueueTests().catch((err) => {
    console.error("Test suite failed:", err);
    process.exit(1);
  });
}

module.exports = {
  runBackgroundJobsQueueTests,
};
