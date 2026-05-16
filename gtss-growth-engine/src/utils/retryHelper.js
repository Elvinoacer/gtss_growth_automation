/**
 * Retry Helper — Exponential Backoff for Pipeline Send Stage
 *
 * Provides configurable retry delays for the pipeline's send stage.
 * The executor.js already handles its own retry logic; this module
 * is used by the pipeline orchestrator for explicit backoff scheduling.
 */

// Retry delays: 30 minutes, 2 hours, 6 hours
const RETRY_DELAYS_MS = [
  30 * 60 * 1000,       // 1st retry: 30 minutes
  2 * 60 * 60 * 1000,   // 2nd retry: 2 hours
  6 * 60 * 60 * 1000,   // 3rd retry (final): 6 hours
];

/**
 * Calculate the snooze_until timestamp for a given retry count.
 *
 * @param {number} retryCount - Current retry count (0-indexed: 0 = first retry)
 * @returns {string} ISO 8601 timestamp for when the message should be retried
 */
function getRetrySnoozeUntil(retryCount) {
  const idx = Math.min(retryCount, RETRY_DELAYS_MS.length - 1);
  const delayMs = RETRY_DELAYS_MS[idx];
  return new Date(Date.now() + delayMs).toISOString();
}

/**
 * Check if retries are exhausted.
 *
 * @param {number} retryCount - Current retry count
 * @returns {boolean} True if no more retries should be attempted
 */
function isRetriesExhausted(retryCount) {
  return retryCount >= RETRY_DELAYS_MS.length;
}

module.exports = {
  RETRY_DELAYS_MS,
  getRetrySnoozeUntil,
  isRetriesExhausted,
};
