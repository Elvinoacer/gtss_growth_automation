/**
 * Browser Base — Session State Classification
 * classifyXSession, classifyLinkedInSession, hasPlatformAuthCookie,
 * isLinkedInLoggedIn, checkSessionState, checkSessionExpired — read the
 * current page (URL + body text + cookies + DOM signals) and decide which
 * AUTH_STATES bucket it falls into. checkSessionState is the public entry
 * point; the rest are platform-specific helpers.
 * Extracted from the original browserBase.js for maintainability.
 */

const {
  loadSession,
  saveSession,
  markSessionActive,
} = require("../sessionManager");
const { sendNotification } = require("../../services/notificationService");
const {
  AUTH_STATES,
  X_AUTH_SELECTORS,
  X_SEARCH_RESULT_SELECTORS,
  X_LOGIN_SELECTORS,
  X_CAPTCHA_SELECTORS,
  X_LOGIN_PHRASES,
  X_CAPTCHA_PHRASES,
  X_RATE_LIMIT_PHRASES,
} = require("./constants");
const { detectCaptcha, textContainsAny, getPageBodyText } = require("./humanInteraction");
const { firstVisibleLocator } = require("./locators");
const { captureFailureSnapshot } = require("./artifacts");
const { markAutomationSessionInvalid } = require("./browserState");

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
    // logger is imported lazily to avoid a circular require at module load.
    const logger = require("../../utils/logger");
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

async function classifyLinkedInSession(page) {
  const logger = require("../../utils/logger");
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
  const logger = require("../../utils/logger");
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

// Re-export loadSession/saveSession so callers that previously imported them
// from the original browserBase.js (none do today, but kept for safety) still
// work transparently. The sessionManager import above is also used directly
// by checkSessionState/markSessionActive.
module.exports = {
  classifyXSession,
  classifyLinkedInSession,
  hasPlatformAuthCookie,
  isLinkedInLoggedIn,
  checkSessionState,
  checkSessionExpired,
  loadSession,
  saveSession,
};
