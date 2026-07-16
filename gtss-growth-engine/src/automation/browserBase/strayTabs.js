/**
 * Browser Base — Stray Tab Cleanup & Interceptor
 * closeStrayTabs, isStrayTabUrl, installStrayTabInterceptor — utilities
 * that prevent leftover LinkedIn popups / job-posting redirects from
 * polluting the shared CDP context between automation runs. Includes
 * both a polling cleanup pass (closeStrayTabs) and a proactive
 * context.on('page') interceptor (installStrayTabInterceptor) for
 * immediate popup closure.
 * Extracted from the original browserBase.js for maintainability.
 */

const logger = require("../../utils/logger");

/**
 * Close stray browser tabs that match unwanted URL patterns.
 *
 * LinkedIn's own JS can auto-redirect tabs to /talent/job-posting-redirect/
 * when a Premium upsell dialog is dismissed (or when the dialog stays open
 * after we return premium_required). These stray tabs:
 *   - Pollute the shared CDP context for future runs
 *   - Cause the "two tabs active, one is /job-posting" symptom
 *   - Can intercept focus events from the automation tab
 *
 * This function enumerates all pages in the context and closes any whose URL
 * matches unwanted patterns. It NEVER closes the first tab (index 0), which
 * is typically the user's manually-opened tab.
 *
 * URL patterns we close:
 *   - /job-posting
 *   - /talent/job-posting-redirect
 *   - /jobs/view/
 *   - /jobs/ (job search page, often spawns popups)
 *
 * @param {object} context - Playwright browser context
 * @param {string} _platform - Platform name (unused, reserved for future per-platform rules)
 * @param {object|null} keepPage - Active automation page to preserve even if
 *   it is currently on a messaging compose route.
 * @returns {Promise<number>} Number of tabs closed
 */
async function closeStrayTabs(context, _platform, keepPage = null) {
  let closedCount = 0;
  let pages;
  try {
    pages = context.pages();
  } catch (_) {
    return 0;
  }

  // URL patterns that indicate a stray tab we should close.
  const strayPatterns = [
    "/job-posting",
    "/talent/job-posting-redirect",
    "/jobs/view/",
    "/jobs/",
  ];

  // Never close the first tab — it's typically the user's manually-opened tab.
  for (let i = 1; i < pages.length; i++) {
    const page = pages[i];
    if (!page || page.isClosed()) continue;
    // Direct Message-link navigation intentionally moves the active tab to
    // /messaging/compose. It is not a stale popup and must remain open.
    if (page === keepPage) continue;
    let url = "";
    try {
      url = String(page.url() || "");
    } catch (_) {
      continue;
    }
    if (!url || url === "about:blank") continue;

    const isStray = strayPatterns.some((p) => url.includes(p));
    if (!isStray) continue;

    try {
      logger.info(
        "BROWSER",
        `Closing stray tab: ${url.slice(0, 120)}`,
      );
      await page.close().catch(() => {});
      closedCount++;
    } catch (_) {
      // Best-effort cleanup — ignore errors.
    }
  }

  return closedCount;
}

/**
 * Returns true if a URL matches any of the stray-tab patterns.
 * Exposed so the proactive context.on('page') interceptor can share the
 * same definition as closeStrayTabs without duplicating the list.
 *
 * @param {string} url - The page URL to test
 * @returns {boolean} true if the URL matches a stray pattern
 */
function isStrayTabUrl(url) {
  const u = String(url || "");
  if (!u || u === "about:blank") return false;
  const strayPatterns = [
    "/job-posting",
    "/talent/job-posting-redirect",
    "/jobs/view/",
    "/jobs/",
  ];
  return strayPatterns.some((p) => u.includes(p));
}

/**
 * Install a proactive popup interceptor on a browser context.
 *
 * The existing `closeStrayTabs` function is polling-based — it only runs when
 * explicitly called (after each DM/connection action). Popups that open
 * BETWEEN cleanup runs (e.g. during the cooldown delay, or while a Premium
 * upsell dialog auto-dismisses) survive until the next iteration, by which
 * time they may have stolen focus or triggered further redirects.
 *
 * This function registers a `context.on('page', ...)` handler that fires the
 * MOMENT a new tab/popup is created. If the new page's URL matches a stray
 * pattern, it is closed immediately. The handler also waits briefly for the
 * page's URL to settle (popups often start at about:blank before navigating
 * to their final URL) before deciding whether to close.
 *
 * The handler is idempotent: calling installStrayTabInterceptor twice on the
 * same context replaces the previous handler (we tag the listener on the
 * context object so we can remove it before re-adding).
 *
 * @param {object} context - Playwright browser context
 * @param {string} platform - Platform name (for logging)
 */
function installStrayTabInterceptor(context, platform) {
  if (!context || typeof context.on !== "function") return;

  // Remove any previously-installed handler so we don't double-register.
  if (context.__gtssStrayTabHandler) {
    try {
      context.off("page", context.__gtssStrayTabHandler);
    } catch (_) {}
    context.__gtssStrayTabHandler = null;
  }

  const handler = async (page) => {
    // Wait briefly for the popup's URL to settle. Popups often start at
    // about:blank and navigate to their final URL within ~500ms.
    let url = "";
    try {
      url = String(page.url() || "");
      if (!url || url === "about:blank") {
        // Wait for first navigation to complete (or 1500ms, whichever first).
        await page
          .waitForLoadState("domcontentloaded", { timeout: 1500 })
          .catch(() => {});
        url = String(page.url() || "");
      }
    } catch (_) {
      url = "";
    }

    if (!isStrayTabUrl(url)) {
      return;
    }

    // Don't close if this is the only page in the context (defensive —
    // should never happen because the interceptor only fires for NEW pages).
    let allPages = [];
    try {
      allPages = context.pages();
    } catch (_) {
      allPages = [];
    }
    if (allPages.length <= 1) return;

    try {
      logger.info(
        "BROWSER",
        `[${platform}] Proactive interceptor closing stray popup: ${url.slice(0, 120)}`,
      );
      await page.close().catch(() => {});
    } catch (_) {
      // Best-effort.
    }
  };

  context.on("page", handler);
  context.__gtssStrayTabHandler = handler;
}

module.exports = {
  closeStrayTabs,
  isStrayTabUrl,
  installStrayTabInterceptor,
};
