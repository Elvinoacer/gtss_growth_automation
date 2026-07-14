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
 * T9 — Tooltip Flow Verification (Instagram Create tooltip → file input modal)
 *
 * This file is the entry point. The actual phase logic lives in
 * ./test-instagram-pipeline/phaseN-*.js and is orchestrated below. The
 * original ~627-line monolith was split for maintainability.
 */

const { getDb, server, cleanupDb } = require("./test-instagram-pipeline/_setup");
const { runPhase1 } = require("./test-instagram-pipeline/phase1-migration");
const { runPhase2 } = require("./test-instagram-pipeline/phase2-discovery");
const { runPhase3 } = require("./test-instagram-pipeline/phase3-warmup");
const { runPhase4 } = require("./test-instagram-pipeline/phase4-rateLimit");
const { runPhase5 } = require("./test-instagram-pipeline/phase5-blockDetection");
const { runPhase6 } = require("./test-instagram-pipeline/phase6-settingsApi");
const { runPhase7 } = require("./test-instagram-pipeline/phase7-warmupPipelineApi");
const { runPhase8 } = require("./test-instagram-pipeline/phase8-cdpContext");
const { runPhase9 } = require("./test-instagram-pipeline/phase9-tooltipFlow");

async function runTests() {
  const db = getDb();
  let testLeadId = null;
  const ctx = {
    db,
    get testLeadId() {
      return testLeadId;
    },
    setTestLeadId(id) {
      testLeadId = id;
    },
  };

  try {
    await runPhase1(ctx);
    await runPhase2(ctx);
    await runPhase3(ctx);
    await runPhase4(ctx);
    await runPhase5(ctx);
    await runPhase6(ctx);
    await runPhase7(ctx);
    await runPhase8(ctx);
    await runPhase9(ctx);

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
