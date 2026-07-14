/**
 * queries.js — Daily-action helpers (rate-limit accounting).
 *
 * Provides the public `getDailyActionCount`, `getDailyLimits`, `isWithinLimit`,
 * `normalizeActionType`, and `increment_action_count` helpers used by the
 * platform-automation layer to enforce per-platform daily caps. Each call hits
 * the shared `db` singleton imported from ./connection — exactly the same
 * behavior as the original monolithic database.js.
 */
"use strict";

const limits = require("../../config/limits");
const { db } = require("./connection");

function normalizeActionType(actionType) {
  const aliases = {
    connect: "connections",
    connection: "connections",
    dm: "dms",
    direct_message: "dms",
    follow: "follows",
    like: "likes",
    instagram_dm: "dms",
    instagram_follow: "follows",
    instagram_like: "likes",
  };

  return aliases[actionType] || actionType;
}

function getDailyActionCount(platform, actionType) {
  const normalizedActionType = normalizeActionType(actionType);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM daily_actions
       WHERE platform = ?
         AND action_type = ?
         AND DATE(performed_at) = DATE('now', 'localtime')`,
    )
    .get(platform, normalizedActionType);

  return row.count;
}

function getDailyLimits() {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'daily_limits'")
    .get();

  if (!row || !row.value) {
    return {};
  }

  try {
    return JSON.parse(row.value);
  } catch (_) {
    return {};
  }
}

function isWithinLimit(platform, actionType) {
  const normalizedActionType = normalizeActionType(actionType);
  const platformLimits = getDailyLimits()[platform] || {};

  let limit;
  if (typeof platformLimits[normalizedActionType] === "number") {
    limit = platformLimits[normalizedActionType];
  } else if (
    limits[platform] &&
    typeof limits[platform][normalizedActionType] === "number"
  ) {
    limit = limits[platform][normalizedActionType];
  }

  if (typeof limit !== "number") {
    // Emit a visible warning; use a conservative default of 5 instead of blocking
    console.warn(
      `[LIMITS] No limit configured for ${platform}.${normalizedActionType} — defaulting to 5`,
    );
    return getDailyActionCount(platform, normalizedActionType) < 5;
  }

  return getDailyActionCount(platform, normalizedActionType) < limit;
}

function increment_action_count(
  platform,
  actionType,
  leadId = null,
  outcome = "sent",
  reason = null,
) {
  const normalizedActionType = normalizeActionType(actionType);
  const insert = db.prepare(
    `INSERT INTO daily_actions (platform, action_type, lead_id, outcome, reason, performed_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  );
  insert.run(platform, normalizedActionType, leadId, outcome, reason);
}

module.exports = {
  getDailyActionCount,
  getDailyLimits,
  isWithinLimit,
  normalizeActionType,
  increment_action_count,
};
