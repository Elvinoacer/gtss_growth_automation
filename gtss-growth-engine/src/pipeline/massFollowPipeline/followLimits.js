/**
 * massFollowPipeline/followLimits.js
 *
 * Daily / hourly / weekly follow-count helpers + the platform rate-limit
 * detector. All seven functions here are exported from index.js under
 * `_internal` so the existing test suite can introspect them.
 *
 *   - getDailyFollowCount(p)     Count today's 'follows'/'connections' for a platform
 *   - getHourlyFollowCount(p)    Count over the last 60 minutes
 *   - getWeeklyFollowCount(p)    Count over the last 7 days
 *   - getEffectiveDailyLimit(p)  Stored Settings → static limits.js → 5 default
 *   - getEffectiveHourlyLimit(p) Same precedence; default 3
 *   - getEffectiveWeeklyLimit(p) Same precedence; default 25
 *   - isRateLimitResult(r)       Sniff a platform-adapter result for rate-limit signals
 *
 * The stored-vs-static precedence mirrors isWithinLimit in db/database.js —
 * user-configured daily_limits (Settings → Limits) win, then limits.js, then
 * a conservative default.
 */

const { getDb } = require("../../db/database");
const limits = require("../../config/limits");

function getDailyFollowCount(platform) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM daily_actions
       WHERE platform = ?
         AND action_type IN ('follows', 'connections')
         AND DATE(performed_at) = DATE('now', 'localtime')`,
    )
    .get(platform);
  return row ? row.count : 0;
}

function getHourlyFollowCount(platform) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM daily_actions
       WHERE platform = ?
         AND action_type IN ('follows', 'connections')
         AND performed_at >= datetime('now', '-1 hour')`,
    )
    .get(platform);
  return row ? row.count : 0;
}

function getWeeklyFollowCount(platform) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM daily_actions
       WHERE platform = ?
         AND action_type IN ('follows', 'connections')
         AND performed_at >= datetime('now', '-7 days')`,
    )
    .get(platform);
  return row ? row.count : 0;
}

function getEffectiveDailyLimit(platform) {
  // Prefer the user's stored daily_limits (Settings → Limits), fall back to
  // the static limits.js. The 'follows' key is used by X/Instagram/TikTok;
  // 'connections' is used by LinkedIn/Facebook (which call friend/connect).
  const stored = require("../../db/database").getDailyLimits();
  const storedPlatform = stored[platform] || {};
  const staticPlatform = limits[platform] || {};
  if (typeof storedPlatform.follows === "number") return storedPlatform.follows;
  if (typeof storedPlatform.connections === "number") return storedPlatform.connections;
  if (typeof staticPlatform.follows === "number") return staticPlatform.follows;
  if (typeof staticPlatform.connections === "number") return staticPlatform.connections;
  return 5; // Conservative default — mirrors isWithinLimit fallback in database.js
}

function getEffectiveHourlyLimit(platform) {
  const stored = require("../../db/database").getDailyLimits();
  const storedHourly = (stored[platform] && stored[platform].hourly) || {};
  const staticHourly = (limits[platform] && limits[platform].hourly) || {};
  if (typeof storedHourly.follows === "number") return storedHourly.follows;
  if (typeof storedHourly.connections === "number") return storedHourly.connections;
  if (typeof staticHourly.follows === "number") return staticHourly.follows;
  if (typeof staticHourly.connections === "number") return staticHourly.connections;
  return 3;
}

function getEffectiveWeeklyLimit(platform) {
  const stored = require("../../db/database").getDailyLimits();
  const storedWeekly = (stored[platform] && stored[platform].weekly) || {};
  const staticWeekly = (limits[platform] && limits[platform].weekly) || {};
  if (typeof storedWeekly.follows === "number") return storedWeekly.follows;
  if (typeof storedWeekly.connections === "number") return storedWeekly.connections;
  if (typeof staticWeekly.follows === "number") return staticWeekly.follows;
  if (typeof staticWeekly.connections === "number") return staticWeekly.connections;
  return 25;
}

function isRateLimitResult(result) {
  const category = result && result.metadata && result.metadata.category;
  const message = String(result?.error || "").toLowerCase();
  return (
    category === "rate_limited" ||
    message.includes("rate limit") ||
    message.includes("following too fast") ||
    message.includes("too many actions") ||
    message.includes("temporarily blocked") ||
    message.includes("action blocked")
  );
}

module.exports = {
  getDailyFollowCount,
  getHourlyFollowCount,
  getWeeklyFollowCount,
  getEffectiveDailyLimit,
  getEffectiveHourlyLimit,
  getEffectiveWeeklyLimit,
  isRateLimitResult,
};
