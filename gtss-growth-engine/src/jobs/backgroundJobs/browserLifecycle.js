/**
 * backgroundJobs/browserLifecycle.js
 *
 * Pre-launch and clean up Playwright browser contexts for the campaign
 * queue runners (runConnectionQueueJob / runDmQueueJob).
 *
 *  - launchRequiredBrowsers(platforms): for each platform the queue has
 *    pending work for, pre-launch the browser context (createInstagramBrowser
 *    for IG, createBrowser for the others) so the queue runner doesn't
 *    pay the cold-start cost on the first action. Returns a map of
 *    platform → browserState. On any platform's launch failure, rolls
 *    back and closes every already-launched context (so we don't leak
 *    browsers on a partial-success launch).
 *  - closeAllActivePages(activePages): close every browser context in
 *    the map (best-effort, logs and continues on per-platform close
 *    failures so one stuck context doesn't block the others).
 *  - createProxyPage(activePages): return a transparent Proxy whose
 *    get() handler dispatches every property access to the page of the
 *    currently-active platform (state.currentPlatform, set by the
 *    platformAdapterWrappers). This is what lets processConnectionQueue
 *    and processDmQueue call page.goto / page.click / etc. without
 *    having to thread the platform through every call — the Proxy
 *    forwards to whichever platform's pre-launched page is in flight.
 */

const browserBase = require("../../automation/browserBase");
const logger = require("../../utils/logger");
const { state } = require("./state");

/**
 * Pre-launch Playwright browser contexts for required campaign outreach platforms.
 *
 * @param {Array<string>} platforms - Platforms needing browser instances in the current run.
 * @returns {Promise<Object>} Map of platform keys to active browser state objects.
 */
async function launchRequiredBrowsers(platforms) {
  const activePages = {};
  for (const platform of platforms) {
    const normPlatform = platform.toLowerCase().trim();
    try {
      logger.info(
        "SERVER",
        `[CAMPAIGN-QUEUES] Pre-launching browser context for platform: ${normPlatform}`,
      );
      let browserState;
      if (normPlatform === "instagram") {
        browserState = await browserBase.createInstagramBrowser();
      } else {
        browserState = await browserBase.createBrowser(normPlatform, {
          headless: process.env.ALLOW_HEADLESS_SOCIAL === "true",
        });
      }
      activePages[normPlatform] = browserState;
    } catch (err) {
      logger.error(
        "SERVER",
        `[CAMPAIGN-QUEUES] Failed to launch browser for platform: ${normPlatform}`,
        err,
      );
      // Rollback clean up already launched contexts
      for (const [p, st] of Object.entries(activePages)) {
        try {
          await browserBase.closeBrowser(st.browser, p, st.context, {
            mode: st.mode,
            tracePath: st.tracePath,
            shouldCloseBrowser: st.shouldCloseBrowser,
            lock: st.lock,
          });
        } catch (_) {
          /* ignore */
        }
      }
      throw err;
    }
  }
  return activePages;
}

/**
 * Clean up and close all active campaign queue browser pages/contexts.
 *
 * @param {Object} activePages - Map of platform keys to active browser states.
 */
async function closeAllActivePages(activePages) {
  for (const [platform, st] of Object.entries(activePages)) {
    try {
      logger.info(
        "SERVER",
        `[CAMPAIGN-QUEUES] Closing background browser context for platform: ${platform}`,
      );
      await browserBase.closeBrowser(st.browser, platform, st.context, {
        mode: st.mode,
        tracePath: st.tracePath,
        shouldCloseBrowser: st.shouldCloseBrowser,
        lock: st.lock,
      });
    } catch (err) {
      logger.error(
        "SERVER",
        `[CAMPAIGN-QUEUES] Error during browser closure for ${platform}`,
        err,
      );
    }
  }
}

/**
 * Create a transparent dynamic Proxy that maps standard Playwright page calls
 * to the currently active platform's pre-launched page context.
 *
 * The Proxy's get() handler reads state.currentPlatform (set by the
 * platformAdapterWrappers when runConnectionAction / runDmAction is
 * called), looks up the corresponding pre-launched page in activePages,
 * and returns the property — bound to the real page if it's a function
 * (so `page.goto(...)` becomes `realPage.goto(...)`), or the value
 * itself otherwise.
 *
 * @param {Object} activePages - Pre-launched platform contexts.
 * @returns {Object} Transparent page Proxy.
 */
function createProxyPage(activePages) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (!state.currentPlatform) {
          logger.warn(
            "SERVER",
            "[CAMPAIGN-QUEUES] Proxy page property accessed, but no active currentPlatform context is active.",
          );
          return undefined;
        }
        const realState = activePages[state.currentPlatform];
        if (!realState || !realState.page) {
          throw new Error(
            `[CAMPAIGN-QUEUES] No active browser page found for current platform context: ${state.currentPlatform}`,
          );
        }
        const val = realState.page[prop];
        if (typeof val === "function") {
          return val.bind(realState.page);
        }
        return val;
      },
    },
  );
}

module.exports = {
  launchRequiredBrowsers,
  closeAllActivePages,
  createProxyPage,
};
