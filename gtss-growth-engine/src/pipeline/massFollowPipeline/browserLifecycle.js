/**
 * massFollowPipeline/browserLifecycle.js
 *
 * Launch / close per-platform browser contexts for the platforms that have
 * targets in this batch. Reuses browserBase's platform factories directly
 * (instead of going through backgroundJobs) to avoid a require cycle
 * (backgroundJobs → processConnectionQueue → platformAdapter vs.
 * here → platformAdapter).
 *
 * launchBrowsersForPlatforms returns a { [platform]: browserState } map where
 * each value is either:
 *   - the full { browser, context, page, ... } state from browserBase, OR
 *   - { error: string } if that platform's browser failed to launch (so the
 *     runner can mark its targets 'session_required' instead of crashing).
 *
 * closeBrowsersForPlatforms safely closes every browser/context that was
 * opened, ignoring per-platform errors so one stuck close doesn't leak the
 * others.
 */

const browserBase = require("../../automation/browserBase");
const logger = require("../../utils/logger");

async function launchBrowsersForPlatforms(platforms, showBrowser = false) {
  const activePages = {};
  // If the user explicitly asked to see the browser (show_browser: true), run
  // headed. Otherwise fall back to the env-driven headless behavior.
  const headless = showBrowser ? false : process.env.ALLOW_HEADLESS_SOCIAL === "true";
  for (const platform of platforms) {
    try {
      let state;
      if (platform === "instagram") {
        state = await browserBase.createInstagramBrowser({ headless });
      } else {
        state = await browserBase.createBrowser(platform, { headless });
      }
      activePages[platform] = state;
    } catch (err) {
      logger.error(
        "MASS-FOLLOW-PIPELINE",
        `Failed to launch browser for ${platform}: ${err.message}`,
      );
      // Don't fail the whole batch — we'll mark this platform's targets as
      // 'session_required' so they retry next run.
      activePages[platform] = { error: err.message };
    }
  }
  return activePages;
}

async function closeBrowsersForPlatforms(activePages) {
  for (const [platform, state] of Object.entries(activePages)) {
    if (!state || !state.browser) continue;
    try {
      await browserBase.closeBrowser(state.browser, platform, state.context, {
        mode: state.mode,
        tracePath: state.tracePath,
        shouldCloseBrowser: state.shouldCloseBrowser,
        lock: state.lock,
      });
    } catch (err) {
      logger.warn(
        "MASS-FOLLOW-PIPELINE",
        `Error closing browser for ${platform}: ${err.message}`,
      );
    }
  }
}

module.exports = { launchBrowsersForPlatforms, closeBrowsersForPlatforms };
