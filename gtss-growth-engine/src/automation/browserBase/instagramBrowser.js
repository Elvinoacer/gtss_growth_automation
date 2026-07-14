/**
 * Browser Base — Instagram Browser Launcher & Warmup
 * _lastWarmupDate, simulateOrganicBrowse, dailySessionWarmup,
 * createInstagramBrowser — the Instagram-specific launcher that prefers
 * an existing instagram.com tab over opening a new one, applies the
 * Instagram context-hardening init script, runs a daily organic-browse
 * warmup so the session looks human, and falls back to a standalone
 * Chromium when no CDP Chrome is reachable.
 * Extracted from the original browserBase.js for maintainability.
 */

const { chromium } = require("playwright");
const { getDb } = require("../../db/database");
const logger = require("../../utils/logger");
const { loadSession } = require("../sessionManager");
const { USER_AGENTS } = require("./constants");
const {
  isPortOpen,
  getPortFromEndpoint,
  launchCdpChrome,
} = require("./cdpBridge");
const { shouldAllowStandaloneBrowserLaunch } = require("./env");
const { acquireBrowserLock, releaseBrowserLock } = require("./locks");
const { trackBrowserState } = require("./browserState");
const { startTracing } = require("./artifacts");
const { humanDelay, humanScroll, humanMouseMove } = require("./humanInteraction");
const { firstVisible } = require("./locators");
const {
  configureInstagramContext,
  resolveInstagramCdpEndpoint,
  checkInstagramSessionState,
} = require("./instagramDetection");

// Tracks the last date warmup was completed (format: "YYYY-MM-DD")
let _lastWarmupDate = null;

/**
 * Simulates organic browsing behaviors (page visits and scrolls) on Instagram.
 */
async function simulateOrganicBrowse(page, username = null) {
  if (username) {
    logger.info("BROWSER", `Simulating organic browse on @${username}...`);
    const profileUrl = `https://www.instagram.com/${username}/`;
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 6000);

    const postLocator = page.locator('article a[href*="/p/"]');
    const totalPosts = await postLocator.count().catch(() => 0);
    if (totalPosts === 0) {
      logger.info("BROWSER", "No posts found for organic browse.");
      return;
    }

    const targetCount = Math.min(Math.floor(Math.random() * 3) + 1, totalPosts);
    logger.info("BROWSER", `Will organically visit ${targetCount} posts.`);

    const indices = [];
    while (indices.length < targetCount) {
      const idx = Math.floor(Math.random() * totalPosts);
      if (!indices.includes(idx)) {
        indices.push(idx);
      }
    }

    for (let i = 0; i < indices.length; i++) {
      const postIdx = indices[i];
      const postElement = postLocator.nth(postIdx);
      const postUrl = await postElement.getAttribute("href").catch(() => "");
      const fullUrl = postUrl ? `https://www.instagram.com${postUrl}` : "";

      logger.info(
        "BROWSER",
        `Clicking post ${i + 1}/${targetCount} at index ${postIdx}`,
      );
      try {
        await humanMouseMove(page, postElement);
        await humanDelay(300, 600);
        await postElement.click();
        await humanDelay(2000, 4000);

        await humanScroll(page);
        await humanDelay(2000, 4000);

        const closeBtnSelectors = [
          'svg[aria-label="Close"]',
          'div[role="button"] svg[aria-label="Close"]',
          'button svg[aria-label="Close"]',
        ];
        const closeBtn = await firstVisible(
          page,
          closeBtnSelectors,
          2000,
        ).catch(() => null);
        if (closeBtn) {
          await humanMouseMove(page, closeBtn);
          await humanDelay(300, 600);
          await closeBtn.click();
        } else {
          logger.info(
            "BROWSER",
            "Close button not found, performing back navigation.",
          );
          await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
        }
        await humanDelay(2000, 4000);

        if (fullUrl) {
          logger.info(
            "BROWSER",
            `[viewed_post] Organically viewed post: ${fullUrl}`,
          );
        }
      } catch (err) {
        logger.warn(
          "BROWSER",
          `Failed during organic post browse for index ${postIdx}: ${err.message}`,
        );
      }
    }
  } else {
    logger.info(
      "BROWSER",
      "Simulating organic browse on Instagram home feed...",
    );
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
    });
    await humanDelay(3000, 6000);

    const scrollCount = Math.floor(Math.random() * 2) + 2;
    for (let i = 0; i < scrollCount; i++) {
      await humanScroll(page);
      logger.info(
        "BROWSER",
        `Completed organic scroll ${i + 1}/${scrollCount}`,
      );
      await humanDelay(5000, 15000);
    }
  }
}

/**
 * Performs daily account/session warmup before triggering automated scripts.
 */
async function dailySessionWarmup(page, fastTrack = false) {
  const todayStr = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  if (_lastWarmupDate === todayStr) {
    logger.info(
      "BROWSER",
      "dailySessionWarmup already completed today — skipping.",
    );
    return { completed: false, skipped: true };
  }

  const startTime = Date.now();
  logger.info(
    "BROWSER",
    `Starting daily Instagram session warmup (fastTrack: ${fastTrack})...`,
  );

  await simulateOrganicBrowse(page);

  const elapsed = Date.now() - startTime;
  const targetTotalMs = fastTrack
    ? Math.floor(Math.random() * 5000) + 5000
    : Math.floor(Math.random() * 20000) + 35000;

  const remainingWait = targetTotalMs - elapsed;
  if (remainingWait > 0) {
    logger.info(
      "BROWSER",
      `Warmup elapsed: ${elapsed}ms. Waiting remaining ${remainingWait}ms to complete...`,
    );
    await humanDelay(remainingWait, remainingWait);
  } else {
    logger.info("BROWSER", `Warmup organic browse completed in ${elapsed}ms`);
  }

  _lastWarmupDate = todayStr; // Mark warmup as done for today
  const durationMs = Date.now() - startTime;
  return { completed: true, durationMs };
}

/**
 * Browser configuration designed specifically for Instagram.
 */
async function createInstagramBrowser(options = {}) {
  logger.info(
    "BROWSER",
    "Launching Instagram browser (prefers an existing Chrome tab when available)...",
  );

  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const cookies = loadSession("instagram");
  const requestedMode = String(options.mode || "").toLowerCase();
  const cdpEndpoint = resolveInstagramCdpEndpoint(options);

  if (requestedMode !== "persistent" && cdpEndpoint) {
    let lock = null;

    const port = getPortFromEndpoint(cdpEndpoint);
    const isOpen = await isPortOpen(port);
    if (!isOpen) {
      await launchCdpChrome(port);
    }

    try {
      lock = acquireBrowserLock("instagram", "cdp", cdpEndpoint);
      logger.info(
        "BROWSER",
        "Attaching Instagram automation to Chrome via CDP",
        {
          endpoint: cdpEndpoint,
        },
      );

      const browser = await chromium.connectOverCDP(cdpEndpoint);
      const context =
        browser.contexts()[0] ||
        (await browser.newContext({
          userAgent,
          viewport: { width: 1280, height: 800 },
          locale: "en-US",
          timezoneId: "Africa/Nairobi",
          geolocation: { latitude: -1.2921, longitude: 36.8219 },
          permissions: ["geolocation"],
        }));

      await configureInstagramContext(context);

      if (cookies && cookies.length > 0) {
        await context.addCookies(cookies);
        logger.info(
          "BROWSER",
          `Loaded ${cookies.length} session cookies for Instagram`,
        );
      } else {
        logger.info(
          "BROWSER",
          "No existing cookie session found for Instagram",
        );
      }

      const existingPages = context.pages().filter((candidate) => {
        if (!candidate || candidate.isClosed()) return false;
        const url = String(
          candidate.url?.() || candidate.url || "",
        ).toLowerCase();
        return url && url !== "about:blank";
      });
      let page = existingPages.find((candidate) =>
        String(candidate.url?.() || candidate.url || "")
          .toLowerCase()
          .includes("instagram.com"),
      );
      if (!page) {
        // Always open a dedicated new tab for Instagram automation
        // so we never hijack existing app or unrelated tabs
        page = await context.newPage();
      }
      await page.bringToFront().catch(() => {});
      const tracePath = await startTracing(context, "instagram", options);

      try {
        logger.info(
          "BROWSER",
          "Navigating to Instagram home to check session...",
        );
        if (!String(page.url()).includes("instagram.com")) {
          await page
            .goto("https://www.instagram.com/", {
              waitUntil: "domcontentloaded",
            })
            .catch(() => {});
          await humanDelay(2000, 4000);
        }

        const sessionState = await checkInstagramSessionState(page);
        logger.info(
          "BROWSER",
          `Instagram session state detected: ${sessionState}`,
        );

        if (sessionState === "authenticated" && !options.skipDailyWarmup) {
          const db = getDb();
          const settingRow = db
            .prepare(
              "SELECT value FROM settings WHERE key = 'ig_warmup_fast_track'",
            )
            .get();
          const fastTrack = settingRow && String(settingRow.value) === "1";

          await dailySessionWarmup(page, fastTrack);
        } else if (sessionState === "authenticated") {
          logger.info(
            "BROWSER",
            "Instagram daily warmup skipped for this browser session",
          );
        }
      } catch (err) {
        logger.error(
          "BROWSER",
          `Failed during Instagram session recovery/warmup check: ${err.message}`,
        );
      }

      return trackBrowserState({
        platform: "instagram",
        browser,
        context,
        page,
        mode: "cdp",
        tracePath,
        shouldCloseBrowser: false,
        shouldClosePageOnly: true,
        lock,
      });
    } catch (error) {
      releaseBrowserLock(lock);
      logger.warn(
        "BROWSER",
        "Failed to attach Instagram automation to a running Chrome tab; falling back to standalone Chromium",
        {
          endpoint: cdpEndpoint,
          error: error.message,
        },
      );
    }
  }

  logger.info("BROWSER", "Launching standalone Instagram Chromium instance...");

  if (!shouldAllowStandaloneBrowserLaunch()) {
    throw new Error(
      "Standalone Chromium launch is disabled for this run. Use the shared CDP Chrome session instead.",
    );
  }

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "Africa/Nairobi",
    geolocation: { latitude: -1.2921, longitude: 36.8219 },
    permissions: ["geolocation"],
  });

  await configureInstagramContext(context);

  if (cookies && cookies.length > 0) {
    await context.addCookies(cookies);
    logger.info(
      "BROWSER",
      `Loaded ${cookies.length} session cookies for Instagram`,
    );
  } else {
    logger.info("BROWSER", "No existing cookie session found for Instagram");
  }

  const page = await context.newPage();
  const tracePath = await startTracing(context, "instagram", options);

  try {
    logger.info("BROWSER", "Navigating to Instagram home to check session...");
    await page
      .goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" })
      .catch(() => {});
    await humanDelay(2000, 4000);

    const sessionState = await checkInstagramSessionState(page);
    logger.info("BROWSER", `Instagram session state detected: ${sessionState}`);

    if (sessionState === "authenticated" && !options.skipDailyWarmup) {
      const db = getDb();
      const settingRow = db
        .prepare(
          "SELECT value FROM settings WHERE key = 'ig_warmup_fast_track'",
        )
        .get();
      const fastTrack = settingRow && String(settingRow.value) === "1";

      await dailySessionWarmup(page, fastTrack);
    } else if (sessionState === "authenticated") {
      logger.info(
        "BROWSER",
        "Instagram daily warmup skipped for this browser session",
      );
    }
  } catch (err) {
    logger.error(
      "BROWSER",
      `Failed during Instagram session recovery/warmup check: ${err.message}`,
    );
  }

  return trackBrowserState({
    platform: "instagram",
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
  simulateOrganicBrowse,
  dailySessionWarmup,
  createInstagramBrowser,
};
