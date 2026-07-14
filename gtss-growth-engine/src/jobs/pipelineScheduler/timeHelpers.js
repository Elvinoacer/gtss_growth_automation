/**
 * pipelineScheduler/timeHelpers.js
 *
 * Time- and pause-related helpers used by the pipeline scheduler:
 *   - isPipelinePaused(id)    — read the `pipeline_<id>_paused` setting
 *                                from the DB and return true if it's "true"
 *   - getHourInTimezone(tz)   — get the current hour (0-23) in the given
 *                                IANA timezone (falls back to local hour on
 *                                invalid tz)
 *   - isWithinActiveHours(start, end, tz) — true if the current hour falls
 *                                in [start, end) (handles wrap-around windows
 *                                like 22→6 for "10pm to 6am")
 *
 * These helpers are used both by the runners (the dm_check runner checks
 * them before scanning) and by syncFromDb (which logs skips when a cron
 * tick fires but the pipeline is paused).
 *
 * The split files live one directory deeper than the original
 * pipelineScheduler.js, so the require path to ../db/database becomes
 * ../../db/database here.
 */

const { getDb } = require("../../db/database");

function isPipelinePaused(id) {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(`pipeline_${id}_paused`);
  return String(row?.value || 'false') === 'true';
}

function getHourInTimezone(timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(new Date());
    return Number(parts.find((part) => part.type === 'hour')?.value);
  } catch (_) {
    return new Date().getHours();
  }
}

function isWithinActiveHours(start = 0, end = 24, timezone = 'UTC') {
  const startHour = Math.max(0, Math.min(23, Number(start) || 0));
  const endHour = Math.max(1, Math.min(24, Number(end) || 24));
  const hour = getHourInTimezone(timezone);
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

module.exports = { isPipelinePaused, getHourInTimezone, isWithinActiveHours };
