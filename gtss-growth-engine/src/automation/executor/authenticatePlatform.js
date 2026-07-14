/**
 * Executor — Manual Platform Authentication
 *
 * authenticatePlatform(platform) opens a visible browser (loginSession flag
 * set) and resolves once the user has completed sign-in. It uses
 * isManualAuthComplete() to poll the page URL — when the URL indicates an
 * authenticated feed/home page, the promise resolves; when the page closes
 * first or the 5-minute timeout fires, it rejects.
 *
 * getLoginSessionHomeUrl(platform) returns the home page to navigate to
 * (NOT a /login URL — the platform itself redirects unauthenticated
 * visitors to its login form).
 *
 * Extracted from the original automation/executor.js for maintainability.
 */

const { createBrowser } = require('../browserBase');
const logger = require('../../utils/logger');
const {
  isManualAuthComplete,
} = require('./sessionCheck');
const { closeBrowserState } = require('./browserLifecycle');

async function authenticatePlatform(platform) {
  logger.info('AUTH', `Starting manual auth for ${platform}`);

  // ─── loginSession flag ────────────────────────────────────────────────
  //
  // This is the single source of truth that tells createBrowser() (and
  // normalizeHeadless()) that the browser MUST be visible, no matter what
  // the user's background-mode preference is. Critical, user-initiated
  // sign-in flows always need a visible window so the user can type
  // credentials, solve CAPTCHAs, and approve 2FA prompts. Pipeline /
  // automation runs do NOT set this flag, so they continue to respect
  // the user's CDP_VISIBLE_DEFAULT / ALLOW_HEADLESS_SOCIAL preference.
  //
  // In CDP mode, createBrowser() also uses this flag to ask the desktop
  // launcher's bridge to bring the shared Chrome to the foreground (or
  // restart it visibly) before opening the login tab — eliminating the
  // "sometimes the browser shows, sometimes it doesn't" abnormality that
  // happened when CDP was already running headless in the background.
  const browserState = await createBrowser(platform, {
    headless: false,
    loginSession: true,
  });
  const { page } = browserState;

  // ─── Navigate to the platform HOME PAGE, not the login page ───────────
  //
  // Per the project's login-session contract: every platform's own home
  // page already redirects unauthenticated visitors to its login form,
  // and re-redirects authenticated visitors to their feed/timeline. We
  // therefore navigate to the home page and let the platform handle the
  // routing — this avoids hard-coding login URLs that change frequently
  // (X's /i/flow/login, LinkedIn's /login, etc.) and avoids sending the
  // user to a login page when their session is already valid (which
  // some platforms interpret as a suspicious signal).
  //
  // Gemini (Google) is special: it has no dedicated login endpoint at
  // all. Navigating to https://gemini.google.com/ either shows the chat
  // UI (if the Google session is valid) or redirects to
  // accounts.google.com for sign-in. isManualAuthComplete() above
  // treats "URL is on gemini.google.com" as the success signal.
  const loginUrl = getLoginSessionHomeUrl(platform);
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  return new Promise((resolve, reject) => {
    let checkInterval;
    let timeout;
    let finalized = false;

    const settle = async (success, errorMessage) => {
      if (finalized) return;
      finalized = true;
      clearInterval(checkInterval);
      if (timeout) clearTimeout(timeout);

      try {
        await closeBrowserState(browserState, platform);
      } catch (e) {}

      if (success) {
        resolve(true);
      } else {
        reject(new Error(errorMessage));
      }
    };

    page.once('close', () => {
      void settle(
        isManualAuthComplete(page, platform),
        'Browser closed before authentication completed',
      );
    });

    timeout = setTimeout(
      () => {
        void settle(false, 'Auth timeout (5 mins)');
      },
      5 * 60 * 1000,
    );

    checkInterval = setInterval(async () => {
      try {
        if (finalized) return;

        if (page.isClosed()) {
          void settle(
            isManualAuthComplete(page, platform),
            'Browser closed before authentication completed',
          );
          return;
        }

        if (isManualAuthComplete(page, platform)) {
          await settle(true);
        }
      } catch (err) {}
    }, 3000);
  });
}

/**
 * Resolve the home-page URL to navigate to during a login session.
 *
 * Per the login-session contract: we navigate to the platform's HOME page
 * (not its /login page). The platform itself redirects to the login form
 * if the visitor is unauthenticated, and to the feed/timeline if they're
 * already signed in. This keeps the automation layer agnostic to each
 * platform's login-URL churn and avoids treating an already-valid session
 * as a fresh login (which some platforms flag as suspicious).
 *
 * Gemini (Google) has no dedicated login endpoint; its home page IS the
 * entry point and redirects to accounts.google.com when not signed in.
 */
function getLoginSessionHomeUrl(platform) {
  switch (platform) {
    case 'linkedin':
      return 'https://www.linkedin.com/';
    case 'x':
    case 'twitter':
      return 'https://x.com/';
    case 'facebook':
      return 'https://www.facebook.com/';
    case 'instagram':
      return 'https://www.instagram.com/';
    case 'google':
    case 'gemini':
      return 'https://gemini.google.com/';
    default:
      return `https://www.${platform}.com/`;
  }
}

module.exports = {
  authenticatePlatform,
  getLoginSessionHomeUrl,
};
