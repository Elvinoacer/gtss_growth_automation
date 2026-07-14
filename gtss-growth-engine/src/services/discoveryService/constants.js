/**
 * Discovery Service — Constants
 * Tuning knobs, selector lists, reserved-path sets, and noise-line patterns
 * used across the lead-discovery pipeline (LinkedIn / X / Facebook / Instagram).
 * Extracted from the original discoveryService.js for maintainability.
 */

// Hourly cap on profile visits (anti-detection). When the in-memory visit
// timestamp buffer reaches this size within the last 60 minutes, the discoverer
// pauses until the oldest timestamp ages out.
const MAX_PROFILE_VISITS_PER_HOUR = 50;

// Default random action-delay window (ms). Overridable via env vars
// DISCOVERY_MIN_DELAY_MS / DISCOVERY_MAX_DELAY_MS at runtime.
const DEFAULT_MIN_DELAY_MS = 3000;
const DEFAULT_MAX_DELAY_MS = 15000;

// X (Twitter) search-result card selectors — tried in order by firstVisibleLocator.
const X_SEARCH_CARD_SELECTORS = ['[data-testid="UserCell"]', '[data-testid="cellInnerDiv"]'];

// X profile URL paths that are NOT user profiles (home, search, settings, etc.).
// Used to reject noise hrefs captured from X search snapshots.
const X_RESERVED_PROFILE_PATHS = new Set([
  "home",
  "search",
  "explore",
  "messages",
  "notifications",
  "compose",
  "intent",
  "settings",
  "login",
  "i",
  "hashtag",
]);

// X second-segment paths that disqualify a profile URL (e.g. /user/status/123
// is a tweet, not a profile).
const X_RESERVED_SECOND_PATHS = new Set([
  "status",
  "photo",
  "video",
  "search",
  "home",
  "explore",
  "messages",
  "compose",
  "intent",
  "settings",
  "notifications",
]);

// Facebook top-level paths that are NOT user profiles (search, events, groups,
// marketplace, pages, etc.). Used to reject noise hrefs from FB search snapshots.
const FACEBOOK_RESERVED_PROFILE_PATHS = new Set([
  "search",
  "events",
  "groups",
  "marketplace",
  "pages",
  "videos",
  "photos",
  "stories",
  "gaming",
  "fundraisers",
  "friends",
  "watch",
  "reel",
  "share",
  "login",
  "help",
  "settings",
  "notifications",
  "messages",
  "profile",
]);

// Lines captured from X / Facebook cards that are clearly UI noise (Follow /
// Following / Promoted / Verified / etc.) rather than bio content.
const X_NOISE_LINE_PATTERNS = [
  /^follow$/i,
  /^following$/i,
  /^followers?$/i,
  /^posts?$/i,
  /^view profile$/i,
  /^view post$/i,
  /^message$/i,
  /^promoted$/i,
  /^ad$/i,
  /^verified$/i,
  /^premium$/i,
  /^subscribe$/i,
  /^join now$/i,
];

// Platforms that the discovery service actually knows how to search.
// Must be a subset of the platformCatalog's getPlatformKeys() output.
const DISCOVERY_PLATFORM_KEYS = ["linkedin", "x", "facebook", "instagram"];

module.exports = {
  MAX_PROFILE_VISITS_PER_HOUR,
  DEFAULT_MIN_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  X_SEARCH_CARD_SELECTORS,
  X_RESERVED_PROFILE_PATHS,
  X_RESERVED_SECOND_PATHS,
  FACEBOOK_RESERVED_PROFILE_PATHS,
  X_NOISE_LINE_PATTERNS,
  DISCOVERY_PLATFORM_KEYS,
};
