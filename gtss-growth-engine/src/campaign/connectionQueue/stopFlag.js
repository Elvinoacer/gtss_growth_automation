/**
 * Connection Queue — Global Stop Flag
 *
 * The connection queue has two runner paths:
 *   - Runner A: triggered from the automation page (executor.js)
 *   - Runner B: triggered by the campaign cron (processConnectionQueue)
 *
 * The executor's STOP_FLAGS only halts Runner A. This module-level flag lets
 * the automation page's stop button also halt Runner B: stopConnectionQueue()
 * sets the flag, and the in-flight processConnectionQueue loop polls
 * isConnectionQueueStopped() between jobs and inside the cooldown sleep.
 *
 * Mirrors the dmQueue/stopFlag.js pattern from Task 6.
 *
 * Extracted from the original connectionQueue.js for maintainability.
 */

// Module-level mutable flag. Mutated only by stopConnectionQueue() /
// resetConnectionQueueStopFlag(). Reads from other files MUST go through
// isConnectionQueueStopped() — destructuring this `let` in another module
// would snapshot the value at require time and miss subsequent flips.
let CONNECTION_QUEUE_STOPPED = false;

/**
 * Halt the in-flight connection queue (if any). Called by the automation
 * route's stop endpoint. Idempotent — safe to call multiple times.
 */
function stopConnectionQueue() {
  CONNECTION_QUEUE_STOPPED = true;
}

/**
 * Reset the stop flag. Called at the START of each processConnectionQueue
 * run so a previous stop doesn't permanently disable future cron runs.
 */
function resetConnectionQueueStopFlag() {
  CONNECTION_QUEUE_STOPPED = false;
}

/**
 * Check whether the queue has been stopped.
 */
function isConnectionQueueStopped() {
  return CONNECTION_QUEUE_STOPPED;
}

module.exports = {
  CONNECTION_QUEUE_STOPPED,
  stopConnectionQueue,
  resetConnectionQueueStopFlag,
  isConnectionQueueStopped,
};
