/**
 * pauseResumeStop.js — User-initiated pause / resume / stop request handlers.
 *
 * These are the route-facing functions called when the user clicks the
 * Pause / Resume / Stop buttons in the pipelines UI. They coordinate between
 * the in-memory ABORT_FLAGS / PAUSE_FLAGS / ACTIVE_EXECUTIONS maps (in
 * shared.js) and the DB-level schedule & execution rows.
 *
 * Each function returns a structured result object the routes layer forwards
 * to the client. Notable subtleties preserved from the original monolith:
 *
 *   - requestPause / requestResume ALSO flip a schedule-level `pipeline_<id>_paused`
 *     settings row so the cron scheduler skips ticks while the user's pause
 *     intent is active (even if no execution is currently running).
 *
 *   - requestResume flips the in-memory PAUSE_FLAGS but does NOT transition to
 *     RUNNING — the runner's awaitResume() loop will call transitionExecution(RUNNING)
 *     itself. The previous code did a setTimeout(500ms) which raced the runner.
 *
 *   - requestStop, when there is no in-memory active execution but a stuck DB
 *     row exists (from a previous crash), sweeps that row to 'stopped' and
 *     clears the schedule-level pause flag — so Stop ALWAYS produces a visible
 *     state change instead of the old `{ stopped: 0 }` no-op.
 */
"use strict";

const { getDb } = require("../../db/database");
const pipelineLogger = require("../pipelineLogger");
const {
  STATES,
  ABORT_FLAGS,
  PAUSE_FLAGS,
  ACTIVE_EXECUTIONS,
  broadcastState,
} = require("./shared");
const { transitionExecution } = require("./executions");

function requestPause(pipelineId) {
  if (!pipelineId) return { ok: false, error: "pipelineId required" };
  const execId = ACTIVE_EXECUTIONS.get(pipelineId);
  if (!execId) {
    // Even if there is no active run, mark the schedule as paused so the
    // cron scheduler will skip the next tick.
    const db = getDb();
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, 'true')
       ON CONFLICT(key) DO UPDATE SET value = 'true'`,
    ).run(`pipeline_${pipelineId}_paused`);
    db.prepare(
      `UPDATE pipeline_schedules SET current_state = 'paused', last_status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(pipelineId);
    broadcastState(pipelineId, null, "paused");
    return { ok: true, paused: true, scheduleLevel: true };
  }
  PAUSE_FLAGS.set(String(execId), "paused");
  transitionExecution(execId, STATES.PAUSED);
  // Also flip the schedule-level paused flag so cron won't fire while paused
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, 'true')
     ON CONFLICT(key) DO UPDATE SET value = 'true'`,
  ).run(`pipeline_${pipelineId}_paused`);
  return { ok: true, paused: true, executionId: execId };
}

function requestResume(pipelineId) {
  if (!pipelineId) return { ok: false, error: "pipelineId required" };
  // Clear schedule-level paused flag
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, 'false')
     ON CONFLICT(key) DO UPDATE SET value = 'false'`,
  ).run(`pipeline_${pipelineId}_paused`);

  const execId = ACTIVE_EXECUTIONS.get(pipelineId);
  if (!execId) {
    // Nothing actually running — just unpause the schedule. Reset the
    // schedule-level state to 'idle' (or 'completed' / 'failed' if that
    // was the last terminal state) so the UI doesn't keep showing
    // "Paused" forever.
    db.prepare(
      `UPDATE pipeline_schedules
       SET current_state = 'idle',
           last_status = CASE
             WHEN last_status = 'paused' THEN 'idle'
             ELSE last_status
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(pipelineId);
    broadcastState(pipelineId, null, "idle");
    return { ok: true, resumed: true, scheduleLevel: true };
  }
  // Flip the in-memory pause flag so the runner's awaitResume() loop
  // breaks out and continues. We DO NOT transition to RUNNING here —
  // the runner will call transitionExecution(execId, RUNNING) itself
  // once awaitResume() returns. The previous code did a setTimeout to
  // flip it after 500ms, which raced with the runner's own transition
  // and could leave the execution stuck in 'resuming' if the runner
  // had already finished its current stage and called
  // markExecutionCompleted before the timer fired.
  PAUSE_FLAGS.set(String(execId), "running");
  try {
    transitionExecution(execId, STATES.RESUMING);
  } catch (_) {
    // If the transition fails (e.g., execution already completed), the
    // PAUSE_FLAGS flip above is still sufficient for any in-flight
    // awaitResume() loop.
  }
  return { ok: true, resumed: true, executionId: execId };
}

function requestStop(pipelineId) {
  if (!pipelineId) return { ok: false, error: "pipelineId required" };
  const execId = ACTIVE_EXECUTIONS.get(pipelineId);
  if (!execId) {
    // No in-memory active execution. But the DB may still hold a row in a
    // transient state (running/paused/resuming/stopping/retrying) — this
    // happens when the runner died without ever calling
    // markExecutionFailed/Completed, or after a server restart that hasn't
    // yet called recoverOnStartup. Previously, Stop returned
    // `{ stopped: 0 }` in this case, which made the user think Stop was
    // broken (the UI kept showing "Running" forever). Now we sweep the
    // stale row too, so Stop ALWAYS results in a visible state change
    // whenever there's anything to stop.
    const db = getDb();
    const stuck = db
      .prepare(
        `SELECT id, status FROM pipeline_executions
         WHERE pipeline_id = ?
           AND status IN ('running', 'paused', 'resuming', 'stopping', 'retrying')
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(String(pipelineId));
    if (!stuck) {
      return {
        ok: true,
        stopped: 0,
        message: "No active execution to stop.",
      };
    }
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE pipeline_executions
       SET status = 'stopped',
           state = 'stopped',
           finished_at = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(now, stuck.id);
    db.prepare(
      `UPDATE pipeline_schedules
       SET current_state = 'idle',
           current_execution_id = NULL,
           last_status = 'stopped',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(String(pipelineId));
    ABORT_FLAGS.delete(String(stuck.id));
    PAUSE_FLAGS.delete(String(stuck.id));
    // Also clear the schedule-level pause flag — the user explicitly asked
    // to Stop, which is a stronger intent than Pause. Leaving the pause
    // flag set here (the previous behaviour) caused a deadlock: the user
    // paused → runner died → user clicked Stop → schedule-level pause
    // stayed on → every subsequent Run returned 409 "Pipeline is paused"
    // and the only escape was Force Clear. Now Stop fully resets the
    // pipeline so the user can immediately re-Run.
    try {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, 'false')
         ON CONFLICT(key) DO UPDATE SET value = 'false'`,
      ).run(`pipeline_${pipelineId}_paused`);
    } catch (_) {}
    pipelineLogger.log({
      pipelineId,
      executionId: stuck.id,
      level: "warn",
      stage: "lifecycle",
      message: `Stop requested for stuck DB row (was ${stuck.status}, no in-memory runner). Marked as stopped.`,
      context: { previousStatus: stuck.status },
      source: "system",
    });
    broadcastState(pipelineId, stuck.id, "stopped", { stopped: true, sweptDb: true });
    return {
      ok: true,
      stopped: 1,
      executionId: stuck.id,
      sweptDb: true,
      message: `Stopped stuck execution ${stuck.id} (was ${stuck.status}).`,
    };
  }
  ABORT_FLAGS.set(String(execId), true);
  transitionExecution(execId, STATES.STOPPING);
  return { ok: true, stopped: 1, executionId: execId };
}

module.exports = {
  requestPause,
  requestResume,
  requestStop,
};
