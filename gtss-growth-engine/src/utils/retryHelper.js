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

const RETRY_DELAY_PRESETS = {
  aggressive: [1000, 3000, 10000, 30000, 60000],
  conservative: [5000, 15000, 60000, 120000, 300000],
  patient: [30000, 120000, 300000, 600000, 900000],
};

function delay(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        return reject(new Error("Operation aborted"));
      }
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("Operation aborted"));
        },
        { once: true },
      );
    }
  });
}

function getRetrySettings() {
  try {
    const { getDb } = require("../db/database");
    const rows = getDb()
      .prepare(
        "SELECT key, value FROM settings WHERE key IN ('retry_max_attempts', 'retry_delay_preset')",
      )
      .all();
    const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const maxAttempts = Math.max(1, Number(settings.retry_max_attempts) || 5);
    const delaysMs =
      RETRY_DELAY_PRESETS[settings.retry_delay_preset] ||
      RETRY_DELAY_PRESETS.conservative;
    return { maxAttempts, delaysMs };
  } catch (_) {
    return { maxAttempts: 5, delaysMs: RETRY_DELAY_PRESETS.conservative };
  }
}

async function withRetry(fn, opts = {}) {
  const settings = getRetrySettings();
  const maxAttempts = Math.max(1, Number(opts.maxAttempts || settings.maxAttempts));
  const delaysMs = Array.isArray(opts.delaysMs) ? opts.delaysMs : settings.delaysMs;
  const shouldRetry =
    typeof opts.shouldRetry === "function" ? opts.shouldRetry : () => true;
  const onRetry = typeof opts.onRetry === "function" ? opts.onRetry : null;
  const signal = opts.signal;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw new Error("Operation aborted");
    try {
      return await fn({ attempt, signal });
    } catch (error) {
      lastError = error;
      if (signal?.aborted || attempt >= maxAttempts || !shouldRetry(error)) {
        throw error;
      }

      const delayMs = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] || 0;
      const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
      if (onRetry) {
        await onRetry(attempt + 1, error, { delayMs, nextRetryAt });
      }

      try {
        const { logActivity } = require("../services/auditService");
        logActivity({
          activityType: "retry_attempt",
          entityType: opts.entityType || null,
          entityId: opts.entityId || null,
          platform: opts.platform || null,
          status: "retried",
          summary: `${opts.label || "Operation"} retry ${attempt + 1}/${maxAttempts}`,
          details: { error: error.message, delayMs, nextRetryAt },
        });
      } catch (_) {}

      await delay(delayMs, signal);
    }
  }

  throw lastError || new Error("Retry failed");
}

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
  RETRY_DELAY_PRESETS,
  getRetrySnoozeUntil,
  isRetriesExhausted,
  withRetry,
  getRetrySettings,
};
