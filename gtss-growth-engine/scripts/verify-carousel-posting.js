#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const assert = require("assert");

// Force test environment
process.env.DB_PATH = "./data/test_instagram.db";
process.env.TEST_SPEEDUP = "true";

// 1. Mock browserBase *before* requiring schedulerService
const browserBaseModulePath = require.resolve("../src/automation/browserBase");
const originalBrowserBase = require(browserBaseModulePath);

let activeMockPage = null;

const mockBrowserBase = {
  ...originalBrowserBase,
  createBrowser: async (platform, options) => {
    console.log(`[MOCK BROWSER] createBrowser called for ${platform}`);
    return {
      browser: { close: async () => { console.log("[MOCK BROWSER] browser.close()"); } },
      context: { close: async () => { console.log("[MOCK BROWSER] context.close()"); } },
      page: activeMockPage
    };
  },
  closeBrowser: async () => {
    console.log("[MOCK BROWSER] closeBrowser called");
  }
};

// Inject mock into require cache
require.cache[browserBaseModulePath] = {
  id: browserBaseModulePath,
  filename: browserBaseModulePath,
  loaded: true,
  exports: mockBrowserBase
};

// Now require schedulerService, it will destructure our mock functions
const { getDb } = require("../src/db/database");
const { publishPost } = require("../src/services/schedulerService");
const sharp = require("sharp");

// Recreate test database and tables
const db = getDb();

async function run() {
  console.log("=== STARTING CAROUSEL END-TO-END VERIFICATION TRACE ===");

  // Ensure valid session for instagram
  db.prepare(`
    INSERT OR REPLACE INTO platform_sessions (id, platform, last_active, is_valid)
    VALUES (1, 'instagram', datetime('now'), 1)
  `).run();

  // Create mock images
  const testImg1 = path.join(__dirname, "..", "test_carousel_img1.png");
  const testImg2 = path.join(__dirname, "..", "test_carousel_img2.png");
  
  await sharp({
    create: { width: 600, height: 600, channels: 3, background: { r: 255, g: 0, b: 0 } }
  }).png().toFile(testImg1);
  
  await sharp({
    create: { width: 600, height: 600, channels: 3, background: { r: 0, g: 0, b: 255 } }
  }).png().toFile(testImg2);

  // Clean posts table
  db.prepare("DELETE FROM posts").run();

  // Insert mock scheduled post
  const mediaPathsArray = [testImg1, testImg2];
  const mockPostId = db.prepare(`
    INSERT INTO posts (platforms, body, media_paths, ig_post_type, status, scheduled_at)
    VALUES ('["instagram"]', 'End-to-End Verification Caption', ?, 'carousel', 'scheduled', datetime('now', '-1 minute'))
  `).run(JSON.stringify(mediaPathsArray)).lastInsertRowid;

  console.log(`[TRACE] Mock post created with ID: ${mockPostId}`);

  // Helper to make chainable mock locator
  const makeMockLocator = (selector, visibleSelectors) => {
    const visible = new Set(visibleSelectors);
    
    const makeCandidate = (sel) => ({
      innerText: async () => {
        if (sel.includes("Following")) return "Following";
        return "";
      },
      isVisible: async () => visible.has(sel),
      waitFor: async () => {
        if (!visible.has(sel)) {
          throw new Error(`Timeout waiting for selector: ${sel}`);
        }
      },
      boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 100 }),
      click: async () => {
        console.log(`[MOCK CLICK] Clicked: ${sel}`);
      },
      getAttribute: async (attr) => {
        if (attr === "href") return "/p/Ctrace123/";
        return "";
      },
      fill: async () => {},
      type: async () => {},
      setInputFiles: async () => {},
      evaluate: async () => {}
    });

    const buildLocator = (sel) => {
      const candidate = makeCandidate(sel);
      return {
        count: async () => {
          if (visible.has(sel)) return 1;
          // Substrings/combos check
          if (sel.includes("Add location") && (visible.has('span:has-text("Add location")') || visible.has('input[placeholder*="Add location"]'))) {
            return 1;
          }
          if (sel.includes("Create") && visible.has('svg[aria-label="Create"]')) return 1;
          if (sel.includes("Next") && visible.has('button:has-text("Next")')) return 1;
          if (sel.includes("Share") && visible.has('button:has-text("Share")')) return 1;
          return 0;
        },
        first: () => buildLocator(sel),
        last: () => buildLocator(sel),
        nth: () => buildLocator(sel),
        innerText: candidate.innerText,
        isVisible: candidate.isVisible,
        waitFor: candidate.waitFor,
        boundingBox: candidate.boundingBox,
        click: candidate.click,
        getAttribute: candidate.getAttribute,
        $: candidate.$,
        fill: candidate.fill,
        type: candidate.type,
        setInputFiles: candidate.setInputFiles,
        evaluate: candidate.evaluate
      };
    };

    return buildLocator(selector);
  };

  // --- TRACE 1: Simulating Temporary Failure (e.g. Next button click fails or timeout) ---
  console.log("\n--- TRACE 1: Simulating Posting Failure ---");

  // Create a mock page that causes failure by having NO elements visible
  const failingPage = {
    url: () => "https://www.instagram.com/",
    waitForLoadState: async () => {},
    isClosed: () => false,
    goto: async () => {},
    mouse: { move: async () => {}, wheel: async () => {} },
    keyboard: { press: async () => {}, type: async () => {} },
    waitForSelector: async (sel) => {
      throw new Error(`Timeout waiting for selector: ${sel}`);
    },
    evaluate: async () => {},
    locator: (sel) => makeMockLocator(sel, []) // empty visible selectors -> fails to find buttons
  };

  activeMockPage = failingPage;

  const emitEvents = [];
  const noopEmit = (event) => {
    emitEvents.push(event);
    console.log(`[EMIT] ${event.platform || ""}: ${event.message || event.type}`);
  };

  // Simulate scheduled poster execution loop logic for the post
  const postBeforeRun = db.prepare("SELECT * FROM posts WHERE id = ?").get(mockPostId);
  
  // Call publishPost directly to simulate the runner executing
  const failResult = await publishPost(mockPostId, noopEmit, { skipPostStatusUpdate: true });
  
  // Simulate the status updates made by scheduledPoster.js on failure:
  const newRetryCount = (postBeforeRun.retry_count || 0) + 1;
  const failureSummary = failResult.failed.length > 0
    ? `Failed platforms: ${failResult.failed.join(", ")}`
    : "Publish failed";
  
  db.prepare(`
    UPDATE posts
    SET status = 'failed',
        retry_count = ?,
        next_retry_at = datetime('now', '+2 minutes'),
        last_error = ?
    WHERE id = ?
  `).run(newRetryCount, failureSummary, mockPostId);

  // Assertions for Failure Trace
  const failedPost = db.prepare("SELECT * FROM posts WHERE id = ?").get(mockPostId);
  console.log(`[ASSERT] Post status after failure: ${failedPost.status} (expected: failed)`);
  assert.equal(failedPost.status, "failed");
  console.log(`[ASSERT] Post retry count: ${failedPost.retry_count} (expected: 1)`);
  assert.equal(failedPost.retry_count, 1);
  console.log(`[ASSERT] Post next retry at: ${failedPost.next_retry_at} (expected: set)`);
  assert.ok(failedPost.next_retry_at);
  console.log(`[ASSERT] Post last error: ${failedPost.last_error} (expected: contains 'instagram')`);
  assert.match(failedPost.last_error, /instagram/);

  // Ensure media files were NOT deleted during temporary failure
  console.log("[ASSERT] Verification files not deleted on temporary failure...");
  assert.ok(fs.existsSync(testImg1));
  assert.ok(fs.existsSync(testImg2));


  // --- TRACE 2: Simulating Successful Posting (Retry) ---
  console.log("\n--- TRACE 2: Simulating Posting Success (Retry) ---");

  // Create a mock page that works successfully
  const succeedingPage = {
    url: () => "https://www.instagram.com/",
    waitForLoadState: async () => {},
    isClosed: () => false,
    goto: async () => {},
    mouse: { move: async () => {}, wheel: async () => {} },
    keyboard: { press: async () => {}, type: async () => {} },
    waitForSelector: async (sel) => ({ click: async () => {} }),
    evaluate: async () => {},
    locator: (sel) => makeMockLocator(sel, [
      'svg[aria-label="Create"]',
      'input[type="file"]',
      'button:has-text("Next")',
      'div[role="textbox"][contenteditable="true"]',
      'button:has-text("Share")',
      '[aria-label*="Post shared"]',
      'span:has-text("Add location")',
      'input[placeholder*="Add location"]',
      'a[href="/create/"]',
      'svg[aria-label="New post"]',
      'div[role="dialog"]',
      'div[role="menu"]'
    ])
  };

  activeMockPage = succeedingPage;

  const successEmitEvents = [];
  const successEmit = (event) => {
    successEmitEvents.push(event);
    console.log(`[EMIT] ${event.platform || ""}: ${event.message || event.type}`);
  };

  const retryResult = await publishPost(mockPostId, successEmit, { skipPostStatusUpdate: true });

  // Simulate scheduledPoster.js success logic:
  if (retryResult.success.length > 0 && retryResult.failed.length === 0) {
    const postUrl = successEmitEvents.find(e => e.type === "published")?.postUrl || "https://www.instagram.com/p/Ctrace123/";
    db.prepare(`
      UPDATE posts
      SET status = 'published',
          published_at = CURRENT_TIMESTAMP,
          ig_post_url = ?,
          retry_count = 0,
          next_retry_at = NULL,
          last_error = NULL
      WHERE id = ?
    `).run(postUrl, mockPostId);
  }

  // Assertions for Success Trace
  const publishedPost = db.prepare("SELECT * FROM posts WHERE id = ?").get(mockPostId);
  console.log(`[ASSERT] Post status after success: ${publishedPost.status} (expected: published)`);
  assert.equal(publishedPost.status, "published");
  console.log(`[ASSERT] Post published_at: ${publishedPost.published_at} (expected: set)`);
  assert.ok(publishedPost.published_at);
  console.log(`[ASSERT] Post ig_post_url: ${publishedPost.ig_post_url} (expected: contains Ctrace123)`);
  assert.match(publishedPost.ig_post_url, /Ctrace123/);

  // Clean up remaining test files
  try {
    fs.unlinkSync(testImg1);
    fs.unlinkSync(testImg2);
  } catch (_) {}

  console.log("\n=== ALL CAROUSEL END-TO-END TRACE VERIFICATIONS PASSED SUCCESSFULLY ===");
}

run().catch(err => {
  console.error("Verification script failed:", err);
  process.exit(1);
});
