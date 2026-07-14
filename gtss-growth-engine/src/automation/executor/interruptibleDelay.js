/**
 * Executor — Interruptible Delay
 *
 * interruptibleDelay(minMs, maxMs, jobId) sleeps for a random duration
 * between minMs and maxMs, but polls the per-job STOP_FLAG every 500ms so
 * the sleep returns early when the user clicks Stop.
 *
 * Extracted from the original automation/executor.js for maintainability.
 */

const { STOP_FLAGS } = require('./state');

async function interruptibleDelay(minMs, maxMs, jobId) {
  const targetMs = Math.floor(Math.random() * (maxMs - minMs) + minMs);
  const stepMs = 500;
  let elapsed = 0;
  while (elapsed < targetMs) {
    if (STOP_FLAGS.get(jobId)) return;
    const waitMs = Math.min(stepMs, targetMs - elapsed);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    elapsed += waitMs;
  }
}

module.exports = { interruptibleDelay };
