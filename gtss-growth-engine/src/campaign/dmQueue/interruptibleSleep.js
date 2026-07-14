/**
 * DM Queue — Interruptible Sleep
 * setTimeout-based sleep that resolves early if the global DM_QUEUE_STOPPED
 * flag flips to true. This lets the stop button on the automation page halt
 * the cron-triggered DM queue without waiting for the full cooldown (which
 * can be 30-60s) to elapse.
 *
 * Extracted from the original dmQueue.js for maintainability.
 */

const { isDmQueueStopped } = require("./stopFlag");

/**
 * Interruptible sleep. Resolves early if the global DM_QUEUE_STOPPED flag is
 * set, so the stop button on the automation page can halt the cron-triggered
 * queue without waiting for the full cooldown to elapse.
 *
 * Polls the stop flag every 500ms (stepMs).
 *
 * @param {number} ms - Milliseconds to sleep
 */
async function sleep(ms) {
  const stepMs = 500;
  let elapsed = 0;
  while (elapsed < ms) {
    if (isDmQueueStopped()) return;
    const waitMs = Math.min(stepMs, ms - elapsed);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    elapsed += waitMs;
  }
}

module.exports = {
  sleep,
};
