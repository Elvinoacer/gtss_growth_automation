/**
 * Browser Base — Generic Browser Launcher
 * createBrowser — the primary entry point used by schedulerService and
 * other automation flows to launch a Chromium browser for a given
 * platform. Supports three modes: CDP (attach to the user's Chrome),
 * persistent (launch a persistent-context Chromium with a userDataDir),
 * and ephemeral (launch a fresh Chromium instance and save cookies on
 * close).
 *
 * Also handles tab-reuse (preferring an existing platform tab over
 * opening a new one), stray-tab cleanup, the proactive popup
 * interceptor, Instagram-specific context hardening, and the
 * visibility-via-bridge dance for login sessions.
 *
 * Extracted from the original browserBase.js for maintainability.
 */

const { chromium } = require("playwright");
const fs = require("fs");
const logger = require("../../utils/logger");
const { loadSession } = require("../sessionManager");
const { USER_AGENTS } = require("./constants");
const {
  isPortOpen,
  getPortFromEndpoint,
  ensureCdpVisibleViaBridge,
  launchCdpChrome,
} = require("./cdpBridge");
const {
  envKey,
  getPlatformEnv,
  getBrowserMode,
  getProfileDir,
  normalizeHeadless,
  shouldAllowStandaloneBrowserLaunch,
} = require("./env");
const { acquireBrowserLock, releaseBrowserLock, releaseLockOnClose } = require("./locks");
const { trackBrowserState } = require("./browserState");
const { startTracing } = require("./artifacts");
const { closeStrayTabs, installStrayTabInterceptor } = require("./strayTabs");
const { configureInstagramContext } = require("./instagramDetection");

/**
 * Launch a browser configured to mimic human browsing and load session if available.
 */
async function createBrowser(platform, options = {}) {
  const headless = normalizeHeadless(
    platform,
    options.headless || false,
    options,
  );
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  let mode = getBrowserMode(platform, options);
  let cdpEndpoint =
    options.cdpEndpoint || getPlatformEnv(platform, "CDP_ENDPOINT");
  let lock = null;

  // ─── Visibility guarantee ─────────────────────────────────
  // If we need the browser to be visible (headless === false) AND we are in CDP mode,
  // we MUST ask the bridge to ensure it's visible. Otherwise, Playwright's connectOverCDP
  // will just connect to the background Chrome and it won't be visible.
  if (headless === false && mode === "cdp") {
    const bridgeOk = await ensureCdpVisibleViaBridge();
    if (!bridgeOk && options.loginSession === true) {
      logger.warn(
        "BROWSER",
        `Login session for ${platform}: bridge not reachable — falling back to visible persistent browser so the login window is always shown.`,
      );
      // Force persistent mode for this call only. We do NOT mutate
      // options.mode (the caller's options object) — we use local
      // `mode` / `cdpEndpoint` variables instead, so the rest of
      // createBrowser routes through the persistent branch below.
      mode = "persistent";
      cdpEndpoint = null;
    } else {
      logger.info(
        "BROWSER",
        `Login session for ${platform}: bridge confirmed CDP Chrome is visible.`,
      );
    }
  }

  logger.info("BROWSER", `Launching browser for ${platform}`, {
    headless,
    mode,
    loginSession: options.loginSession === true,
  });

  if (mode === "cdp") {
    if (!cdpEndpoint) {
      throw new Error(
        `BROWSER_MODE=cdp requires ${envKey(platform, "CDP_ENDPOINT")} or CDP_ENDPOINT`,
      );
    }

    const port = getPortFromEndpoint(cdpEndpoint);
    const isOpen = await isPortOpen(port);
    if (!isOpen) {
      await launchCdpChrome(port);
    }


    try {
      lock = acquireBrowserLock(platform, mode, cdpEndpoint);
      const browser = await chromium.connectOverCDP(cdpEndpoint);
      const context =
        browser.contexts()[0] ||
        (await browser.newContext({ locale: "en-KE" }));

      // Apply platform-specific context configuration
      if (platform === "instagram") {
        await configureInstagramContext(context);
      }

      // ── Stray-tab cleanup ────────────────────────────────────────────────
      // The user's real Chrome may contain leftover tabs from previous runs,
      // browser popups, or LinkedIn's own auto-redirects (e.g. to
      // /talent/job-posting-redirect/ when a Premium upsell dialog is
      // dismissed). These stray tabs pollute the context and cause the
      // "two tabs active, one is /job-posting" symptom.
      //
      // We proactively close any tab whose URL matches patterns we never want
      // to operate on, EXCEPT the very first tab (index 0) which is usually
      // the user's manually-opened tab and should never be closed by us.
      await closeStrayTabs(context, platform);

      // ── Proactive popup interceptor ─────────────────────────────────────
      // closeStrayTabs above is polling-based — it only runs when called
      // explicitly. Popups that open BETWEEN cleanup runs (during cooldown
      // delays, or while a Premium upsell dialog auto-dismisses) survive
      // until the next iteration. This interceptor fires the MOMENT a new
      // tab/popup is created and closes it immediately if its URL matches a
      // stray pattern. Together with closeStrayTabs, this gives us both
      // proactive (event-driven) and reactive (polling) coverage.
      installStrayTabInterceptor(context, platform);

      // ── Tab reuse for LinkedIn (and now X, Facebook) ───────────────────
      //
      // [FIX 2b] Previous code unconditionally opened a NEW tab on every
      // CDP attach, which over a long session accumulated many platform
      // tabs (one per run) AND — more importantly — produced the visible
      // "tab opens then closes immediately" flicker when a posting
      // attempt failed and the retry loop opened a brand-new tab for the
      // next attempt. The retry-loop flicker is now fixed at the call
      // site (schedulerService.publishPost reuses the same browserState
      // across retries — see FIX 2a), but extending the tab-reuse
      // pattern from LinkedIn to X and Facebook here is the second half
      // of the fix: it ensures that even when createBrowser IS called
      // again (e.g. by a different caller, or by the retry path when the
      // previous page died), we adopt the existing platform tab instead
      // of stacking a new one.
      //
      // Instagram uses createInstagramBrowser (its own dedicated launcher)
      // which already does tab-reuse — so it isn't routed through this
      // branch. See createInstagramBrowser around line 1977 for the
      // equivalent logic.
      //
      // Tab-reuse candidates are filtered by the platform's primary
      // domain. We never grab a tab that's on a /job-posting,
      // /jobs/view, /jobs/, or /talent/job-posting-redirect path
      // (closeStrayTabs should have already removed them, but be
      // defensive — LinkedIn auto-redirects to these aggressively).
      const platformDomain =
        platform === "linkedin" ? "linkedin.com"
        : platform === "x" ? "x.com"
        : platform === "facebook" ? "facebook.com"
        : platform === "instagram" ? "instagram.com"
        : null;

      let page = null;
      if (platformDomain) {
        const existingPages = context.pages().filter((candidate) => {
          if (!candidate || candidate.isClosed()) return false;
          const url = String(candidate.url?.() || candidate.url || "").toLowerCase();
          if (!url || url === "about:blank") return false;
          // Only consider tabs on this platform's primary domain —
          // never grab a /job-posting tab (closeStrayTabs should have
          // already removed them, but be defensive).
          if (!url.includes(platformDomain)) return false;
          if (
            url.includes("/job-posting") ||
            url.includes("/talent/job-posting-redirect") ||
            url.includes("/jobs/view") ||
            url.includes("/jobs/")
          ) {
            return false;
          }
          return true;
        });
        page = existingPages[0] || null;
        if (page) {
          logger.info("BROWSER", `Reusing existing ${platform} tab: ${page.url()}`);
          await page.bringToFront().catch(() => {});
        }
      }

      if (!page) {
        page = await context.newPage();
        logger.info("BROWSER", `Opened new CDP tab for ${platform} automation`);
      }

      page.once("close", () => releaseBrowserLock(lock));

      const tracePath = await startTracing(context, platform, options);
      releaseLockOnClose(browser, context, lock);
      return trackBrowserState({
        platform,
        browser,
        context,
        page,
        mode,
        tracePath,
        shouldCloseBrowser: false,
        shouldClosePageOnly: true, // close the tab but keep Chrome open
        lock,
      });
    } catch (error) {
      releaseBrowserLock(lock);
      throw error;
    }
  }

  if (mode === "persistent") {
    if (!shouldAllowStandaloneBrowserLaunch()) {
      throw new Error(
        `Standalone persistent browser launch is disabled for ${platform}. Use the shared CDP Chrome session instead.`,
      );
    }

    const userDataDir = getProfileDir(platform, options);
    fs.mkdirSync(userDataDir, { recursive: true });

    try {
      lock = acquireBrowserLock(platform, mode, userDataDir);
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless,
        channel:
          options.channel ||
          getPlatformEnv(platform, "BROWSER_CHANNEL", "chrome"),
        viewport: null,
        locale: "en-KE",
      });

      // Apply platform-specific context configuration
      if (platform === "instagram") {
        await configureInstagramContext(context);
      }

      const page =
        context.pages().find((candidate) => !candidate.isClosed()) ||
        (await context.newPage());
      const tracePath = await startTracing(context, platform, options);
      const browser = context.browser();
      releaseLockOnClose(browser, context, lock);
      return trackBrowserState({
        platform,
        browser,
        context,
        page,
        mode,
        tracePath,
        shouldCloseBrowser: true,
        lock,
      });
    } catch (error) {
      releaseBrowserLock(lock);
      throw error;
    }
  }

  if (!shouldAllowStandaloneBrowserLaunch()) {
    throw new Error(
      `Standalone Chromium launch is disabled for ${platform}. Use the shared CDP Chrome session instead.`,
    );
  }

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1280, height: 800 },
    locale: "en-KE",
  });

  // Apply platform-specific context configuration
  if (platform === "instagram") {
    await configureInstagramContext(context);
  }

  const cookies = loadSession(platform);
  if (cookies && cookies.length > 0) {
    await context.addCookies(cookies);
    logger.info(
      "BROWSER",
      `Loaded ${cookies.length} session cookies for ${platform}`,
    );
  } else {
    logger.info("BROWSER", `No existing cookie session found for ${platform}`);
  }

  const page = await context.newPage();
  const tracePath = await startTracing(context, platform, options);

  return trackBrowserState({
    platform,
    browser,
    context,
    page,
    mode: "ephemeral",
    tracePath,
    shouldCloseBrowser: true,
    lock: null,
  });
}

module.exports = {
  createBrowser,
};
