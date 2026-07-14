/**
 * T8 — Playwright Context Diagnostics
 *
 * Verifies headless Chromium execution via the shared CDP endpoint:
 *   1. Ensure the shared Chrome is listening (spawns launch-chrome.sh if not)
 *   2. Connect via chromium.connectOverCDP(...)
 *   3. Open a new tab and evaluate navigator.userAgent — must include "Chrome"
 *   4. Close the tab and disconnect
 */

const assert = require("assert");

const { getSharedCdpEndpoint, ensureSharedCdpChrome } = require("./_setup");

/**
 * @param {{}} ctx (no shared state needed)
 */
async function runPhase8() {
  console.log("Running T8 — Shared CDP Context Diagnostics...");
  const { chromium } = require("playwright");
  const cdpEndpoint = getSharedCdpEndpoint();

  await ensureSharedCdpChrome(cdpEndpoint);
  console.log(`Attaching to shared Chrome via CDP: ${cdpEndpoint}`);
  const browser = await chromium.connectOverCDP(cdpEndpoint);

  assert(browser !== null, "Playwright failed to attach to shared CDP Chrome.");

  const context = browser.contexts()[0] || await browser.newContext();

  assert(context !== null, "Playwright failed to get a CDP browser context.");

  const page = await context.newPage();
  assert(page !== null, "Playwright failed to open a new shared-CDP tab.");

  const userAgentEvaluated = await page.evaluate(() => navigator.userAgent);
  assert(
    userAgentEvaluated.includes("Chrome"),
    "Shared CDP tab did not evaluate a Chrome user agent.",
  );

  await page.close();
  await browser.close();
  console.log("✅ T8 Shared CDP Context Diagnostics — PASS\n");
}

module.exports = { runPhase8 };
