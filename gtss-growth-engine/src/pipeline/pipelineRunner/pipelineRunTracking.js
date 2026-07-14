/**
 * pipelineRunner/pipelineRunTracking.js
 *
 * Low-level pipeline_runs DB row helpers + the per-stage retry wrapper.
 *
 * - createPipelineRun / updatePipelineRun / finalisePipelineRun wrap the
 *   pipeline_runs table INSERT/UPDATE/finish.
 * - isPaused reads the per-pipeline pause flag from the settings table.
 * - throwIfAborted is the abort-signal guard called at the start of every
 *   stage (throws if either the AbortSignal fired OR the in-memory abort flag
 *   was set).
 * - runStageWithRetry wraps a stage function with withRetry and emits retry
 *   events on the pipeline stream.
 */

const { getDb } = require("../../db/database");
const { stageMode } = require("../../config/pipelineConfig");
const { withRetry } = require("../../utils/retryHelper");
const logger = require("../../utils/logger");
const { isPipelineAborted } = require("./state");

/**
 * Create a new pipeline_runs record.
 * @param {string} triggerSource - 'cron' | 'manual' | 'api'
 * @returns {number} The pipeline run ID
 */
function createPipelineRun(triggerSource) {
  const db = getDb();
  const globalMode = stageMode("discovery"); // Just reads PIPELINE_MODE
  const result = db
    .prepare(
      `INSERT INTO pipeline_runs (trigger, mode, status, stages_json)
     VALUES (?, ?, 'running', '{}')`,
    )
    .run(triggerSource, globalMode);
  return result.lastInsertRowid;
}

/**
 * Update a pipeline run with per-stage results.
 */
function updatePipelineRun(runId, stageResults) {
  const db = getDb();
  const existing = db
    .prepare("SELECT stages_json FROM pipeline_runs WHERE id = ?")
    .get(runId);
  let stages = {};
  try {
    stages = JSON.parse(existing?.stages_json || "{}");
  } catch (_) {}

  Object.assign(stages, stageResults);

  db.prepare("UPDATE pipeline_runs SET stages_json = ? WHERE id = ?").run(
    JSON.stringify(stages),
    runId,
  );
}

/**
 * Finalise a pipeline run.
 */
function finalisePipelineRun(runId, status) {
  const db = getDb();
  db.prepare(
    "UPDATE pipeline_runs SET status = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run(status, runId);
}

/**
 * True if the per-pipeline pause flag is set in the settings table
 * (key = `pipeline_<pipelineId>_paused`).
 */
function isPaused(pipelineId) {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(`pipeline_${pipelineId}_paused`);
  return String(row?.value || "false") === "true";
}

/**
 * Throw "Pipeline run aborted" if either the AbortSignal fired OR the
 * in-memory abort flag was set for this runId (checked via the shared
 * state module so the lookup always sees the latest flag value).
 */
function throwIfAborted(signal, runId) {
  if (signal?.aborted || isPipelineAborted(runId)) throw new Error("Pipeline run aborted");
}

/**
 * Wrap a stage function with withRetry and emit retry events on the pipeline
 * stream. entityType is always 'pipeline' and entityId is the runId, so retry
 * telemetry is correlated with the pipeline run.
 */
async function runStageWithRetry(stage, jobType, runId, emit, fn, signal) {
  return withRetry(fn, {
    signal,
    entityType: "pipeline",
    entityId: runId,
    label: `${jobType}:${stage}`,
    onRetry: (attempt, err, retryInfo) => {
      emit({
        type: "retry",
        stage,
        attempt,
        message: `${stage} retry ${attempt}: ${err.message}`,
      });
      logger.db("retry", jobType, stage, `Retry ${attempt}: ${err.message}`, {
        jobId: runId,
        attempt,
        nextRetryAt: retryInfo.nextRetryAt,
      });
    },
  });
}

module.exports = {
  createPipelineRun,
  updatePipelineRun,
  finalisePipelineRun,
  isPaused,
  throwIfAborted,
  runStageWithRetry,
};
