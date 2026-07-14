/**
 * abortFlags.js — In-memory abort / pause flag checks & awaitResume loop.
 *
 * These are the cooperative-cancellation primitives that runners call inside
 * their long-running loops to honor a user's Stop / Pause request:
 *
 *   - isPaused(executionId)      — true if the user has paused (PAUSE_FLAGS = 'paused')
 *   - isAborted(executionId)     — true if the user has stopped (ABORT_FLAGS = true)
 *   - throwIfAborted(executionId) — throws an ABORTED error if isAborted is true
 *                                    (used as a guard at the top of each stage loop)
 *   - awaitResume(executionId, emitFn) — async loop that polls PAUSE_FLAGS every
 *                                    1.5s until either the user resumes (returns
 *                                    true) or aborts (returns false). Emits a
 *                                    one-shot "Pipeline paused — waiting for
 *                                    resume…" info message via emitFn.
 *
 * All four read directly from the shared ABORT_FLAGS / PAUSE_FLAGS maps
 * (in shared.js) so mutations made by pauseResumeStop.js / forceClearExecution.js
 * / __setActive (in index.js) are immediately observable.
 */
"use strict";

const { ABORT_FLAGS, PAUSE_FLAGS } = require("./shared");

function isPaused(executionId) {
  return PAUSE_FLAGS.get(String(executionId)) === "paused";
}

function isAborted(executionId) {
  return ABORT_FLAGS.get(String(executionId)) === true;
}

function throwIfAborted(executionId) {
  if (isAborted(executionId)) {
    const err = new Error("Pipeline execution aborted");
    err.code = "ABORTED";
    throw err;
  }
}

/**
 * Block until the user resumes the execution. Returns false if aborted.
 */
async function awaitResume(executionId, emitFn = null) {
  const key = String(executionId);
  let announced = false;
  while (PAUSE_FLAGS.get(key) === "paused") {
    if (isAborted(executionId)) return false;
    if (!announced && typeof emitFn === "function") {
      try {
        emitFn({ type: "info", message: "Pipeline paused — waiting for resume…" });
      } catch (_) {}
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return !isAborted(executionId);
}

module.exports = {
  isPaused,
  isAborted,
  throwIfAborted,
  awaitResume,
};
