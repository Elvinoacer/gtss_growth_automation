/**
 * executions.js — Pipeline execution lifecycle (create / transition / progress / mark).
 *
 * Owns the row-level operations on the `pipeline_executions` table:
 *   - createExecution          — INSERT a new row, set the ACTIVE_EXECUTIONS lock,
 *                                 broadcast the 'running' state
 *   - transitionExecution      — state-machine transition with side effects per
 *                                 target state (timestamps, ABORT/PAUSE flags,
 *                                 schedule-level current_state update, duration
 *                                 computation, aggregate recompute on terminal)
 *   - updateExecutionProgress  — partial UPDATE on stage / message / progress /
 *                                 completed_steps / total_steps / failed_stage,
 *                                 plus a lightweight progress socket broadcast
 *   - markExecutionFailed      — guards against overwriting a 'stopped' row with
 *                                 'failed' (the user's Stop intent wins)
 *   - markExecutionCompleted   — thin wrapper over transitionExecution(COMPLETED)
 *   - getActiveExecution       — returns the active execution row for a pipeline
 *                                 (or null if none / cleaned up if row vanished)
 *   - getExecutionState        — returns the lightweight state row for an execution
 *   - isExecutionProgressing   — heuristic: is the active execution genuinely
 *                                 making progress (DB row touched within staleMs)?
 *   - hasStuckDbRow            — does the pipeline have ANY DB row in a transient
 *                                 state (used to detect stuck pipelines)?
 *
 * Mutates the shared ABORT_FLAGS / PAUSE_FLAGS / ACTIVE_EXECUTIONS maps from
 * shared.js so other split files (pauseResumeStop, forceClear, abortFlags,
 * recovery) observe the same state.
 */
"use strict";

const { getDb } = require("../../db/database");
const pipelineLogger = require("../pipelineLogger");
const {
  recomputeAggregates,
} = require("../pipelineHealthService");
const {
  STATES,
  VALID_STATES,
  ABORT_FLAGS,
  PAUSE_FLAGS,
  ACTIVE_EXECUTIONS,
  uuid,
  safeJson,
  broadcastState,
} = require("./shared");

/**
 * Create a new pipeline_executions row and return it.
 * Throws if there is already an active execution for this pipeline.
 */
function createExecution(pipelineId, trigger = "manual", options = {}) {
  if (!pipelineId) throw new Error("pipelineId is required");
  const db = getDb();

  if (ACTIVE_EXECUTIONS.has(pipelineId)) {
    const activeId = ACTIVE_EXECUTIONS.get(pipelineId);
    const err = new Error(
      `Pipeline "${pipelineId}" is already running (execution ${activeId}). Stop or wait for it to finish.`,
    );
    err.code = "ALREADY_RUNNING";
    throw err;
  }

  const id = options.executionId || uuid();
  const metadata = {
    limits: options.limits || null,
    keywords: options.keywords || null,
    platforms: options.platforms || null,
    topic: options.topic || null,
    resumeFrom: options.resumeFrom || null,
  };

  db.prepare(
    `INSERT INTO pipeline_executions
      (id, pipeline_id, trigger, status, state, current_stage, current_message,
       progress, total_steps, completed_steps, max_retries, metadata_json, started_at)
     VALUES (?, ?, ?, 'running', 'running', ?, ?, 0, ?, 0, ?, ?, CURRENT_TIMESTAMP)`,
  ).run(
    id,
    pipelineId,
    trigger,
    options.startStage || null,
    options.startMessage || "Initializing…",
    options.totalSteps || 0,
    options.maxRetries || 3,
    safeJson(metadata),
  );

  ACTIVE_EXECUTIONS.set(pipelineId, id);
  ABORT_FLAGS.delete(id);
  PAUSE_FLAGS.set(id, "running");

  // Update pipeline_schedules to reflect the active execution
  db.prepare(
    `UPDATE pipeline_schedules
     SET current_state = 'running',
         current_execution_id = ?,
         last_status = 'running',
         last_run_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(id, pipelineId);

  pipelineLogger.log({
    pipelineId,
    executionId: id,
    level: "info",
    stage: "lifecycle",
    message: `Execution started (trigger: ${trigger})`,
    context: metadata,
    source: "system",
  });

  broadcastState(pipelineId, id, "running", {
    current_stage: options.startStage || null,
    current_message: options.startMessage || "Initializing…",
    progress: 0,
    trigger,
  });

  return { id, pipeline_id: pipelineId, trigger };
}

/**
 * Validate and apply a state transition for an execution.
 *
 * Allowed transitions are conservative: we do not allow e.g. "completed → running".
 */
function transitionExecution(executionId, newState, opts = {}) {
  if (!executionId) return false;
  const db = getDb();
  const exec = db
    .prepare(
      "SELECT id, pipeline_id, status FROM pipeline_executions WHERE id = ?",
    )
    .get(String(executionId));
  if (!exec) return false;

  const fromState = exec.status;
  const toState = String(newState || "").toLowerCase();
  if (!VALID_STATES.has(toState)) {
    throw new Error(`Invalid target state: ${newState}`);
  }

  // Apply side effects for special transitions
  const now = new Date().toISOString();
  const updates = [];
  const params = [];

  updates.push("status = ?");
  updates.push("state = ?");
  params.push(toState, toState);

  if (toState === STATES.PAUSED) {
    updates.push("paused_at = ?");
    params.push(now);
    PAUSE_FLAGS.set(String(executionId), "paused");
  } else if (toState === STATES.RESUMING) {
    updates.push("resumed_at = ?");
    params.push(now);
    PAUSE_FLAGS.set(String(executionId), "running");
  } else if (toState === STATES.STOPPING) {
    updates.push("stopped_at = ?");
    params.push(now);
    ABORT_FLAGS.set(String(executionId), true);
  } else if (toState === STATES.STOPPED) {
    updates.push("stopped_at = ?");
    params.push(now);
    updates.push("finished_at = ?");
    params.push(now);
    ABORT_FLAGS.set(String(executionId), true);
  } else if (toState === STATES.COMPLETED) {
    updates.push("finished_at = ?");
    params.push(now);
  } else if (toState === STATES.FAILED) {
    updates.push("finished_at = ?");
    params.push(now);
    if (opts.errorMessage) {
      updates.push("error_message = ?");
      params.push(String(opts.errorMessage).slice(0, 4000));
    }
    if (opts.stackTrace) {
      updates.push("stack_trace = ?");
      params.push(String(opts.stackTrace).slice(0, 16000));
    }
    if (opts.failedStage) {
      updates.push("failed_stage = ?");
      params.push(String(opts.failedStage));
    }
  } else if (toState === STATES.RETRYING) {
    if (opts.retryCount !== undefined) {
      updates.push("retry_count = ?");
      params.push(Number(opts.retryCount));
    }
  }

  // Update schedule-level current_state too (for UI)
  const scheduleState = toState === STATES.STOPPED ? "stopped" : toState;
  db.prepare(
    `UPDATE pipeline_schedules
     SET current_state = ?, last_status = COALESCE(?, last_status), updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(scheduleState, toState === STATES.RUNNING ? "running" : null, exec.pipeline_id);

  params.push(String(executionId));
  db.prepare(
    `UPDATE pipeline_executions SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).run(...params);

  pipelineLogger.log({
    pipelineId: exec.pipeline_id,
    executionId,
    level: toState === STATES.FAILED ? "error" : toState === STATES.COMPLETED ? "success" : "info",
    stage: "lifecycle",
    message: `State transition: ${fromState} → ${toState}${opts.errorMessage ? ` — ${opts.errorMessage}` : ""}`,
    context: {
      from: fromState,
      to: toState,
      failedStage: opts.failedStage || null,
      retryCount: opts.retryCount || null,
    },
    source: "system",
  });

  // If terminal, clear the active-execution lock and recompute aggregates
  const terminal = [STATES.COMPLETED, STATES.FAILED, STATES.STOPPED].includes(toState);
  if (terminal) {
    if (ACTIVE_EXECUTIONS.get(exec.pipeline_id) === executionId) {
      ACTIVE_EXECUTIONS.delete(exec.pipeline_id);
    }
    ABORT_FLAGS.delete(executionId);
    PAUSE_FLAGS.delete(executionId);

    // Compute duration
    try {
      const execRow = db
        .prepare("SELECT started_at, finished_at FROM pipeline_executions WHERE id = ?")
        .get(String(executionId));
      const start = execRow?.started_at ? new Date(execRow.started_at).getTime() : null;
      const end = execRow?.finished_at ? new Date(execRow.finished_at).getTime() : null;
      if (start && end) {
        db.prepare("UPDATE pipeline_executions SET duration_ms = ? WHERE id = ?")
          .run(Math.max(0, end - start), String(executionId));
      }
    } catch (_) {}

    // Update schedule's last_status & run_count
    db.prepare(
      `UPDATE pipeline_schedules
       SET last_status = ?,
           last_run_at = CURRENT_TIMESTAMP,
           run_count = run_count + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(toState, exec.pipeline_id);

    try {
      recomputeAggregates(exec.pipeline_id);
    } catch (_) {}
  }

  broadcastState(exec.pipeline_id, executionId, toState, opts);
  return true;
}

/**
 * Update progress fields on an execution (called by runners as they work).
 */
function updateExecutionProgress(executionId, update = {}) {
  if (!executionId) return false;
  const db = getDb();

  const sets = [];
  const params = [];

  if (update.stage !== undefined) {
    sets.push("current_stage = ?");
    params.push(update.stage);
  }
  if (update.message !== undefined) {
    sets.push("current_message = ?");
    params.push(String(update.message).slice(0, 1000));
  }
  if (update.progress !== undefined) {
    const progress = Math.max(0, Math.min(100, Number(update.progress) || 0));
    sets.push("progress = ?");
    params.push(progress);
  }
  if (update.completedSteps !== undefined) {
    sets.push("completed_steps = ?");
    params.push(Math.max(0, Number(update.completedSteps) || 0));
  }
  if (update.totalSteps !== undefined) {
    sets.push("total_steps = ?");
    params.push(Math.max(0, Number(update.totalSteps) || 0));
  }
  if (update.failedStage !== undefined) {
    sets.push("failed_stage = ?");
    params.push(update.failedStage);
  }

  if (sets.length === 0) return false;

  sets.push("updated_at = CURRENT_TIMESTAMP");
  params.push(String(executionId));

  db.prepare(`UPDATE pipeline_executions SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  // Broadcast a lightweight progress event (best-effort)
  try {
    const row = db
      .prepare(
        "SELECT pipeline_id, current_stage, current_message, progress, completed_steps, total_steps FROM pipeline_executions WHERE id = ?",
      )
      .get(String(executionId));
    if (row) {
      const { broadcast } = require("../socketService");
      broadcast("pipeline:progress", {
        pipeline_id: row.pipeline_id,
        execution_id: executionId,
        stage: row.current_stage,
        message: row.current_message,
        progress: row.progress,
        completed_steps: row.completed_steps,
        total_steps: row.total_steps,
      });
    }
  } catch (_) {}

  return true;
}

function markExecutionFailed(executionId, error, failedStage = null) {
  // If the execution is already in a terminal "stopped" state (because the
  // user clicked Stop and the abort propagated up the call stack as a
  // thrown error), do NOT overwrite it with "failed". The previous
  // behaviour was inconsistent: Stop set last_status='stopped' at the
  // schedule level, but the execution row got flipped to 'failed' by the
  // runner's catch block, leaving the UI showing two different states.
  // Now: once stopped, stay stopped.
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT status FROM pipeline_executions WHERE id = ?")
      .get(String(executionId));
    if (row && (row.status === STATES.STOPPED || row.status === STATES.STOPPING)) {
      return false;
    }
  } catch (_) { /* fall through to normal path */ }

  const err = error instanceof Error ? error : new Error(String(error || "Unknown error"));
  return transitionExecution(executionId, STATES.FAILED, {
    errorMessage: err.message,
    stackTrace: err.stack,
    failedStage,
  });
}

function markExecutionCompleted(executionId) {
  return transitionExecution(executionId, STATES.COMPLETED);
}

/**
 * Get the active execution for a pipeline (if any).
 */
function getActiveExecution(pipelineId) {
  if (!pipelineId) return null;
  const execId = ACTIVE_EXECUTIONS.get(pipelineId);
  if (!execId) return null;
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM pipeline_executions WHERE id = ?")
    .get(execId);
  if (!row) {
    ACTIVE_EXECUTIONS.delete(pipelineId);
    return null;
  }
  return row;
}

function getExecutionState(executionId) {
  if (!executionId) return null;
  const db = getDb();
  return db
    .prepare(
      "SELECT id, pipeline_id, status, state, current_stage, current_message, progress, started_at, finished_at FROM pipeline_executions WHERE id = ?",
    )
    .get(String(executionId));
}

/**
 * Heuristic: is the active execution genuinely making progress?
 *
 * Returns true when the execution appears to be alive — i.e., its DB row
 * was updated recently (within `staleMs`). Returns false when:
 *   - there is no active execution in memory
 *   - the DB row hasn't been touched for `staleMs` (default 60s)
 *   - the row is already in a terminal state
 *
 * The Run / Restart / Retry / Resume endpoints use this to decide whether
 * to auto-clear the active execution (when it appears dead) or to refuse
 * with a clear error (when it is genuinely still working). Previously
 * these endpoints either always refused (the original "buttons don't
 * work" complaint) or always auto-cleared (which can interrupt real
 * work). This gives us the middle ground.
 */
function isExecutionProgressing(pipelineId, staleMs = 60_000) {
  const exec = getActiveExecution(pipelineId);
  if (!exec) return false;
  const terminal = new Set([
    STATES.COMPLETED,
    STATES.FAILED,
    STATES.STOPPED,
  ]);
  if (terminal.has(String(exec.status || "").toLowerCase())) return false;
  const updated = exec.updated_at ? new Date(exec.updated_at).getTime() : null;
  if (!updated) return false;
  return Date.now() - updated < staleMs;
}

/**
 * Returns true if the pipeline currently has any in-memory active
 * execution OR any DB row in a transient (running/paused/resuming/
 * stopping/retrying) state. Used by the routes to detect "stuck"
 * pipelines that need force-clearing.
 */
function hasStuckDbRow(pipelineId) {
  if (!pipelineId) return false;
  try {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT 1 FROM pipeline_executions
         WHERE pipeline_id = ?
           AND status IN ('running', 'paused', 'resuming', 'stopping', 'retrying')
         LIMIT 1`,
      )
      .get(String(pipelineId));
    return Boolean(row);
  } catch (_) {
    return false;
  }
}

module.exports = {
  createExecution,
  transitionExecution,
  updateExecutionProgress,
  markExecutionFailed,
  markExecutionCompleted,
  getActiveExecution,
  getExecutionState,
  isExecutionProgressing,
  hasStuckDbRow,
};
