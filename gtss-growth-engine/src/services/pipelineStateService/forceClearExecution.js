/**
 * forceClearExecution.js — Force-clear a stuck pipeline execution.
 *
 * Use case: when a runner dies without ever calling markExecutionFailed /
 * markExecutionCompleted (e.g., an unhandled rejection inside a long browser
 * automation step, an OOM kill, or a sync crash), the execution row stays
 * "running" in DB and ACTIVE_EXECUTIONS keeps the pipeline locked forever.
 *
 * This function:
 *   1. Aborts any registered jobRegistry jobs for this pipeline so that
 *      in-flight browser/network operations receive an AbortSignal.
 *   2. Transitions the active execution row to 'failed' with a clear
 *      error_message recording that it was force-cleared.
 *   3. Clears ACTIVE_EXECUTIONS / ABORT_FLAGS / PAUSE_FLAGS for the pipeline.
 *   4. Resets the schedule-level current_state to 'idle' so the UI stops
 *      showing the pipeline as "running".
 *   5. Clears the schedule-level pause flag so the user can immediately
 *      re-run the pipeline. (Previously, a paused-then-stuck pipeline
 *      would refuse all subsequent Run/Restart calls with "Pipeline is
 *      paused" — even after force-clear. Now force-clear always leaves
 *      the pipeline in a fully usable state.)
 *
 * After this returns, the user can immediately trigger a fresh Run / Retry /
 * Resume without having to restart the server.
 *
 * Returns: { ok, cleared, executionId, previousStatus, jobsKilled } or
 *          { ok: true, cleared: 0, message: 'No active execution to clear.' }
 */
"use strict";

const { getDb } = require("../../db/database");
const pipelineLogger = require("../pipelineLogger");
const {
  recomputeAggregates,
} = require("../pipelineHealthService");
const {
  ABORT_FLAGS,
  PAUSE_FLAGS,
  ACTIVE_EXECUTIONS,
  broadcastState,
} = require("./shared");
const { getExecutionState } = require("./executions");

function forceClearExecution(pipelineId, reason = "manual", opts = {}) {
  if (!pipelineId) return { ok: false, error: "pipelineId required" };

  // By default we clear the schedule-level pause flag (so the user can
  // immediately re-Run). But if the caller passes `keepPauseIntent: true`,
  // we preserve the pause flag — this is used by the Stop endpoint, where
  // the user's intent is "stop the current run" not "unpause the
  // schedule".
  const keepPauseIntent = Boolean(opts.keepPauseIntent);

  // ── Step 1: Abort the in-memory runner first ──────────────────────────
  //
  // Set the ABORT_FLAG for the active execution BEFORE killing the
  // jobRegistry jobs. This way, any runner that's mid-stage and
  // cooperatively checking throwIfAborted() will throw on its next
  // check, which propagates up the call stack and exits the runner
  // cleanly. The jobRegistry aborts are the sledgehammer for runners
  // that DON'T check cooperatively (e.g., a runner stuck inside a
  // browser.waitForSelector call).
  const activeExecId = ACTIVE_EXECUTIONS.get(pipelineId);
  if (activeExecId) {
    ABORT_FLAGS.set(String(activeExecId), true);
  }

  // Kill any registered job-registry jobs for this pipeline so that any
  // in-flight AbortController-listening operations actually receive the
  // abort signal. This is the missing "kill switch" that was causing the
  // user's "stop doesn't actually stop" complaint.
  let jobsKilled = 0;
  try {
    const jobRegistry = require("../../jobs/jobRegistry");
    jobsKilled = jobRegistry.stopJobsByPipeline(pipelineId);
  } catch (_) {}

  // Clear the schedule-level pause flag (unless the caller asked us to
  // preserve it). The previous behavior left the paused flag set if the
  // user had paused before the runner got stuck, which made every
  // subsequent Run / Restart fail with 409 "Pipeline is paused" — the
  // exact "buttons don't work" frustration the user reported.
  const db = getDb();
  if (!keepPauseIntent) {
    try {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, 'false')
         ON CONFLICT(key) DO UPDATE SET value = 'false'`,
      ).run(`pipeline_${pipelineId}_paused`);
    } catch (_) {}
  }

  // ── Step 2: Release any DB-level locks the pipeline may hold ──────────
  //
  // The content pipeline uses a `content_pipeline_lock` setting row to
  // prevent overlapping runs. When a runner dies without releasing the
  // lock, every subsequent content Run returns "Already running". We
  // release it here so force-clear actually frees the pipeline.
  try {
    if (pipelineId === "content") {
      db.prepare(
        `UPDATE settings SET value = 'false' WHERE key = 'content_pipeline_lock'`,
      ).run();
    }
  } catch (_) {}

  const execId = activeExecId;
  if (!execId) {
    // Even if the in-memory map is empty, the DB might still hold a row
    // marked 'running' (e.g., from a previous server restart that didn't
    // run recoverOnStartup, or a crash mid-recovery). Sweep ALL stuck rows
    // for this pipeline — not just the latest — so the user isn't chasing
    // a ghost execution through multiple clicks.
    const stuckRows = db
      .prepare(
        `SELECT id, status, started_at FROM pipeline_executions
         WHERE pipeline_id = ?
           AND status IN ('running', 'paused', 'resuming', 'stopping', 'retrying')
         ORDER BY started_at DESC`,
      )
      .all(String(pipelineId));

    if (stuckRows.length === 0) {
      // Just ensure the schedule-level state is sane.
      db.prepare(
        `UPDATE pipeline_schedules
         SET current_state = 'idle',
             current_execution_id = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      ).run(String(pipelineId));
      return {
        ok: true,
        cleared: 0,
        jobsKilled,
        message: "Pipeline state has been reset to idle. No stuck execution found.",
      };
    }

    const now = new Date().toISOString();
    // Mark ALL stuck rows as failed (so the history is accurate), not just
    // the most recent one. The user shouldn't have to click Force Clear
    // multiple times to clean up several ghost executions.
    for (const stuck of stuckRows) {
      db.prepare(
        `UPDATE pipeline_executions
         SET status = 'failed',
             state = 'failed',
             error_message = ?,
             finished_at = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      ).run(
        `Force-cleared by user (reason: ${reason}). Previous state: '${stuck.status}'. The runner process is no longer making progress.`,
        now,
        stuck.id,
      );

      pipelineLogger.log({
        pipelineId,
        executionId: stuck.id,
        level: "warn",
        stage: "lifecycle",
        message: `Execution force-cleared by user (was ${stuck.status}, reason: ${reason}).`,
        context: { previousStatus: stuck.status, reason, startedAt: stuck.started_at },
        source: "system",
      });
    }

    db.prepare(
      `UPDATE pipeline_schedules
       SET current_state = 'idle',
           current_execution_id = NULL,
           last_status = 'failed',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(String(pipelineId));

    try { recomputeAggregates(pipelineId); } catch (_) {}

    const latest = stuckRows[0];
    broadcastState(pipelineId, latest.id, "failed", {
      forced: true,
      reason,
      previousStatus: latest.status,
      jobsKilled,
      clearedCount: stuckRows.length,
    });
    return {
      ok: true,
      cleared: stuckRows.length,
      executionId: latest.id,
      previousStatus: latest.status,
      jobsKilled,
    };
  }

  // We have an in-memory active execution — record its previous status
  // before transitioning.
  const execRow = getExecutionState(execId);
  const previousStatus = execRow?.status || "running";
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
    `Force-cleared by user (reason: ${reason}). Previous state: '${previousStatus}'. The runner process is no longer making progress.`,
    now,
    String(execId),
  );

  // Clear in-memory state FIRST so any concurrent runner that tries to
  // updateExecutionProgress() finds nothing to update.
  ACTIVE_EXECUTIONS.delete(pipelineId);
  ABORT_FLAGS.delete(String(execId));
  PAUSE_FLAGS.delete(String(execId));

  // Reset schedule-level state to idle so the UI flips back to "stopped".
  db.prepare(
    `UPDATE pipeline_schedules
     SET current_state = 'idle',
         current_execution_id = NULL,
         last_status = 'failed',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(String(pipelineId));

  pipelineLogger.log({
    pipelineId,
    executionId: execId,
    level: "warn",
    stage: "lifecycle",
    message: `Execution force-cleared by user (was ${previousStatus}, reason: ${reason}).`,
    context: { previousStatus, reason, startedAt: execRow?.started_at || null, jobsKilled },
    source: "system",
  });

  try { recomputeAggregates(pipelineId); } catch (_) {}

  broadcastState(pipelineId, execId, "failed", {
    forced: true,
    reason,
    previousStatus,
    jobsKilled,
  });

  return { ok: true, cleared: 1, executionId: execId, previousStatus, jobsKilled };
}

module.exports = {
  forceClearExecution,
};
