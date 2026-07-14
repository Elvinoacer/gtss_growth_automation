/**
 * Browser Base — Shared Constants
 * All module-wide constants (auth state enum, user-agent pool, per-platform
 * selector and phrase lists) used across the browserBase split files.
 * Extracted from the original browserBase.js for maintainability.
 */

// Rotating pool of realistic desktop Chrome User-Agent strings used by both
// createBrowser (ephemeral context) and createInstagramBrowser.
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

// Canonical auth-state enum returned by checkSessionState / classifyXSession /
// classifyLinkedInSession. Exported as part of the browserBase public API.
const AUTH_STATES = {
  AUTHENTICATED: "AUTHENTICATED",
  LOGIN_REQUIRED: "LOGIN_REQUIRED",
  CHECKPOINT_REQUIRED: "CHECKPOINT_REQUIRED",
  CAPTCHA_REQUIRED: "CAPTCHA_REQUIRED",
  RATE_LIMITED: "RATE_LIMITED",
  TEMPORARY_BLOCK: "TEMPORARY_BLOCK",
  UNKNOWN_STATE: "UNKNOWN_STATE",
};

// ── X (Twitter) selectors / phrases used by classifyXSession ────────────────
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

// ── Instagram selectors / phrases (used by checkInstagramSessionState etc.) ─
const INSTAGRAM_AUTH_SELECTORS = [
  'a[href="/"]',
  'a[href*="/direct/inbox/"]',
  'svg[aria-label="Home"]',
  'svg[aria-label="New post"]',
];

const INSTAGRAM_LOGIN_SELECTORS = [
  'input[name="username"]',
  'input[name="password"]',
  'button[type="submit"]',
  "form#loginForm",
];

const INSTAGRAM_CAPTCHA_SELECTORS = [
  'iframe[title*="recaptcha" i]',
  "#recaptcha",
  'iframe[src*="recaptcha" i]',
  ".checkpoint-content",
];

const INSTAGRAM_BLOCK_PHRASES = [
  "action blocked",
  "try again later",
  "we limit how often you can",
  "temporarily blocked",
  "restrict",
];

module.exports = {
  USER_AGENTS,
  AUTH_STATES,
  X_AUTH_SELECTORS,
  X_SEARCH_RESULT_SELECTORS,
  X_LOGIN_SELECTORS,
  X_CAPTCHA_SELECTORS,
  X_LOGIN_PHRASES,
  X_CAPTCHA_PHRASES,
  X_RATE_LIMIT_PHRASES,
  INSTAGRAM_AUTH_SELECTORS,
  INSTAGRAM_LOGIN_SELECTORS,
  INSTAGRAM_CAPTCHA_SELECTORS,
  INSTAGRAM_BLOCK_PHRASES,
};
