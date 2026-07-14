/**
 * Discovery Service — Timing, Rate-Limiting & Browser Lifecycle Helpers
 * Promise-based delay / timeout utilities, hourly visit throttling, daily-limit
 * delegation, and the per-platform Playwright browser-context open/close wrappers
 * plus a lightweight CAPTCHA detector.
 * Extracted from the original discoveryService.js for maintainability.
 */

const { getDb, isWithinLimit: dbIsWithinLimit } = require("../../db/database");
const {
  createBrowser,
  closeBrowser,
} = require("../../automation/browserBase");
const {
  MAX_PROFILE_VISITS_PER_HOUR,
  DEFAULT_MIN_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
} = require("./constants");
const { visitTimestamps } = require("./jobStreams");

/**
 * Plain setTimeout-based delay.
 */
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Race a promise against a timeout. Rejects with `${label} timed out after Ns`
 * if the timeout wins. The timer is always cleared on completion.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Sleep for a randomised window between DISCOVERY_MIN_DELAY_MS and
 * DISCOVERY_MAX_DELAY_MS (env-overridable; falls back to the constants above).
 */
async function randomActionDelay() {
  const min = Number(process.env.DISCOVERY_MIN_DELAY_MS || DEFAULT_MIN_DELAY_MS);
  const max = Number(process.env.DISCOVERY_MAX_DELAY_MS || DEFAULT_MAX_DELAY_MS);
  await delay(Math.floor(Math.random() * (max - min + 1)) + min);
}

/**
 * Throttle profile visits to MAX_PROFILE_VISITS_PER_HOUR per rolling 60-minute
 * window. Emits a status event if the throttle forces a pause.
 */
async function enforceVisitLimit(emit) {
  const cutoff = Date.now() - 3600000;
  while (visitTimestamps.length && visitTimestamps[0] < cutoff) visitTimestamps.shift();
  if (visitTimestamps.length >= MAX_PROFILE_VISITS_PER_HOUR) {
    const wait = visitTimestamps[0] + 3600000 - Date.now();
    emit({
      type: "info",
      message: `Hourly visit limit reached. Pausing ${Math.ceil(wait / 1000)}s`,
    });
    await delay(wait);
  }
  visitTimestamps.push(Date.now());
}

/**
 * Check if the daily limit for a platform and action type has been reached.
 * Delegates to the DB-backed isWithinLimit() in db/database.
 */
function isWithinLimit(platform, actionType) {
  return dbIsWithinLimit(platform, actionType);
}

/**
 * Open a Playwright browser context for a platform. Headless mode is allowed
 * only when ALLOW_HEADLESS_SOCIAL=true (defaults to headed for social sites).
 */
async function createBrowserContext(platform) {
  const allowHeadless = process.env.ALLOW_HEADLESS_SOCIAL === "true";
  return createBrowser(platform, { headless: allowHeadless });
}

/**
 * Close a previously-opened browser context, wrapped in a configurable timeout
 * (BROWSER_CLOSE_TIMEOUT_MS, default 20s) so a hung close can't stall a run.
 */
async function closeBrowserContext(platform, browserState) {
  if (!browserState) return;
  await withTimeout(
    closeBrowser(browserState.browser, platform, browserState.context, {
      mode: browserState.mode,
      tracePath: browserState.tracePath,
      shouldCloseBrowser: browserState.shouldCloseBrowser,
      lock: browserState.lock,
    }),
    Number(process.env.BROWSER_CLOSE_TIMEOUT_MS || 20_000),
    `${platform} browser close`,
  );
}

/**
 * Heuristic CAPTCHA / "verify you're human" / "unusual activity" detector.
 * Emits a `{ type: "captcha", platform, message }` event when triggered.
 */
async function detectCaptcha(page, platform, emit) {
  const text = (
    await page
      .locator("body")
      .innerText()
      .catch(() => "")
  ).toLowerCase();
  const found = ["captcha", "verify you're human", "unusual activity"].some((t) => text.includes(t));
  if (found) emit({ type: "captcha", platform, message: "CAPTCHA detected" });
  return found;
}

module.exports = {
  delay,
  withTimeout,
  randomActionDelay,
  enforceVisitLimit,
  isWithinLimit,
  createBrowserContext,
  closeBrowserContext,
  detectCaptcha,
};
