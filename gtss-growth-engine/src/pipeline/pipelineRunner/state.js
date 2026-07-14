/**
 * pipelineRunner/state.js
 *
 * Module-level mutable state for the outreach pipeline runner: the abort/pause
 * flag Maps keyed by runId. The Maps are exported as live references so that
 * mutations (set/delete) performed by any split file (stateFlags.js,
 * runFullPipeline.js) propagate to every other reader. (Maps are objects, so
 * destructuring them snapshots only the Map reference, not its contents —
 * .get/.set/.delete always operate on the shared instance.)
 *
 * Also exposes the OUTREACH_STAGES constant list.
 */

const logger = require("../../utils/logger");

const OUTREACH_STAGES = ["discovery", "qualification", "messages", "send"];

// Maps keyed by String(runId) of pipeline runs currently in-flight.
// PIPELINE_ABORT_FLAGS: value === true once abortPipelineRun(runId) is called.
// PIPELINE_PAUSE_FLAGS: "running" | "paused" — flipped by pause/resumePipelineRun.
const PIPELINE_ABORT_FLAGS = new Map();
const PIPELINE_PAUSE_FLAGS = new Map();

/**
 * Mark a pipeline run as aborted. Also flips the pause flag back to "running"
 * so any awaitResume() polling loop exits promptly (rather than waiting on the
 * pause flag that will never flip back while the run is being aborted).
 */
function abortPipelineRun(runId) {
  PIPELINE_ABORT_FLAGS.set(String(runId), true);
  PIPELINE_PAUSE_FLAGS.set(String(runId), "running");
  logger.info("PIPELINE", `Abort requested for run #${runId}`);
}

/**
 * True iff abortPipelineRun(runId) was previously called for this run.
 */
function isPipelineAborted(runId) {
  return PIPELINE_ABORT_FLAGS.get(String(runId)) === true;
}

/**
 * Mark the run as paused. awaitResume() will block until resumePipelineRun()
 * flips the flag back to "running" (or abortPipelineRun() clears it).
 */
function pausePipelineRun(runId) {
  PIPELINE_PAUSE_FLAGS.set(String(runId), "paused");
  logger.info("PIPELINE", `Pause requested for run #${runId}`);
}

/**
 * Mark the run as resumed. awaitResume() returns and the orchestrator
 * continues with the next stage.
 */
function resumePipelineRun(runId) {
  PIPELINE_PAUSE_FLAGS.set(String(runId), "running");
  logger.info("PIPELINE", `Resume requested for run #${runId}`);
}

/**
 * Block until the run is no longer in the "paused" state.
 *
 * Returns false if the run was aborted while paused, true otherwise. Polls
 * every 3 s; emits a one-shot "Pipeline paused — waiting for resume…" info
 * event the first iteration it observes the pause, so the UI shows the user
 * that the pipeline is intentionally waiting (not stuck).
 */
async function awaitResume(runId, emit) {
  const key = String(runId);
  let announced = false;
  while (PIPELINE_PAUSE_FLAGS.get(key) === "paused") {
    if (isPipelineAborted(runId)) return false;
    if (!announced) {
      emit({ type: "info", message: "Pipeline paused — waiting for resume…" });
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return !isPipelineAborted(runId);
}

module.exports = {
  OUTREACH_STAGES,
  PIPELINE_ABORT_FLAGS,
  PIPELINE_PAUSE_FLAGS,
  abortPipelineRun,
  isPipelineAborted,
  pausePipelineRun,
  resumePipelineRun,
  awaitResume,
};
