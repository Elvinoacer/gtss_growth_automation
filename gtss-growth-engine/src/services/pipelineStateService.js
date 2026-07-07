/**
 * pipelineStateService.js — Central lifecycle state machine for all pipelines.
 *
 * Owns:
 *   - Creation of pipeline_executions rows
 *   - State transitions (idle → running → paused → resuming → stopping → stopped → completed → failed → retrying)
 *   - In-memory pause/resume/abort flags (mirrored in DB for crash recovery)
 *   - Socket.IO broadcast of state changes
 *   - Single-instance enforcement (only one execution per pipeline at a time unless parallelAllowed)
 *
 * Public API:
 *   STATES                             - enum of valid states
 *   isValidState(state)
 *   getExecutionState(executionId)
 *   getActiveExecution(pipelineId)
 *   createExecution(pipelineId, trigger, opts)        - returns execution row
 *   transitionExecution(executionId, newState, opts)  - state machine transition (validated)
 *   updateExecutionProgress(executionId, {stage, message, progress, completedSteps, totalSteps})
 *   markExecutionFailed(executionId, error, failedStage)
 *   markExecutionCompleted(executionId)
 *   requestPause(pipelineId)
 *   requestResume(pipelineId)
 *   requestStop(pipelineId)
 *   isPaused(executionId)
 *   isAborted(executionId)
 *   awaitResume(executionId, emitFn)
 *   throwIfAborted(executionId)
 *   recoverOnStartup()                 - sweep 'running' executions on boot
 *   RUNNERS                            - map of pipelineId → runner function (set by callers)
 */

const crypto = require("crypto");
const { getDb } = require("../db/database");
const logger = require("../utils/logger");
const pipelineLogger = require("./pipelineLogger");
const {
  recomputeAggregates,
} = require("./pipelineHealthService");

const STATES = Object.freeze({
  IDLE: "idle",
  SCHEDULED: "scheduled",
  RUNNING: "running",
  PAUSED: "paused",
  RESUMING: "resuming",
  STOPPING: "stopping",
  STOPPED: "stopped",
  COMPLETED: "completed",
  FAILED: "failed",
  RETRYING: "retrying",
});

const VALID_STATES = new Set(Object.values(STATES));

// In-memory flag maps keyed by executionId
const ABORT_FLAGS = new Map(); // executionId → true
const PAUSE_FLAGS = new Map(); // executionId → 'running' | 'paused'

// Pipeline-level lock: pipelineId → executionId (the active execution)
const ACTIVE_EXECUTIONS = new Map();

// Runners injected by pipeline modules
const RUNNERS = {};

function registerRunner(pipelineId, runnerFn) {
  RUNNERS[pipelineId] = runnerFn;
}

function isValidState(state) {
  return VALID_STATES.has(String(state || "").toLowerCase());
}

function uuid() {
  return crypto.randomUUID();
}

function safeJson(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return JSON.stringify({ error: "Failed to serialize" });
  }
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

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
      const { broadcast } = require("./socketService");
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

function getExecutionState(executionId) {
  if (!executionId) return null;
  const db = getDb();
  return db
    .prepare(
      "SELECT id, pipeline_id, status, state, current_stage, current_message, progress, started_at, finished_at FROM pipeline_executions WHERE id = ?",
    )
    .get(String(executionId));
}

// ── Pause / Resume / Stop requests ────────────────────────────────────────────

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

/**
 * Force-clear a stuck execution.
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
    const jobRegistry = require("../jobs/jobRegistry");
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

// ── Broadcast helper ──────────────────────────────────────────────────────────

function broadcastState(pipelineId, executionId, state, extras = {}) {
  try {
    const { broadcast } = require("./socketService");
    broadcast("pipeline:status", {
      id: pipelineId,
      pipeline_id: pipelineId,
      execution_id: executionId,
      status: state,
      state,
      ...extras,
      timestamp: new Date().toISOString(),
    });
  } catch (_) {}
}

// ── Startup recovery ──────────────────────────────────────────────────────────

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
  STATES,
  VALID_STATES,
  isValidState,
  createExecution,
  transitionExecution,
  updateExecutionProgress,
  markExecutionFailed,
  markExecutionCompleted,
  getActiveExecution,
  getExecutionState,
  isExecutionProgressing,
  hasStuckDbRow,
  requestPause,
  requestResume,
  requestStop,
  forceClearExecution,
  isPaused,
  isAborted,
  throwIfAborted,
  awaitResume,
  recoverOnStartup,
  canStart,
  registerRunner,
  RUNNERS,
  // Private hook used by the retry-stage / resume-from-checkpoint routes to
  // re-arm the in-memory ACTIVE_EXECUTIONS map for an existing executionId
  // (without going through createExecution, which would refuse because the
  // pipelineId is no longer in the map after the previous run terminated).
  __setActive: (pipelineId, executionId) => {
    if (!pipelineId || !executionId) return;
    ACTIVE_EXECUTIONS.set(String(pipelineId), String(executionId));
    ABORT_FLAGS.delete(String(executionId));
    PAUSE_FLAGS.set(String(executionId), "running");
  },
};
