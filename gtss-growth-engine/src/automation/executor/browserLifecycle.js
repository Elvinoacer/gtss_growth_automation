/**
 * Executor — Browser Lifecycle Helpers
 *
 *   - closeBrowserState(browserState, platform)
 *       Tear down a (browser, context, page) tuple created by createBrowser,
 *       forwarding all of the original options back into browserBase.closeBrowser.
 *
 *   - maxSessionRecoveryAttempts()
 *       Reads MAX_SESSION_RECOVERY_ATTEMPTS from env (default 2).
 *
 *   - createValidatedBrowser(platform, emit)
 *       Open a browser, navigate to the platform home page, run
 *       checkSessionState, and retry up to MAX_SESSION_RECOVERY_ATTEMPTS
 *       times if the session is not AUTHENTICATED. Returns
 *       { browserState, authState } (browserState is null on failure).
 *
 * Extracted from the original automation/executor.js for maintainability.
 */

const {
  createBrowser,
  closeBrowser,
  humanDelay,
  checkSessionState,
  AUTH_STATES,
} = require('../browserBase');
const logger = require('../../utils/logger');
const { openSessionCheckPage } = require('./sessionCheck');

async function closeBrowserState(browserState, platform) {
  if (!browserState) return;
  await closeBrowser(browserState.browser, platform, browserState.context, {
    mode: browserState.mode,
    tracePath: browserState.tracePath,
    shouldCloseBrowser: browserState.shouldCloseBrowser,
    shouldClosePageOnly: browserState.shouldClosePageOnly,
    page: browserState.page,
    lock: browserState.lock,
  });
}

function maxSessionRecoveryAttempts() {
  const configured = Number(process.env.MAX_SESSION_RECOVERY_ATTEMPTS || 2);
  return Number.isFinite(configured) && configured >= 0 ? configured : 2;
}

async function createValidatedBrowser(platform, emit) {
  const attempts = maxSessionRecoveryAttempts() + 1;
  let lastState = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let browserState = null;
    try {
      browserState = await createBrowser(platform);
      await openSessionCheckPage(browserState.page, platform);

      lastState = await checkSessionState(browserState.page, platform, emit, {
        label: `session-check-attempt-${attempt}`,
      });

      if (lastState.state === AUTH_STATES.AUTHENTICATED) {
        return { browserState, authState: lastState };
      }

      if (attempt < attempts) {
        emit(
          'warn',
          `${platform} auth check returned ${lastState.state}; retrying session recovery (${attempt}/${attempts - 1}).`,
          {
            platform,
            authState: lastState.state,
            reason: lastState.reason,
          },
        );
        await browserState.page
          .reload({
            waitUntil: 'domcontentloaded',
            timeout: 60000,
          })
          .catch(() => {});
        await humanDelay(1200, 2200);
      }
    } finally {
      if (
        browserState &&
        (!lastState || lastState.state !== AUTH_STATES.AUTHENTICATED)
      ) {
        await closeBrowserState(browserState, platform);
      }
    }
  }

  return { browserState: null, authState: lastState };
}

module.exports = {
  closeBrowserState,
  maxSessionRecoveryAttempts,
  createValidatedBrowser,
};
