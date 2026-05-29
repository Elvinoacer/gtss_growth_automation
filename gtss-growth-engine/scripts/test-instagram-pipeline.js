#!/usr/bin/env node

/**
 * Integration Test Suite: Instagram Pipeline Logic & API Round-trip
 *
 * Verifies:
 * T1 — Migration integrity (ig_* columns & tables exist)
 * T2 — Instagram business profile filtering logic (filterBusinessProfile)
 * T3 — Instagram warmup sequence lifecycle (pending, due checking, completion, DM draft)
 * T4 — Rate limit enforcement (limits.instagram.follows simulation)
 * T5 — Block detection triggers (ig_blocked_until settings lifecycle)
 * T6 — Settings API round-trip (GET & POST /api/settings/instagram)
 * T7 — Warmup pipeline API (GET /api/instagram/warmup-pipeline shape assertion)
 * T8 — Playwright Context Diagnostics (Verifies headless Chromium execution & User-Agent injection)
 *
 */

require("dotenv").config();
const assert = require("assert");
const path = require("path");
const { getDb } = require("../src/db/database");

// Standard Test Port & Flag configuration to run server programmatically without worker crons
const TEST_PORT = process.env.PORT || 4567;
process.env.PORT = TEST_PORT;
process.env.DISABLE_BACKGROUND_JOBS = "true";

// Import Server Programmatically
const { server } = require("../src/server");

// Cleanup helper
function cleanupDb(db, leadId) {
  try {
    if (leadId) {
      db.prepare("DELETE FROM ig_warmup_sequences WHERE lead_id = ?").run(
        leadId,
      );
      db.prepare("DELETE FROM ig_follow_tracker WHERE lead_id = ?").run(leadId);
      db.prepare("DELETE FROM messages WHERE lead_id = ?").run(leadId);
      db.prepare("DELETE FROM leads WHERE id = ?").run(leadId);
    }
    db.prepare(
      "DELETE FROM leads WHERE ig_username = 'test_account_gtss'",
    ).run();
    db.prepare("DELETE FROM settings WHERE key = 'ig_blocked_until'").run();
  } catch (err) {
    console.error("[TEST CLEANUP] Warning during DB cleanup:", err.message);
  }
}

async function runTests() {
  const db = getDb();
  let testLeadId = null;

  console.log("=== GTSS INSTAGRAM PIPELINE INTEGRATION TEST SUITE ===\n");

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // T1 — Migration Integrity
    // ─────────────────────────────────────────────────────────────────────────
    console.log("Running T1 — Migration integrity...");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((t) => t.name);
    assert(
      tables.includes("ig_warmup_sequences"),
      "Table 'ig_warmup_sequences' is missing.",
    );
    assert(
      tables.includes("ig_follow_tracker"),
      "Table 'ig_follow_tracker' is missing.",
    );

    const columns = db
      .prepare("PRAGMA table_info(leads)")
      .all()
      .map((c) => c.name);
    const expectedIgColumns = [
      "ig_username",
      "ig_follower_count",
      "ig_following_count",
      "ig_post_count",
      "ig_is_business",
      "ig_business_category",
      "ig_has_email",
      "ig_has_phone",
      "ig_bio",
      "ig_warmup_status",
    ];

    for (const col of expectedIgColumns) {
      assert(
        columns.includes(col),
        `leads table is missing the required Instagram column '${col}'.`,
      );
    }
    console.log("✅ T1 Migration — PASS\n");

    // ─────────────────────────────────────────────────────────────────────────
    // T2 — Discovery Filter Logic
    // ─────────────────────────────────────────────────────────────────────────
    console.log("Running T2 — Discovery filter logic...");
    const {
      filterBusinessProfile,
    } = require("../src/automation/instagramDiscovery");

    const mockProfiles = [
      {
        profileData: {
          website: "https://gtss.co",
          follower_count: 500,
        },
        expected: true,
      },
      {
        profileData: {
          email: "hello@gtss.co",
          post_count: 25,
        },
        expected: true,
      },
      {
        profileData: {
          bio: "Founder & manager of a restaurant based in Nairobi",
          business_category: "Local Business",
        },
        expected: true,
      },
      {
        profileData: {
          follower_count: 10,
        },
        expected: false,
      },
      {
        profileData: {
          post_count: 2,
        },
        expected: false,
      },
    ];

    for (let i = 0; i < mockProfiles.length; i++) {
      const { profileData, expected } = mockProfiles[i];
      const res = filterBusinessProfile(profileData);
      assert.strictEqual(
        res.passes,
        expected,
        `T2 Profile #${i + 1} assertion failed: expected passes=${expected}, got ${res.passes}`,
      );
    }
    console.log("✅ T2 Filter logic — PASS\n");

    // ─────────────────────────────────────────────────────────────────────────
    // T3 — Warmup Sequence Lifecycle
    // ─────────────────────────────────────────────────────────────────────────
    console.log("Running T3 — Warmup sequence lifecycle...");
    const {
      startWarmupSequence,
      getLeadsDueForStep,
      completeWarmup,
    } = require("../src/automation/instagramWarmup");

    // Clear any leftover fixtures just in case
    cleanupDb(db);

    // Insert clean mock lead
    const leadInsert = db
      .prepare(
        `
      INSERT INTO leads (platform, name, profile_url, ig_username, status)
      VALUES ('instagram', 'Test Account GTSS', 'https://instagram.com/test_account_gtss', 'test_account_gtss', 'qualified')
    `,
      )
      .run();
    testLeadId = leadInsert.lastInsertRowid;

    // Start sequence
    const startRes = startWarmupSequence(testLeadId);
    assert.strictEqual(
      startRes.success,
      true,
      `Failed to start sequence: ${startRes.error}`,
    );

    // Verify pending record
    const seqRecord = db
      .prepare("SELECT * FROM ig_warmup_sequences WHERE lead_id = ?")
      .get(testLeadId);
    assert(seqRecord !== undefined, "Warmup sequence row was not created.");
    assert.strictEqual(
      seqRecord.status,
      "pending",
      `Expected status='pending', got '${seqRecord.status}'`,
    );

    // Direct timestamp modification to simulate due sequence
    db.prepare(
      `
      UPDATE ig_warmup_sequences
      SET next_step_after = datetime('now', '-1 hour')
      WHERE lead_id = ?
    `,
    ).run(testLeadId);

    // Verify lead shows in getLeadsDueForStep list
    const dueList = getLeadsDueForStep();
    const isDueInList = dueList.some((item) => item.leadId === testLeadId);
    assert(
      isDueInList,
      "Test lead should be flagged as due after next_step_after modification.",
    );

    // Complete warmup
    const completeRes = completeWarmup(testLeadId);
    assert.strictEqual(
      completeRes.success,
      true,
      `Failed to complete warmup: ${completeRes.error}`,
    );

    // Assert DM draft creation inside messages table
    const msgRecord = db
      .prepare(
        `
      SELECT * FROM messages
      WHERE lead_id = ? AND platform = 'instagram' AND status = 'draft' AND action_type = 'instagram_dm'
    `,
      )
      .get(testLeadId);
    assert(
      msgRecord !== undefined,
      "Instagram DM draft was not generated in messages table upon sequence completion.",
    );
    console.log("✅ T3 Warmup sequence lifecycle — PASS\n");

    // ─────────────────────────────────────────────────────────────────────────
    // T4 — Rate Limit Enforcement
    // ─────────────────────────────────────────────────────────────────────────
    console.log("Running T4 — Rate limit enforcement...");
    const limits = require("../src/config/limits");
    const followsDailyLimit = limits.instagram.follows;

    // Clear tracker clean slate
    db.prepare("DELETE FROM ig_follow_tracker").run();

    // Insert daily limit threshold count
    const trackerInsert = db.prepare(`
      INSERT INTO ig_follow_tracker (lead_id, username, status, followed_at)
      VALUES (?, ?, 'following', datetime('now', 'localtime'))
    `);
    for (let i = 0; i < followsDailyLimit; i++) {
      trackerInsert.run(testLeadId, `mock_follow_${i}`);
    }

    // Daily limit check function
    function checkInstagramDailyLimit() {
      const currentFollows = db
        .prepare(
          `
        SELECT COUNT(*) AS count
        FROM ig_follow_tracker
        WHERE DATE(followed_at) = DATE('now', 'localtime')
      `,
        )
        .get().count;

      return { limitReached: currentFollows >= followsDailyLimit };
    }

    const checkRes = checkInstagramDailyLimit();
    assert.strictEqual(
      checkRes.limitReached,
      true,
      "Rate limit enforcement should trigger when follows equal configured limits.",
    );
    console.log("✅ T4 Rate limit enforcement — PASS\n");

    // ─────────────────────────────────────────────────────────────────────────
    // T5 — Block Detection
    // ─────────────────────────────────────────────────────────────────────────
    console.log("Running T5 — Block detection...");
    const {
      setInstagramBlockedUntil,
      isInstagramBlocked,
    } = require("../src/automation/browserBase");

    // Set block
    setInstagramBlockedUntil(24);
    let blockCheck = isInstagramBlocked();
    assert.strictEqual(
      blockCheck.blocked,
      true,
      "Instagram should return blocked: true after triggering blocks.",
    );

    // Clear block
    db.prepare("DELETE FROM settings WHERE key = 'ig_blocked_until'").run();
    blockCheck = isInstagramBlocked();
    assert.strictEqual(
      blockCheck.blocked,
      false,
      "Instagram should return blocked: false after database key cleanup.",
    );
    console.log("✅ T5 Block detection — PASS\n");

    // ─────────────────────────────────────────────────────────────────────────
    // T6 — Settings API
    // ─────────────────────────────────────────────────────────────────────────
    console.log("Running T6 — Settings API...");
    const settingsPayload = {
      warmup_min_follow_to_story_hours: 6,
      warmup_max_follow_to_story_hours: 12,
      fast_warmup_enabled: 1,
      auto_warmup_on_qualify: 0,
    };

    // Call POST API
    const postResponse = await fetch(
      `http://localhost:${TEST_PORT}/api/settings/instagram`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settingsPayload),
      },
    );
    assert.strictEqual(
      postResponse.status,
      200,
      `POST Settings failed with status: ${postResponse.status}`,
    );
    const postData = await postResponse.json();
    assert.strictEqual(
      postData.success,
      true,
      "POST Response success state mismatch.",
    );

    // Call GET API
    const getResponse = await fetch(
      `http://localhost:${TEST_PORT}/api/settings/instagram`,
    );
    assert.strictEqual(
      getResponse.status,
      200,
      `GET Settings failed with status: ${getResponse.status}`,
    );
    const getData = await getResponse.json();

    // Verify round-trip matches
    for (const [key, value] of Object.entries(settingsPayload)) {
      assert.strictEqual(
        Number(getData[key]),
        value,
        `Round-trip settings validation mismatch on key '${key}': expected ${value}, got ${getData[key]}`,
      );
    }
    console.log("✅ T6 Settings API — PASS\n");

    // ─────────────────────────────────────────────────────────────────────────
    // T7 — Warmup Pipeline API
    // ─────────────────────────────────────────────────────────────────────────
    console.log("Running T7 — Warmup pipeline API...");
    const pipelineResponse = await fetch(
      `http://localhost:${TEST_PORT}/api/instagram/warmup-pipeline`,
    );
    assert.strictEqual(
      pipelineResponse.status,
      200,
      `GET Warmup-pipeline failed with status: ${pipelineResponse.status}`,
    );
    const pipelineData = await pipelineResponse.json();

    assert(
      pipelineData.stats !== undefined,
      "Warmup-pipeline shape assertion failed: missing 'stats' key.",
    );
    assert(
      pipelineData.pipeline !== undefined,
      "Warmup-pipeline shape assertion failed: missing 'pipeline' key.",
    );
    assert(
      Array.isArray(pipelineData.pipeline),
      "Warmup-pipeline shape assertion failed: 'pipeline' is not an array.",
    );
    console.log("✅ T7 Warmup pipeline API — PASS\n");

    // ─────────────────────────────────────────────────────────────────────────
    // T8 — Playwright Context Diagnostics
    // ─────────────────────────────────────────────────────────────────────────
    console.log("Running T8 — Playwright Context Diagnostics...");
    const { chromium } = require("playwright");

    console.log("Initializing headless Playwright Chromium instance...");
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    assert(browser !== null, "Playwright failed to launch Chromium browser.");

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });

    assert(context !== null, "Playwright failed to create browser context.");

    const page = await context.newPage();
    assert(page !== null, "Playwright failed to create a new page.");

    const userAgentEvaluated = await page.evaluate(() => navigator.userAgent);
    assert(
      userAgentEvaluated.includes("Chrome"),
      "User-Agent was not properly injected or evaluated.",
    );

    await browser.close();
    console.log("✅ T8 Playwright Context Diagnostics — PASS\n");

    // ─────────────────────────────────────────────────────────────────────────
    // T9 — Tooltip Flow Verification
    // ─────────────────────────────────────────────────────────────────────────
    console.log("Running T9 — [tooltip-flow] Instagram Create tooltip flow...");
    const {
      createInstagramBrowser,
      closeBrowser,
      firstVisible,
    } = require("../src/automation/browserBase");

    const IG_SELECTORS = {
      postCreate: [
        'svg[aria-label="New post"]',
        'svg[aria-label="Create"]',
        'span:has-text("Create")',
        'a[href*="/create"] span',
        'a[href="/create/"] span',
        'div[role="button"] svg[aria-label="New post"]',
        'a[role="link"]:has(svg[aria-label="Create"])',
        'div[role="button"]:has(svg[aria-label="Create"])',
      ],
      postCreateTooltipPost: [
        'span:has-text("Post")',
        'div[role="button"]:has-text("Post")',
        'a:has-text("Post")',
        '[role="menuitem"]:has-text("Post")',
        'div[tabindex="0"]:has-text("Post")',
        'a[role="link"]:has-text("Post")',
      ],
    };

    const tooltipFlowStart = Date.now();
    let tooltipBrowserState = null;
    try {
      tooltipBrowserState = await createInstagramBrowser();
      const {
        browser: igBrowser,
        context: igContext,
        page: igPage,
      } = tooltipBrowserState;

      await igPage.goto("https://www.instagram.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await igPage.bringToFront().catch(() => {});

      const createBtn = await firstVisible(
        igPage,
        IG_SELECTORS.postCreate,
        8000,
      );
      assert(createBtn, "[tooltip-flow] Create button not found.");

      const popupPromise = igPage
        .waitForEvent("popup", { timeout: 3000 })
        .catch(() => null);
      const clickStart = Date.now();
      await createBtn.click();

      const tooltipPostBtn = await firstVisible(
        igPage,
        IG_SELECTORS.postCreateTooltipPost,
        4000,
      ).catch(() => null);
      const tooltipElapsedMs = Date.now() - clickStart;
      console.log(
        `[tooltip-flow] Tooltip ${tooltipPostBtn ? "appeared" : "did not appear"} in ${tooltipElapsedMs}ms`,
      );

      if (tooltipPostBtn) {
        await tooltipPostBtn.click();
        await igPage.waitForTimeout(800);
      } else {
        console.log(
          "[tooltip-flow] No tooltip found — assuming modal opens directly",
        );
      }

      await igPage.waitForTimeout(800);

      let activePage = igPage;
      const popup = await popupPromise;
      if (popup) {
        activePage = popup;
        await activePage.bringToFront().catch(() => {});
        await activePage.waitForLoadState("domcontentloaded").catch(() => {});
      }

      const fileInputLocator = activePage.locator('input[type="file"]');
      await fileInputLocator.waitFor({ state: "attached", timeout: 15000 });

      console.log(
        `[tooltip-flow] PASS in ${Date.now() - tooltipFlowStart}ms (tooltip=${tooltipPostBtn ? "yes" : "no"}, fileInputAttached=yes)`,
      );

      await closeBrowser(igBrowser, "instagram", igContext, {
        mode: tooltipBrowserState.mode || "persistent",
      }).catch(() => {});
    } catch (err) {
      console.error(
        `[tooltip-flow] FAIL after ${Date.now() - tooltipFlowStart}ms: ${err.message}`,
      );
      if (tooltipBrowserState) {
        await closeBrowser(
          tooltipBrowserState.browser,
          "instagram",
          tooltipBrowserState.context,
          { mode: tooltipBrowserState.mode || "persistent" },
        ).catch(() => {});
      }
      throw err;
    }

    // Cleanup & Shutdown successfully
    cleanupDb(db, testLeadId);
    console.log("Database successfully cleaned of mock integration test data.");
    console.log("🎉 ALL TESTS PASSED SUCCESSFULLY! EXITING 0.");
    server.close(() => {
      process.exit(0);
    });
  } catch (err) {
    console.error(`\n❌ TEST SUITE FAILED with error:\n${err.stack}\n`);
    cleanupDb(db, testLeadId);
    server.close(() => {
      process.exit(1);
    });
  }
}

// Start tests
runTests();
