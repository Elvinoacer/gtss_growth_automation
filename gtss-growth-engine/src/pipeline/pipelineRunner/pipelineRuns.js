/**
 * pipelineRunner/pipelineRuns.js
 *
 * Read-only helpers for the pipeline_runs table:
 *  - getPipelineRun(runId) — single run with stages_json parsed into .stages
 *  - listPipelineRuns(limit) — recent runs newest-first, same parsing
 */

const { getDb } = require("../../db/database");

/**
 * Get details for a specific pipeline run.
 *
 * Parses the run's stages_json column into a `.stages` field so callers
 * don't have to JSON.parse defensively themselves.
 */
function getPipelineRun(runId) {
  const db = getDb();
  const run = db.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(runId);
  if (!run) return null;

  try {
    run.stages = JSON.parse(run.stages_json || "{}");
  } catch (_) {
    run.stages = {};
  }
  return run;
}

/**
 * List recent pipeline runs newest-first.
 *
 * Same stages_json -> .stages parsing as getPipelineRun.
 */
function listPipelineRuns(limit = 20) {
  const db = getDb();
  return db
    .prepare("SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT ?")
    .all(limit)
    .map((run) => {
      try {
        run.stages = JSON.parse(run.stages_json || "{}");
      } catch (_) {
        run.stages = {};
      }
      return run;
    });
}

module.exports = { getPipelineRun, listPipelineRuns };
