/**
 * Executor — Module-Level Runtime State
 *
 * Owns the executor's mutable runtime state:
 *   - STOP_FLAGS        : Map<jobId, boolean> — per-job abort flags
 *   - runtimeState      : { ACTIVE_JOB_ID, RUN_QUEUE } — held in an object so
 *                         reassignment from other files propagates (a bare
 *                         `let` export is a snapshot and wouldn't propagate).
 *   - MAX_AUTO_RETRIES  : constant cap for failed-action retries
 *
 * Also exports stopJob / stopAllJobs which mutate STOP_FLAGS.
 *
 * Extracted from the original automation/executor.js for maintainability.
 */

const STOP_FLAGS = new Map();
const MAX_AUTO_RETRIES = 3;

// Holder object: reassignments to ACTIVE_JOB_ID / RUN_QUEUE from other
// files (processActionQueue, enqueueActionQueue) must propagate, so we
// mutate properties on this shared object instead of reassigning a
// destructured `let` binding. (See worklog note in dmQueue/stopFlag.js
// for the same pattern.)
const runtimeState = {
  ACTIVE_JOB_ID: null,
  RUN_QUEUE: Promise.resolve(),
};

function stopJob(jobId) {
  if (STOP_FLAGS.has(jobId)) {
    STOP_FLAGS.set(jobId, true);
    return true;
  }
  return false;
}

function stopAllJobs() {
  for (const jobId of STOP_FLAGS.keys()) {
    STOP_FLAGS.set(jobId, true);
  }
}

module.exports = {
  STOP_FLAGS,
  runtimeState,
  MAX_AUTO_RETRIES,
  stopJob,
  stopAllJobs,
};
