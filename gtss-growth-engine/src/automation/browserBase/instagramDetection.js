/**
 * Browser Base — Instagram-Specific Detection
 * configureInstagramContext, resolveInstagramCdpEndpoint,
 * setInstagramBlockedUntil, clearInstagramBlockedUntil, isInstagramBlocked,
 * checkForInstagramBlock, checkInstagramSessionState — Instagram-aware
 * helpers for context hardening, CDP endpoint resolution, action-block
 * persistence (via the settings table) and the high-level session
 * classifier used by createInstagramBrowser.
 * Extracted from the original browserBase.js for maintainability.
 */

const { getDb } = require("../../db/database");
const { getContext } = require("../../services/contextService");
const { sendNotification } = require("../../services/notificationService");
const logger = require("../../utils/logger");
const {
  INSTAGRAM_AUTH_SELECTORS,
  INSTAGRAM_LOGIN_SELECTORS,
  INSTAGRAM_CAPTCHA_SELECTORS,
  INSTAGRAM_BLOCK_PHRASES,
} = require("./constants");
const { textContainsAny, getPageBodyText } = require("./humanInteraction");
const { firstVisible } = require("./locators");
const { getPlatformEnv } = require("./env");

async function configureInstagramContext(context) {
  await context.addInitScript(() => {
    try {
      const newProto = navigator.__proto__;
      delete newProto.webdriver;
    } catch (_) {}

    try {
      Object.defineProperty(navigator, "plugins", {
        get: () => [
          { name: "Chrome PDF Viewer" },
          { name: "Chromium PDF Viewer" },
          { name: "WebKit built-in PDF" },
        ],
      });
    } catch (_) {}

    try {
      window.chrome = { runtime: {} };
    } catch (_) {}
  });

  await context.grantPermissions(["geolocation"]).catch(() => {});
  await context
    .setGeolocation({ latitude: -1.2921, longitude: 36.8219 })
    .catch(() => {});
}

function resolveInstagramCdpEndpoint(options = {}) {
  const explicitEndpoint =
    options.cdpEndpoint ||
    getPlatformEnv("instagram", "CDP_ENDPOINT") ||
    process.env.CDP_ENDPOINT;
  if (explicitEndpoint) return explicitEndpoint;

  const cdpPort =
    options.cdpPort ||
    getPlatformEnv("instagram", "CDP_PORT") ||
    process.env.CDP_PORT ||
    process.env.BROWSER_CDP_PORT;
  if (cdpPort) return `http://127.0.0.1:${cdpPort}`;

  return "http://127.0.0.1:9222";
}

function setInstagramBlockedUntil(hours = 24) {
  const db = getDb();
  const resumesAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('ig_blocked_until', ?)",
  ).run(resumesAt);
  return resumesAt;
}

function clearInstagramBlockedUntil() {
  const db = getDb();
  db.prepare("DELETE FROM settings WHERE key = 'ig_blocked_until'").run();
}

function isInstagramBlocked() {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'ig_blocked_until'")
    .get();
  if (!row || !row.value) {
    return { blocked: false, resumesAt: null };
  }
  const resumesAt = new Date(row.value);
  if (isNaN(resumesAt.getTime()) || resumesAt <= new Date()) {
    return { blocked: false, resumesAt: null };
  }
  return { blocked: true, resumesAt: row.value };
}

/**
 * Check if the current page contains any action block messages.
 */
async function checkForInstagramBlock(page, emitter = null) {
  const bodyText = await getPageBodyText(page);
  const matchedPhrase = textContainsAny(bodyText, INSTAGRAM_BLOCK_PHRASES);
  if (matchedPhrase) {
    const resumesAt = setInstagramBlockedUntil(24);
    const message = `Instagram action block detected: "${matchedPhrase}". Resuming at ${resumesAt}`;

    if (emitter) {
      if (typeof emitter === "function") {
        try {
          emitter("warn", message, { resumesAt });
        } catch (_) {}
      } else if (emitter.emit && typeof emitter.emit === "function") {
        try {
          emitter.emit("warn", message, { resumesAt });
        } catch (_) {}
      }
    }
    logger.warn("INSTAGRAM_BLOCK", message);

    try {
      const ctx = getContext();
      await sendNotification(
        `[${ctx.ctx_biz_name}] Instagram action block detected`,
        `An action block was encountered during Instagram automation.\n\nBlock Phrase: "${matchedPhrase}"\n\nAutomation will be paused until ${resumesAt} (24 hours).`,
      );
    } catch (err) {
      logger.error(
        "INSTAGRAM_BLOCK",
        "Failed to send block email notification",
        err,
      );
    }

    return {
      blocked: true,
      reason: `Instagram action block detected: "${matchedPhrase}"`,
      resumesAt,
    };
  }
  return { blocked: false, reason: "", resumesAt: null };
}

/**
 * Identify and return the current authentication/session state on Instagram.
 */
async function checkInstagramSessionState(page) {
  await page
    .waitForLoadState("domcontentloaded", { timeout: 10000 })
    .catch(() => {});

  const blockCheck = await checkForInstagramBlock(page);
  if (blockCheck.blocked) {
    return "blocked";
  }

  const url = page.url().toLowerCase();

  // Check for captcha/challenge
  const captchaDetected =
    url.includes("/challenge") ||
    url.includes("/checkpoint") ||
    (await firstVisible(page, INSTAGRAM_CAPTCHA_SELECTORS, 2000));

  if (captchaDetected) {
    return "captcha";
  }

  // Check for logged_out / login page
  const loggedOutDetected =
    url.includes("/accounts/login") ||
    url.includes("/login") ||
    (await firstVisible(page, INSTAGRAM_LOGIN_SELECTORS, 2000));

  if (loggedOutDetected) {
    return "logged_out";
  }

  // Check for authenticated
  const authenticatedDetected =
    url.includes("/direct/inbox") ||
    (await firstVisible(page, INSTAGRAM_AUTH_SELECTORS, 2000));

  if (authenticatedDetected) {
    return "authenticated";
  }

  return "unknown";
}

module.exports = {
  configureInstagramContext,
  resolveInstagramCdpEndpoint,
  setInstagramBlockedUntil,
  clearInstagramBlockedUntil,
  isInstagramBlocked,
  checkForInstagramBlock,
  checkInstagramSessionState,
};
