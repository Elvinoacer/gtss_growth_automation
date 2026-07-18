/**
 * Browser Base — Browser/Context Close Logic
 * closeBrowser, closeBrowserContext, closeAllBrowsers — the inverse of
 * createBrowser. Handles Playwright trace saving, cookie persistence for
 * ephemeral sessions, selector-health reporting for Instagram, and the
 * per-attempt log-line differentiation (success vs failed attempt n/3)
 * used by schedulerService.publishPost's retry loop.
 * Extracted from the original browserBase.js for maintainability.
 */

const { saveSession, markSessionActive } = require("../sessionManager");
const logger = require("../../utils/logger");
const {
  ACTIVE_BROWSER_STATES,
  INVALIDATED_PLATFORMS,
  markAutomationSessionInvalid,
} = require("./browserState");
const { releaseBrowserLock } = require("./locks");
const { hasPlatformAuthCookie } = require("./sessionClassification");
const { getSelectorHealthReport } = require("./locators");

/**
 * Close the browser and save updated session cookies.
 */
async function closeBrowser(browser, platform, context, options = {}) {
  if (!browser && !context) return;

  try {
    if (context && options.tracePath) {
      try {
        await context.tracing.stop({ path: options.tracePath });
        logger.info("BROWSER", "Saved Playwright trace", {
          platform,
          path: options.tracePath,
        });
      } catch (error) {
        logger.warn("BROWSER", "Failed to save Playwright trace", {
          platform,
          error: error.message,
        });
      }
    }

    if (context && options.mode === "ephemeral") {
      if (typeof context.cookies === "function") {
        const cookies = await context.cookies();
        saveSession(platform, cookies);
        logger.info(
          "BROWSER",
          `Saved updated session cookies for ${platform} on close`,
        );
      } else {
        logger.warn(
          "BROWSER",
          `Skipping cookie save for ${platform}: context.cookies is not a function`,
        );
      }
    } else if (context) {
      const mode = options.mode || "persistent";
      const hasAuthCookie =
        typeof context.cookies === "function"
          ? await hasPlatformAuthCookie(context, platform)
          : false;
      if (INVALIDATED_PLATFORMS.has(platform)) {
        logger.warn(
          "BROWSER",
          "Session was invalidated during this run; not marking active on close",
          {
            platform,
            mode,
          },
        );
      } else if (platform === "linkedin" && !hasAuthCookie) {
        markAutomationSessionInvalid(platform);
        logger.warn(
          "BROWSER",
          "LinkedIn auth cookies missing on close; session remains invalid",
          {
            platform,
            mode,
          },
        );
      } else {
        markSessionActive(platform, { mode, hasAuthCookie });
      }
    }
  } catch (error) {
    logger.warn("BROWSER", `Failed to persist session state for ${platform}`, {
      error: error.message,
    });
  }

  try {
    if (options.shouldClosePageOnly) {
      const pageToClose =
        options.page && !options.page.isClosed()
          ? options.page
          : context && typeof context.pages === "function"
            ? context
                .pages()
                .filter((candidate) => candidate && !candidate.isClosed())
                .pop()
            : null;

      if (pageToClose && !pageToClose.isClosed()) {
        // [FIX 2c] Short visible delay before closing on success so the
        // user can glance over at the tab and visually confirm "yes,
        // that actually posted" — instead of the tab being yanked away
        // the instant the "✓ Posted to X" confirmation event fires.
        //
        // We only delay on SUCCESS; on failure we close immediately so
        // the next attempt (or the next platform in the queue) doesn't
        // wait on a dead tab. The delay is short (2.5s) — long enough
        // to register visually, short enough not to slow down multi-
        // platform posts noticeably.
        //
        // Skip the delay entirely if DEBUG_NO_CLOSE_DELAY is set (useful
        // for tests / headless runs where the wait would just slow
        // things down).
        const success = options.success === true;
        if (success && !process.env.DEBUG_NO_CLOSE_DELAY) {
          await new Promise((r) => setTimeout(r, 2500)).catch(() => {});
        }

        // CDP mode: close only the automation tab, keep Chrome running
        await pageToClose.close();

        // [FIX 2d] Differentiate close reasons in the log line. Previously
        // this always logged "Closed automation tab for {platform}
        // (Chrome stays open)" regardless of outcome — making it hard to
        // diagnose the next time the user reported "tab opens then
        // closes immediately." Now we log:
        //   "...after successful post"            — success
        //   "...after failed attempt (n/3)"       — failure with attempt #
        //   "...after failed attempt"             — failure with no attempt #
        //   "...(reason: page-closed-mid-attempt)" — page already dead
        // The attempt number and reason are passed through from
        // closeBrowserContext, which gets them from publishPost.
        const reason = options.reason ? ` (reason: ${options.reason})` : "";
        const attemptPart =
          typeof options.attempt === "number"
            ? ` attempt (${options.attempt}/3)`
            : " attempt";
        const outcomePart = success
          ? "after successful post"
          : `after failed${attemptPart}`;
        logger.info(
          "BROWSER",
          `Closed automation tab for ${platform} — ${outcomePart}${reason} (Chrome stays open)`,
        );
      } else {
        logger.warn("BROWSER", "No automation tab found to close", {
          platform,
        });
      }
    } else if (options.shouldCloseBrowser !== false) {
      // Defensive: callers sometimes pass a BrowserContext as `browser`, a
      // mock object, or a CDP wrapper that only exposes context.close().
      // Never assume .close exists — check before calling.
      if (context && options.mode === "persistent") {
        if (typeof context.close === "function") {
          await context.close();
        }
      } else if (browser && typeof browser.close === "function") {
        await browser.close();
      } else if (context && typeof context.close === "function") {
        await context.close();
      }
      // [FIX 2d] Same differentiation for the full-browser-close path.
      const success = options.success === true;
      const reason = options.reason ? ` (reason: ${options.reason})` : "";
      const attemptPart =
        typeof options.attempt === "number"
          ? ` attempt (${options.attempt}/3)`
          : " attempt";
      const outcomePart = success
        ? "after successful post"
        : `after failed${attemptPart}`;
      logger.info("BROWSER", `Closed browser for ${platform} — ${outcomePart}${reason}`);
      if (platform === "instagram") {
        const report = getSelectorHealthReport();
        for (const warnMsg of report.warnings) {
          logger.warn("INSTAGRAM_SELECTOR_HEALTH", warnMsg);
        }
      }
    }
  } finally {
    INVALIDATED_PLATFORMS.delete(platform);
    releaseBrowserLock(options.lock);
    for (const state of ACTIVE_BROWSER_STATES) {
      if (state.browser === browser && state.context === context) {
        state.closed = true;
        ACTIVE_BROWSER_STATES.delete(state);
      }
    }
  }
}

// ─── closeBrowserContext (FIX 2c/2d) ────────────────────────────────────────
//
// `options.success` and `options.attempt` are now threaded through to
// closeBrowser so the log line can distinguish "after successful post"
// from "after failed attempt (n/3)". Both are optional — existing
// callers that don't pass them get the old log behavior (the outcome
// part just says "after failed attempt" with no number).
//
// `options.reason` is an optional short string explaining WHY the close
// is happening (e.g. "page-closed-mid-attempt"). It's appended to the
// log line in parens so the next time the user reports a flicker, the
// logs make it obvious which path triggered the close.
async function closeBrowserContext(platform, browserState, options = {}) {
  if (!browserState) return;

  await closeBrowser(browserState.browser, platform, browserState.context, {
    mode: browserState.mode,
    tracePath: browserState.tracePath,
    shouldCloseBrowser: browserState.shouldCloseBrowser,
    shouldClosePageOnly: browserState.shouldClosePageOnly,
    page: browserState.page,
    lock: browserState.lock,
    success: options.success,
    attempt: options.attempt,
    reason: options.reason,
  });
}

async function closeAllBrowsers() {
  const states = Array.from(ACTIVE_BROWSER_STATES);
  await Promise.allSettled(
    states.map((state) =>
      closeBrowser(state.browser, state.platform, state.context, {
        mode: state.mode,
        tracePath: state.tracePath,
        shouldCloseBrowser: state.shouldCloseBrowser,
        lock: state.lock,
      }),
    ),
  );
}

module.exports = {
  closeBrowser,
  closeBrowserContext,
  closeAllBrowsers,
};
