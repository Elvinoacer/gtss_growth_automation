const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const {
  loadSession,
  saveSession,
  markSessionActive,
} = require("./sessionManager");
const logger = require("../utils/logger");
const { markSessionInvalid } = require("./sessionManager");
const { sendNotification } = require("../services/notificationService");

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];
const ACTIVE_BROWSER_STATES = new Set();

/**
 * Wait for a random duration between min and max milliseconds to simulate human behavior.
 */
function humanDelay(min = 3000, max = 15000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envKey(platform, suffix) {
  return `${platform}_${suffix}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

function getPlatformEnv(platform, suffix, fallback) {
  return (
    process.env[envKey(platform, suffix)] || process.env[suffix] || fallback
  );
}

function getBrowserMode(platform, options = {}) {
  if (options.cdpEndpoint) return "cdp";
  if (options.userDataDir) return "persistent";
  const configured = getPlatformEnv(platform, "BROWSER_MODE");
  if (configured) return configured.toLowerCase();
  if (getPlatformEnv(platform, "CDP_ENDPOINT")) return "cdp";
  return "persistent";
}

function getProfileDir(platform, options = {}) {
  const configured =
    options.userDataDir || getPlatformEnv(platform, "USER_DATA_DIR");
  return path.resolve(
    configured || path.join(process.cwd(), "profiles", platform),
  );
}

function getArtifactsDir() {
  const dir = path.resolve(
    process.env.AUTOMATION_ARTIFACTS_DIR || "./artifacts/automation",
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getLocksDir() {
  const dir = path.resolve(
    process.env.AUTOMATION_LOCKS_DIR || "./data/browser-locks",
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(value) {
  return String(value || "artifact")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function artifactPath(platform, label, extension) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    getArtifactsDir(),
    `${timestamp}-${safeName(platform)}-${safeName(label)}.${extension}`,
  );
}

function lockPath(platform, mode, target) {
  return path.join(
    getLocksDir(),
    `${safeName(platform)}-${safeName(mode)}-${safeName(target)}.lock`,
  );
}

function isPidRunning(pid) {
  if (!pid || Number.isNaN(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readLock(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return null;
  }
}

function acquireBrowserLock(platform, mode, target) {
  const filePath = lockPath(platform, mode, target);
  const payload = {
    pid: process.pid,
    platform,
    mode,
    target,
    createdAt: new Date().toISOString(),
  };

  try {
    const fd = fs.openSync(filePath, "wx");
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
    fs.closeSync(fd);
    return { filePath };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;

    const existing = readLock(filePath);
    if (existing && !isPidRunning(existing.pid)) {
      logger.warn("BROWSER", "Removing stale browser lock", {
        platform,
        mode,
        filePath,
        pid: existing.pid,
      });
      fs.unlinkSync(filePath);
      return acquireBrowserLock(platform, mode, target);
    }

    throw new Error(
      `Browser profile is already in use for ${platform} (${mode}). ` +
        `Stop the active run or remove stale lock ${filePath}.`,
    );
  }
}

function releaseBrowserLock(lock) {
  if (!lock || !lock.filePath) return;
  try {
    const existing = readLock(lock.filePath);
    if (!existing || existing.pid === process.pid) {
      fs.unlinkSync(lock.filePath);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn("BROWSER", "Failed to release browser lock", {
        filePath: lock.filePath,
        error: error.message,
      });
    }
  }
}

function releaseLockOnClose(browser, context, lock) {
  if (!lock) return;
  if (context && typeof context.once === "function") {
    context.once("close", () => releaseBrowserLock(lock));
  }
  if (browser && typeof browser.once === "function") {
    browser.once("disconnected", () => releaseBrowserLock(lock));
  }
}

function trackBrowserState(state) {
  ACTIVE_BROWSER_STATES.add(state);
  const untrack = () => {
    state.closed = true;
    ACTIVE_BROWSER_STATES.delete(state);
  };

  if (state.context && typeof state.context.once === "function") {
    state.context.once("close", untrack);
  }
  if (state.browser && typeof state.browser.once === "function") {
    state.browser.once("disconnected", untrack);
  }

  return state;
}

function normalizeHeadless(platform, requestedHeadless, options = {}) {
  const { isKnownPlatform } = require("../services/platformCatalog");
  const allowHeadless =
    options.allowHeadlessSocial === true ||
    process.env.ALLOW_HEADLESS_SOCIAL === "true";
  if (requestedHeadless && isKnownPlatform(platform) && !allowHeadless) {
    logger.warn("BROWSER", "Headless mode disabled for social automation", {
      platform,
    });
    return false;
  }
  return requestedHeadless;
}

/**
 * Scroll the page randomly 1-3 times with human-like delays.
 */
async function humanScroll(page) {
  const scrolls = Math.floor(Math.random() * 3) + 1; // 1 to 3 scrolls
  for (let i = 0; i < scrolls; i++) {
    // Scroll a random amount between 200 and 800 pixels
    const scrollAmount = Math.floor(Math.random() * 600) + 200;
    await page.mouse.wheel(0, scrollAmount);
    await humanDelay(1000, 3000);
  }
}

/**
 * Check if the page contains signs of a CAPTCHA or security challenge.
 */
async function detectCaptcha(page) {
  try {
    const content = await page.innerText('body').catch(() => '');
    const contentLower = content.toLowerCase();

    const triggers = [
      "captcha",
      "verify you're human",
      "verify you are human",
      "unusual activity",
      "security check",
      "prove you are human",
    ];

    return triggers.some((trigger) => contentLower.includes(trigger));
  } catch (error) {
    logger.warn("Error detecting CAPTCHA", { error: error.message });
    return false; // Fail safe
  }
}

async function checkSessionExpired(page, platform, emit) {
  const url = page.url().toLowerCase();
  const loginSignals = [
    "/login",
    "/checkpoint",
    "/accounts/login",
    "/i/flow/login",
    "/challenge",
  ];
  let expired = loginSignals.some((signal) => url.includes(signal));

  // If we are on the LinkedIn homepage (not /feed or /in), we are logged out.
  if (platform === 'linkedin' && url.match(/^https:\/\/[a-z0-9-]*\.?linkedin\.com\/?$/i)) {
    expired = true;
  }

  const challenged = await detectCaptcha(page);

  if (!expired && !challenged) {
    return false;
  }

  markSessionInvalid(platform);
  if (emit) {
    emit(
      "session_expired",
      `Session needs attention for ${platform}. Please re-authenticate or resolve the challenge.`,
      { platform },
    );
  }
  await sendNotification(
    `GTSS ${platform} session needs attention`,
    `The ${platform} session expired or hit a challenge during automation.`,
  );
  return true;
}

async function startTracing(context, platform, options = {}) {
  if (options.trace === false || process.env.PLAYWRIGHT_TRACE === "false")
    return null;
  try {
    await context.tracing.start({ screenshots: true, snapshots: true });
    return artifactPath(platform, "trace", "zip");
  } catch (error) {
    logger.warn("BROWSER", "Failed to start Playwright tracing", {
      platform,
      error: error.message,
    });
    return null;
  }
}

async function captureFailureArtifact(page, platform, label) {
  if (!page || page.isClosed()) return null;
  const filePath = artifactPath(platform, label, "png");
  try {
    await page.screenshot({ path: filePath, fullPage: true });
    logger.info("BROWSER", "Captured failure screenshot", {
      platform,
      filePath,
    });
    return filePath;
  } catch (error) {
    logger.warn("BROWSER", "Failed to capture failure screenshot", {
      platform,
      error: error.message,
    });
    return null;
  }
}

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
  const mode = getBrowserMode(platform, options);
  const cdpEndpoint =
    options.cdpEndpoint || getPlatformEnv(platform, "CDP_ENDPOINT");
  let lock = null;

  logger.info("BROWSER", `Launching browser for ${platform}`, {
    headless,
    mode,
  });

  if (mode === "cdp") {
    if (!cdpEndpoint) {
      throw new Error(
        `BROWSER_MODE=cdp requires ${envKey(platform, "CDP_ENDPOINT")} or CDP_ENDPOINT`,
      );
    }

    try {
      lock = acquireBrowserLock(platform, mode, cdpEndpoint);
      const browser = await chromium.connectOverCDP(cdpEndpoint);
      const context =
        browser.contexts()[0] ||
        (await browser.newContext({ locale: "en-KE" }));
      const page =
        context.pages().find((candidate) => !candidate.isClosed()) ||
        (await context.newPage());
      const tracePath = await startTracing(context, platform, options);
      markSessionActive(platform, { mode, cdpEndpoint });
      releaseLockOnClose(browser, context, lock);
      return trackBrowserState({
        platform,
        browser,
        context,
        page,
        mode,
        tracePath,
        shouldCloseBrowser: false,
        lock,
      });
    } catch (error) {
      releaseBrowserLock(lock);
      throw error;
    }
  }

  if (mode === "persistent") {
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
      const page =
        context.pages().find((candidate) => !candidate.isClosed()) ||
        (await context.newPage());
      const tracePath = await startTracing(context, platform, options);
      markSessionActive(platform, { mode, userDataDir });
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

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1280, height: 800 },
    locale: "en-KE",
  });

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
      const cookies = await context.cookies();
      saveSession(platform, cookies);
      logger.info(
        "BROWSER",
        `Saved updated session cookies for ${platform} on close`,
      );
    } else if (context) {
      markSessionActive(platform, { mode: options.mode || "persistent" });
    }
  } catch (error) {
    logger.warn("BROWSER", `Failed to persist session state for ${platform}`, {
      error: error.message,
    });
  }

  try {
    if (options.shouldCloseBrowser !== false) {
      if (context && options.mode === "persistent") {
        await context.close();
      } else if (browser) {
        await browser.close();
      }
      logger.info("BROWSER", `Closed browser for ${platform}`);
    }
  } finally {
    releaseBrowserLock(options.lock);
    for (const state of ACTIVE_BROWSER_STATES) {
      if (state.browser === browser && state.context === context) {
        state.closed = true;
        ACTIVE_BROWSER_STATES.delete(state);
      }
    }
  }
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
  createBrowser,
  closeBrowser,
  humanDelay,
  humanScroll,
  detectCaptcha,
  checkSessionExpired,
  captureFailureArtifact,
  getProfileDir,
  acquireBrowserLock,
  releaseBrowserLock,
  closeAllBrowsers,
  normalizeHeadless,
};
