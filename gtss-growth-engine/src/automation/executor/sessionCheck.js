/**
 * Executor — Manual-Auth Session-Check Helpers
 *
 * URL-based session-state detection used by the manual-auth flow
 * (authenticatePlatform) and the validated-browser factory
 * (createValidatedBrowser):
 *
 *   - getPageUrl(page)                  : safe `page.url()` read
 *   - isManualAuthComplete(page, plat)  : did the user finish signing in?
 *   - getSessionCheckUrl(platform)      : the home URL to navigate to
 *   - openSessionCheckPage(page, plat)  : navigate + settle delay
 *
 * Extracted from the original automation/executor.js for maintainability.
 */

const { humanDelay } = require('../browserBase');
const logger = require('../../utils/logger');

function getPageUrl(page) {
  try {
    return String(page.url()).toLowerCase();
  } catch (_) {
    return '';
  }
}

function isManualAuthComplete(page, platform) {
  const url = getPageUrl(page);
  if (!url) return false;

  if (platform === 'linkedin') return url.includes('/feed');
  if (platform === 'x') return url.includes('/home');
  if (platform === 'facebook') {
    return (
      url.includes('facebook.com') &&
      !url.includes('/login') &&
      !url.includes('/checkpoint') &&
      !url.includes('/recover') &&
      !url.includes('/two_factor') &&
      !url.includes('/r.php')
    );
  }
  if (platform === 'instagram') {
    return (
      url.includes('instagram.com') &&
      !url.includes('/accounts/login') &&
      !url.includes('/challenge') &&
      !url.includes('/two_factor') &&
      !url.includes('/accounts/onetap')
    );
  }
  // Google / Gemini — the user signs into their Google account and lands
  // on gemini.google.com when authentication succeeds. While the Google
  // sign-in flow is in progress, the URL stays under accounts.google.com
  // (or myaccount.google.com for the account picker). Once Gemini loads,
  // we treat the session as authenticated.
  if (platform === 'google' || platform === 'gemini') {
    return (
      url.includes('gemini.google.com') &&
      !url.includes('/accounts.google.com')
    );
  }

  return (
    !url.includes('/login') &&
    !url.includes('/checkpoint') &&
    !url.includes('/challenge')
  );
}

function getSessionCheckUrl(platform) {
  if (platform === 'linkedin') return 'https://www.linkedin.com/feed/';
  if (platform === 'x') return 'https://x.com/home';
  return `https://www.${platform}.com`;
}

async function openSessionCheckPage(page, platform) {
  const url = getSessionCheckUrl(platform);
  const waitUntil = 'domcontentloaded';

  await page.goto(url, { waitUntil, timeout: 60000 }).catch(async (error) => {
    logger.warn(
      'AUTOMATION',
      `Session check navigation did not fully settle for ${platform}`,
      {
        error: error.message,
        url,
      },
    );
    if (!page.isClosed() && page.url() !== url) {
      await page
        .goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        .catch(() => {});
    }
  });

  if (platform === 'linkedin') {
    await humanDelay(1000, 1800);
  }
}

module.exports = {
  getPageUrl,
  isManualAuthComplete,
  getSessionCheckUrl,
  openSessionCheckPage,
};
