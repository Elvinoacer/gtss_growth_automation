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
const INVALIDATED_PLATFORMS = new Set();

const AUTH_STATES = {
  AUTHENTICATED: "AUTHENTICATED",
  LOGIN_REQUIRED: "LOGIN_REQUIRED",
  CHECKPOINT_REQUIRED: "CHECKPOINT_REQUIRED",
  CAPTCHA_REQUIRED: "CAPTCHA_REQUIRED",
  RATE_LIMITED: "RATE_LIMITED",
  TEMPORARY_BLOCK: "TEMPORARY_BLOCK",
  UNKNOWN_STATE: "UNKNOWN_STATE",
};

const X_AUTH_SELECTORS = [
  '[data-testid="SideNav_AccountSwitcher_Button"]',
  '[data-testid="AppTabBar_Home_Link"]',
  '[data-testid="AppTabBar_Profile_Link"]',
  '[data-testid="AppTabBar_Notifications_Link"]',
  '[data-testid="AppTabBar_Messages_Link"]',
  'nav[aria-label="Primary"]',
  'a[href="/home"]',
  'a[href="/explore"]',
  'a[href="/messages"]',
  'div[role="textbox"][data-testid="tweetTextarea_0"]',
  'button[data-testid="tweetButton"]',
  'button[data-testid="tweetButtonInline"]',
];

const X_SEARCH_RESULT_SELECTORS = [
  '[data-testid="UserCell"]',
  '[data-testid="cellInnerDiv"]',
];

const X_LOGIN_SELECTORS = [
  'input[name="text"]',
  'input[autocomplete="username"]',
  'input[autocomplete="current-password"]',
  'button[data-testid="LoginForm_Login_Button"]',
  'div[data-testid="LoginForm_Login_Button"]',
  'a[href="/i/flow/login"]',
  'a[href="/login"]',
];

const X_CAPTCHA_SELECTORS = [
  'iframe[title*="captcha" i]',
  'iframe[src*="captcha" i]',
  'input[name="captcha"]',
  '[aria-label*="captcha" i]',
];

const X_LOGIN_PHRASES = [
  "sign in to x",
  "log in to x",
  "login to x",
  "enter your phone number, email address, or username",
  "enter your phone number, email, or username",
];

const X_CAPTCHA_PHRASES = [
  "captcha",
  "verify you are human",
  "verify you're human",
  "security check",
  "security challenge",
  "unusual activity",
  "suspicious activity",
  "prove you are human",
];

const X_RATE_LIMIT_PHRASES = [
  "rate limit exceeded",
  "too many requests",
  "you have reached the limit",
  "reach your limit",
  "try again later",
  "unable to send",
  "unable to follow more",
  "restricted from direct messaging",
];

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
  if (options.mode === "cdp") return "cdp";
  if (options.cdpEndpoint) return "cdp";
  if (getPlatformEnv(platform, "CDP_ENDPOINT")) return "cdp";

  if (options.mode === "persistent") return "persistent";
  if (options.userDataDir) return "persistent";

  const configured = getPlatformEnv(platform, "BROWSER_MODE");
  if (configured) return configured.toLowerCase();

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
    const content = await page.innerText("body").catch(() => "");
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

function textContainsAny(text, phrases) {
  const normalized = String(text || "").toLowerCase();
  return (
    phrases.find((phrase) => normalized.includes(phrase.toLowerCase())) || null
  );
}

async function getPageBodyText(page) {
  return page
    .locator("body")
    .innerText({ timeout: 2000 })
    .catch(() => "");
}

async function firstVisibleLocator(scope, selectors, timeout = 1500) {
  const deadline = Date.now() + timeout;

  for (const selector of selectors) {
    const locator = scope.locator(selector);
    const count = await locator.count().catch(() => 0);

    for (let index = 0; index < count; index++) {
      const candidate = locator.nth(index);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;

      try {
        await candidate.waitFor({
          state: "visible",
          timeout: Math.min(300, remaining),
        });
        return candidate;
      } catch (_) {
        // Try the next matching candidate.
      }
    }
  }

  return null;
}

async function classifyXSession(page) {
  await page
    .waitForLoadState("domcontentloaded", { timeout: 10000 })
    .catch(() => {});

  const url = page.url().toLowerCase();
  const bodyText = await getPageBodyText(page);
  const body = bodyText.toLowerCase();

  const rateLimitDetected =
    textContainsAny(body, X_RATE_LIMIT_PHRASES) ||
    url.includes("rate_limit") ||
    url.includes("rate-limit");

  if (rateLimitDetected) {
    return {
      state: AUTH_STATES.RATE_LIMITED,
      reason: "X rate limit text detected",
    };
  }

  const captchaDetected =
    url.includes("/challenge") ||
    url.includes("/captcha") ||
    textContainsAny(body, X_CAPTCHA_PHRASES) ||
    (await firstVisibleLocator(page, X_CAPTCHA_SELECTORS, 2000));

  if (captchaDetected) {
    return {
      state: AUTH_STATES.CAPTCHA_REQUIRED,
      reason: "X captcha/challenge detected",
    };
  }

  const loginDetected =
    url.includes("/login") ||
    url.includes("/i/flow/login") ||
    url.includes("/flow/login") ||
    textContainsAny(body, X_LOGIN_PHRASES) ||
    (await firstVisibleLocator(page, X_LOGIN_SELECTORS, 2000));

  if (loginDetected) {
    return {
      state: AUTH_STATES.LOGIN_REQUIRED,
      reason: `X login URL or form detected: ${page.url()}`,
    };
  }

  const searchPageDetected =
    url.includes("/search") ||
    (await firstVisibleLocator(page, X_SEARCH_RESULT_SELECTORS, 2000));

  if (searchPageDetected) {
    return {
      state: AUTH_STATES.AUTHENTICATED,
      reason: "X search page or search result signal found",
    };
  }

  const authenticatedSignal =
    url.includes("/home") ||
    url.includes("/compose/tweet") ||
    textContainsAny(body, ["for you", "following"]) ||
    (await firstVisibleLocator(page, X_AUTH_SELECTORS, 2000));

  if (authenticatedSignal) {
    return {
      state: AUTH_STATES.AUTHENTICATED,
      reason: "X home or composer signal found",
    };
  }

  return {
    state: AUTH_STATES.UNKNOWN_STATE,
    reason:
      "X auth state is ambiguous; no login, captcha, rate-limit, or authenticated signal found",
  };
}

function markAutomationSessionInvalid(platform) {
  INVALIDATED_PLATFORMS.add(platform);
  markSessionInvalid(platform);
}

async function hasPlatformAuthCookie(context, platform) {
  if (!context) return false;

  try {
    const cookies = await context.cookies();
    if (platform === "linkedin") {
      return cookies.some(
        (cookie) =>
          ["li_at", "JSESSIONID"].includes(cookie.name) &&
          /(^|\.)linkedin\.com$/i.test(cookie.domain || ""),
      );
    }

    return cookies.length > 0;
  } catch (error) {
    logger.warn("BROWSER", "Failed to inspect auth cookies", {
      platform,
      error: error.message,
    });
    return false;
  }
}

async function isLinkedInLoggedIn(page) {
  try {
    await page
      .waitForLoadState("domcontentloaded", { timeout: 10000 })
      .catch(() => {});

    const loggedInSignals = [
      '[data-control-name="nav.settings"]',
      ".global-nav",
      ".feed-identity-module",
      ".global-nav__me",
      'input[placeholder*="Search"]',
      ".search-global-typeahead",
      'a[href*="/mynetwork/"]',
      'a[href*="/notifications/"]',
    ];

    for (const selector of loggedInSignals) {
      const visible = await page
        .locator(selector)
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      if (visible) return true;
    }

    return false;
  } catch {
    return false;
  }
}

async function captureFailureSnapshot(page, platform, label) {
  if (!page || page.isClosed()) return {};

  const screenshotPath = await captureFailureArtifact(page, platform, label);
  let htmlPath = null;

  try {
    htmlPath = artifactPath(platform, `${label}-html`, "html");
    fs.writeFileSync(htmlPath, await page.content(), "utf8");
    logger.info("BROWSER", "Captured failure HTML", {
      platform,
      filePath: htmlPath,
    });
  } catch (error) {
    logger.warn("BROWSER", "Failed to capture failure HTML", {
      platform,
      error: error.message,
    });
  }

  return { screenshotPath, htmlPath };
}

async function classifyLinkedInSession(page) {
  const url = page.url().toLowerCase();
  const bodyText = await page
    .locator("body")
    .innerText({ timeout: 2000 })
    .catch(() => "");
  const body = bodyText.toLowerCase();

  if (url.includes("/checkpoint") || url.includes("/challenge")) {
    return {
      state: AUTH_STATES.CHECKPOINT_REQUIRED,
      reason: `LinkedIn checkpoint URL: ${page.url()}`,
    };
  }

  if (
    body.includes("captcha") ||
    body.includes("verify you're human") ||
    body.includes("verify you are human")
  ) {
    return {
      state: AUTH_STATES.CAPTCHA_REQUIRED,
      reason: "LinkedIn human verification detected",
    };
  }

  if (
    body.includes("weekly invitation limit") ||
    body.includes("try again later")
  ) {
    return {
      state: AUTH_STATES.RATE_LIMITED,
      reason: "LinkedIn rate-limit text detected",
    };
  }

  if (
    body.includes("unusual activity") ||
    body.includes("temporarily restricted") ||
    body.includes("temporarily blocked")
  ) {
    return {
      state: AUTH_STATES.TEMPORARY_BLOCK,
      reason: "LinkedIn temporary block text detected",
    };
  }

  if (url.includes("/login") || url.includes("/uas/login")) {
    return {
      state: AUTH_STATES.LOGIN_REQUIRED,
      reason: `LinkedIn login URL: ${page.url()}`,
    };
  }

  const loggedIn = await isLinkedInLoggedIn(page);
  if (loggedIn) {
    return {
      state: AUTH_STATES.AUTHENTICATED,
      reason: "LinkedIn authenticated DOM signal found",
    };
  }

  const hasAuthCookie = await hasPlatformAuthCookie(page.context(), "linkedin");
  if (!hasAuthCookie) {
    return {
      state: AUTH_STATES.LOGIN_REQUIRED,
      reason: "LinkedIn auth cookies are missing",
    };
  }

  return {
    state: AUTH_STATES.UNKNOWN_STATE,
    reason:
      "LinkedIn auth cookies exist, but no authenticated DOM signal was visible",
  };
}

async function checkSessionState(page, platform, emit, options = {}) {
  const url = page.url().toLowerCase();
  const loginSignals = [
    "/login",
    "/checkpoint",
    "/accounts/login",
    "/i/flow/login",
    "/challenge",
  ];

  let result;

  if (platform === "linkedin") {
    result = await classifyLinkedInSession(page);
  } else if (platform === "x") {
    result = await classifyXSession(page);
  } else {
    const challenged = await detectCaptcha(page);
    if (challenged) {
      result = {
        state: AUTH_STATES.CAPTCHA_REQUIRED,
        reason: `${platform} challenge text detected`,
      };
    } else if (loginSignals.some((signal) => url.includes(signal))) {
      result = {
        state: AUTH_STATES.LOGIN_REQUIRED,
        reason: `${platform} login/checkpoint URL: ${page.url()}`,
      };
    } else {
      result = {
        state: AUTH_STATES.AUTHENTICATED,
        reason: "No login or challenge signal detected",
      };
    }
  }

  if (result.state === AUTH_STATES.AUTHENTICATED) {
    markSessionActive(platform, { authState: result.state });
    return result;
  }

  markAutomationSessionInvalid(platform);
  const artifacts = await captureFailureSnapshot(
    page,
    platform,
    options.label || `session-failure-${result.state}`,
  );

  if (emit) {
    emit(
      result.state.toLowerCase(),
      `${platform} session state: ${result.state}. ${result.reason}`,
      {
        platform,
        authState: result.state,
        reason: result.reason,
        ...artifacts,
      },
    );
  }

  await sendNotification(
    `GTSS ${platform} session needs attention: ${result.state}`,
    `${result.reason}\nScreenshot: ${artifacts.screenshotPath || "not captured"}\nHTML: ${artifacts.htmlPath || "not captured"}`,
  );

  if (process.env.DEBUG_FAILURE_HOLD === "true") {
    await page.pause();
  }

  return { ...result, ...artifacts };
}

async function checkSessionExpired(page, platform, emit) {
  const result = await checkSessionState(page, platform, emit);
  return result.state !== AUTH_STATES.AUTHENTICATED;
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

      // Always open a NEW tab for automation — never hijack existing tabs
      const page = await context.newPage();
      logger.info("BROWSER", `Opened new CDP tab for ${platform} automation`);

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
      const mode = options.mode || "persistent";
      const hasAuthCookie = await hasPlatformAuthCookie(context, platform);
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
    if (
      options.shouldClosePageOnly &&
      options.page &&
      !options.page.isClosed()
    ) {
      // CDP mode: close only the automation tab, keep Chrome running
      await options.page.close();
      logger.info(
        "BROWSER",
        `Closed automation tab for ${platform} (Chrome stays open)`,
      );
    } else if (options.shouldCloseBrowser !== false) {
      if (context && options.mode === "persistent") {
        await context.close();
      } else if (browser) {
        await browser.close();
      }
      logger.info("BROWSER", `Closed browser for ${platform}`);
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
  checkSessionState,
  AUTH_STATES,
  captureFailureArtifact,
  getBrowserMode,
  getProfileDir,
  acquireBrowserLock,
  releaseBrowserLock,
  closeAllBrowsers,
  normalizeHeadless,
};
