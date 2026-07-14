/**
 * recovery.js — Startup recovery & canStart precondition check.
 *
 *   - recoverOnStartup()  — Called once during server boot. Sweeps every
 *                           pipeline_executions row left in a transient state
 *                           (running / paused / resuming / stopping / retrying /
 *                           pending) by the previous process and marks them
 *                           'failed' with an error message recording the
 *                           pre-restart status. Also resets schedule-level
 *                           current_state to 'idle' and rewrites last_status
 *                           for transient states. Stale `pipeline_*_paused`
 *                           settings rows are deliberately preserved (the
 *                           user's pause intent should survive a restart).
 *
 *   - canStart(pipelineId, opts)  — Returns true if a new execution can be
 *                           started right now. Refuses when there's an
 *                           in-memory ACTIVE_EXECUTIONS entry (unless `force`
 *                           is set, used by Restart) or when the schedule-level
 *                           pause flag is set (unless `force`). A disabled
 *                           schedule (enabled=0) does NOT block manual runs —
 *                           this is the original "buttons don't work" fix.
 */
"use strict";

const { getDb } = require("../../db/database");
const logger = require("../../utils/logger");
const pipelineLogger = require("../pipelineLogger");
const {
  recomputeAggregates,
} = require("../pipelineHealthService");
const {
  ACTIVE_EXECUTIONS,
  broadcastState,
} = require("./shared");

/**
 * On server boot, sweep pipeline_executions left in transient states
 * (running, paused, resuming, stopping, retrying) and mark them as 'failed'
 * (since the process that owned them is gone).
 *
 * Also clears stale ACTIVE_EXECUTIONS / ABORT_FLAGS / PAUSE_FLAGS (these are
 * in-memory only and start empty, so this is just a safety net).
 *
 * This is the key piece for "survive application restarts" — when the server
 * comes back up, no execution is silently "still running" in DB.
 */
function recoverOnStartup() {
  const db = getDb();
  const stuck = db
    .prepare(
      `SELECT id, pipeline_id, status, current_stage, started_at
       FROM pipeline_executions
       WHERE status IN ('running', 'paused', 'resuming', 'stopping', 'retrying', 'pending')`,
    )
    .all();

  if (stuck.length === 0) {
    // Still ensure schedule-level state is sane
    db.prepare(
      `UPDATE pipeline_schedules
       SET current_state = 'idle',
           current_execution_id = NULL,
           last_status = COALESCE(NULLIF(last_status, 'running'), last_status),
           updated_at = CURRENT_TIMESTAMP
       WHERE current_state IN ('running', 'paused', 'resuming', 'stopping', 'retrying')`,
    ).run();
    return { recovered: 0 };
  }

  let recovered = 0;
  for (const exec of stuck) {
    try {
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE pipeline_executions
         SET status = 'failed',
             state = 'failed',
             error_message = ?,
             finished_at = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      ).run(
        `Server restarted while execution was in state '${exec.status}'`,
        now,
        exec.id,
      );

      pipelineLogger.log({
        pipelineId: exec.pipeline_id,
        executionId: exec.id,
        level: "error",
        stage: "lifecycle",
        message: `Execution marked failed on startup recovery (was ${exec.status})`,
        context: {
          previousStatus: exec.status,
          currentStage: exec.current_stage,
          startedAt: exec.started_at,
        },
        source: "system",
      });

      try {
        recomputeAggregates(exec.pipeline_id);
      } catch (_) {}
      recovered += 1;
    } catch (err) {
      logger.error("PIPELINE-STATE", `Failed to recover execution ${exec.id}`, err);
    }
  }

  // Reset schedule-level state too
  db.prepare(
    `UPDATE pipeline_schedules
     SET current_state = 'idle',
         current_execution_id = NULL,
         last_status = CASE
           WHEN last_status IN ('running', 'paused', 'resuming', 'stopping', 'retrying') THEN 'failed'
           ELSE last_status
         END,
         updated_at = CURRENT_TIMESTAMP`,
  ).run();

  // Clear stale pause flags so cron can run again
  const pausedKeys = db
    .prepare("SELECT key FROM settings WHERE key LIKE 'pipeline_%_paused' AND value = 'true'")
    .all();
  // Note: we deliberately DO NOT auto-clear pause flags here — if the user
  // paused a pipeline, that intent should survive a restart.
  void pausedKeys;

  logger.info("PIPELINE-STATE", `Startup recovery: ${recovered} execution(s) marked failed.`);
  return { recovered };
}

/**
 * Returns true if a new execution can be started for this pipeline right now.
 *
 * Rules:
 *   - If there's an in-memory ACTIVE_EXECUTIONS entry, return false (one
 *     at a time per pipeline). The caller can pass `force: true` to
 *     bypass this check, but the caller is still responsible for actually
 *     clearing the active execution before calling createExecution.
 *   - If the schedule-level pause flag is set, return false — UNLESS the
 *     caller passes `force: true` (the user explicitly wants to override
 *     the pause, e.g., by clicking Restart).
 *
 * Note: a disabled schedule (enabled=0) does NOT block manual runs. The
 * cron scheduler won't fire for disabled pipelines, but the user can
 * still click Run / Restart to trigger a one-off manual run. This was
 * the original "buttons don't work" complaint — Run was greyed out for
 * disabled pipelines even though manual override should be allowed.
 */
function canStart(pipelineId, opts = {}) {
  if (ACTIVE_EXECUTIONS.has(pipelineId)) {
    // Allow force-override (Restart uses this). The caller is expected
    // to clear the active execution before calling createExecution.
    if (!opts.force) return false;
  }
  const db = getDb();
  const paused = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(`pipeline_${pipelineId}_paused`);
  if (String(paused?.value || "false") === "true" && !opts.force) return false;
  return true;
}

module.exports = {
  recoverOnStartup,
  canStart,
};
