/**
 * Executor — Limits Helper
 *
 * isWithinLimit(platform, actionType) is a thin wrapper over the database's
 * daily-limit check. Always fetches the fresh limit from config to ensure we
 * don't exceed even if settings change mid-run.
 *
 * Extracted from the original automation/executor.js for maintainability.
 */

const { isWithinLimit: dbIsWithinLimit } = require('../../db/database');

/**
 * Robust check for daily limits.
 */
function isWithinLimit(platform, actionType) {
  // Always fetch fresh limit from config to ensure we don't exceed even if settings change
  return dbIsWithinLimit(platform, actionType);
}

module.exports = { isWithinLimit };
