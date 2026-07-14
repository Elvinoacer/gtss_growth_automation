/**
 * Connection Queue — Interruptible Sleep
 *
 * setTimeout-based sleep that resolves early if the global
 * CONNECTION_QUEUE_STOPPED flag flips to true. This lets the stop button on
 * the automation page halt the cron-triggered connection queue without
 * waiting for the full cooldown (which can be 20-60s) to elapse.
 *
 * Mirrors the dmQueue/interruptibleSleep.js pattern from Task 6.
 *
 * Extracted from the original connectionQueue.js for maintainability.
 */

const { isConnectionQueueStopped } = require("./stopFlag");

/**
 * Interruptible sleep. Resolves early if the global CONNECTION_QUEUE_STOPPED
 * flag is set, so the stop button on the automation page can halt the
 * cron-triggered queue without waiting for the full cooldown to elapse.
 *
 * Polls the stop flag every 500ms (stepMs).
 *
 * @param {number} ms - Milliseconds to sleep
 */
async function sleep(ms) {
  const stepMs = 500;
  let elapsed = 0;
  while (elapsed < ms) {
    if (isConnectionQueueStopped()) return;
    const waitMs = Math.min(stepMs, ms - elapsed);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    elapsed += waitMs;
  }
}

module.exports = {
  sleep,
};
