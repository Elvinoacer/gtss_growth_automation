/**
 * Browser Base — Index
 * Re-exports the public API of the browserBase module so callers that
 * `require('../browserBase')` (or `'../../automation/browserBase'`,
 * etc.) continue to receive the exact same shape as the original
 * browserBase.js (~2,440 lines) which was split into thematic files
 * inside this directory for maintainability.
 *
 * See individual file headers for detail on each concern.
 */

const { createBrowser } = require("./createBrowser");
const { closeBrowser, closeBrowserContext, closeAllBrowsers } = require("./closeBrowser");
const { humanDelay, humanTypeText, humanScroll, detectCaptcha } = require("./humanInteraction");
const { checkSessionState, checkSessionExpired } = require("./sessionClassification");
const { AUTH_STATES } = require("./constants");
const { captureFailureArtifact } = require("./artifacts");
const { getBrowserMode, getProfileDir } = require("./env");
const { acquireBrowserLock, releaseBrowserLock } = require("./locks");
const { normalizeHeadless } = require("./env");
const { closeStrayTabs, isStrayTabUrl, installStrayTabInterceptor } = require("./strayTabs");
const { firstVisible, getSelectorHealthReport } = require("./locators");
const {
  INSTAGRAM_AUTH_SELECTORS,
  INSTAGRAM_LOGIN_SELECTORS,
  INSTAGRAM_CAPTCHA_SELECTORS,
  INSTAGRAM_BLOCK_PHRASES,
} = require("./constants");
const {
  checkInstagramSessionState,
  checkForInstagramBlock,
  isInstagramBlocked,
  setInstagramBlockedUntil,
} = require("./instagramDetection");
const { humanMouseMove } = require("./humanInteraction");
const { simulateOrganicBrowse, dailySessionWarmup, createInstagramBrowser } = require("./instagramBrowser");

module.exports = {
  createBrowser,
  closeBrowser,
  closeBrowserContext,
  humanDelay,
  humanTypeText,
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
  closeStrayTabs,
  isStrayTabUrl,
  installStrayTabInterceptor,

  // Instagram Extensions
  firstVisible,
  INSTAGRAM_AUTH_SELECTORS,
  INSTAGRAM_LOGIN_SELECTORS,
  INSTAGRAM_CAPTCHA_SELECTORS,
  INSTAGRAM_BLOCK_PHRASES,
  checkInstagramSessionState,
  checkForInstagramBlock,
  isInstagramBlocked,
  setInstagramBlockedUntil,
  getSelectorHealthReport,
  humanMouseMove,
  simulateOrganicBrowse,
  dailySessionWarmup,
  createInstagramBrowser,
};
