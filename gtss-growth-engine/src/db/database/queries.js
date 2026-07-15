/**
 * queries.js — Daily-action helpers (rate-limit accounting).
 *
 * Provides the public `getDailyActionCount`, `getDailyLimits`, `isWithinLimit`,
 * `normalizeActionType`, and `increment_action_count` helpers used by the
 * platform-automation layer to enforce per-platform daily caps. Each call hits
 * the shared `db` singleton imported from ./connection — exactly the same
 * behavior as the original monolithic database.js.
 *
 * Rate-limit semantics:
 *   Only outcomes that represent a real successful platform action count
 *   against the daily cap. Premium walls, identity/metadata gates,
 *   not_connected, session_required, composer failures, etc. are recorded
 *   (or skipped) for audit but must NOT burn the budget — otherwise a run
 *   of 20 premium-required profiles would falsely report "daily limit
 *   reached" with zero DMs actually sent. This matches campaign dm_queue /
 *   connection_queue, which already filter `outcome = 'sent'`.
 */
"use strict";

const limits = require("../../config/limits");
const { db } = require("./connection");

/** Outcomes that consume daily rate-limit budget. */
const LIMIT_COUNTING_OUTCOMES = ["sent"];

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

/**
 * Whether this outcome should consume daily rate-limit budget.
 * Only real successful sends count — premium walls / failures do not.
 */
function outcomeCountsTowardLimit(outcome) {
  return LIMIT_COUNTING_OUTCOMES.includes(String(outcome || "").toLowerCase());
}

function getDailyActionCount(platform, actionType) {
  const normalizedActionType = normalizeActionType(actionType);
  // Only count successful actions. premium_required / failed / skipped / etc.
  // must not exhaust the daily budget (see file header).
  const placeholders = LIMIT_COUNTING_OUTCOMES.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM daily_actions
       WHERE platform = ?
         AND action_type = ?
         AND DATE(performed_at) = DATE('now', 'localtime')
         AND lower(coalesce(outcome, '')) IN (${placeholders})`,
    )
    .get(platform, normalizedActionType, ...LIMIT_COUNTING_OUTCOMES);

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

/**
 * Record a daily_actions row for rate-limit accounting.
 *
 * Callers may still invoke this for non-sent outcomes (legacy), but only
 * outcomes in LIMIT_COUNTING_OUTCOMES are inserted. Non-consuming outcomes
 * are tracked via touchpoints instead so they never inflate the daily cap.
 * Returns true if a row was inserted.
 */
function increment_action_count(
  platform,
  actionType,
  leadId = null,
  outcome = "sent",
  reason = null,
) {
  if (!outcomeCountsTowardLimit(outcome)) {
    return false;
  }
  const normalizedActionType = normalizeActionType(actionType);
  const insert = db.prepare(
    `INSERT INTO daily_actions (platform, action_type, lead_id, outcome, reason, performed_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  );
  insert.run(platform, normalizedActionType, leadId, outcome, reason);
  return true;
}

module.exports = {
  getDailyActionCount,
  getDailyLimits,
  isWithinLimit,
  normalizeActionType,
  increment_action_count,
  outcomeCountsTowardLimit,
  LIMIT_COUNTING_OUTCOMES,
};
