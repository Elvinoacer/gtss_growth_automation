/**
 * DM Queue — Global Stop Flag
 * The DM queue has two runner paths:
 *   - Runner A: triggered from the automation page (executor.js)
 *   - Runner B: triggered by the campaign cron (processDmQueue)
 *
 * The executor's STOP_FLAGS only halts Runner A. This module-level flag lets
 * the automation page's stop button also halt Runner B: stopDmQueue() sets the
 * flag, and the in-flight processDmQueue loop polls isDmQueueStopped() between
 * profiles and inside the cooldown sleep.
 *
 * Extracted from the original dmQueue.js for maintainability.
 */

// Module-level mutable flag. Mutated only by stopDmQueue() / resetDmQueueStopFlag().
let DM_QUEUE_STOPPED = false;

/**
 * Halt the in-flight DM queue (if any). Called by the automation route's stop
 * endpoint. Idempotent — safe to call multiple times.
 */
function stopDmQueue() {
  DM_QUEUE_STOPPED = true;
}

/**
 * Reset the stop flag. Called at the START of each processDmQueue run so a
 * previous stop doesn't permanently disable future cron runs.
 */
function resetDmQueueStopFlag() {
  DM_QUEUE_STOPPED = false;
}

/**
 * Check whether the queue has been stopped.
 */
function isDmQueueStopped() {
  return DM_QUEUE_STOPPED;
}

module.exports = {
  DM_QUEUE_STOPPED,
  stopDmQueue,
  resetDmQueueStopFlag,
  isDmQueueStopped,
};
