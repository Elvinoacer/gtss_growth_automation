/**
 * Pipelines Routes — Pause / Resume / Stop / Force-Clear Endpoints
 *
 * Express handlers for the per-pipeline control surface:
 *   POST /:id/pause        — Pause the pipeline (schedule-level or active exec)
 *   POST /:id/resume       — Resume the pipeline
 *   POST /:id/stop         — Stop the active execution (also kills jobRegistry jobs)
 *   POST /:id/force-clear  — Escape hatch for stuck DB rows + stale ACTIVE_EXECUTIONS
 *
 * The setPauseFlag() helper is kept here for completeness — it is currently
 * unused at call sites (pipelineState.requestPause/requestResume handle the
 * flag themselves) but is preserved as part of the original module surface.
 *
 * Extracted from the original routes/pipelines.js for maintainability.
 */

const { getDb } = require('../../db/database');
const logger = require('../../utils/logger');
const jobRegistry = require('../../jobs/jobRegistry');
const { logActivity } = require('../../services/auditService');
const pipelineState = require('../../services/pipelineStateService');

const { broadcastPipelineStatus } = require('./shared');

function setPauseFlag(id, paused) {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(`pipeline_${id}_paused`, paused ? 'true' : 'false');
  logActivity({
    activityType: 'user_action',
    entityType: 'pipeline',
    entityId: id,
    actor: 'manual',
    status: paused ? 'paused' : 'resumed',
    summary: `Pipeline ${id} ${paused ? 'paused' : 'resumed'}`,
  });
}

/**
 * Register pause / resume / stop / force-clear routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerPauseStopRoutes(router) {
  router.post('/:id/pause', (req, res) => {
    const { id } = req.params;
    const row = getDb().prepare('SELECT id FROM pipeline_schedules WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Pipeline not found' });
    const result = pipelineState.requestPause(id);
    if (!result.ok) {
      return res.status(400).json({
        error: result.error || 'Cannot pause pipeline',
        hint: 'pause_failed',
      });
    }
    getDb().prepare(`UPDATE pipeline_schedules SET last_status = 'paused', current_state = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    broadcastPipelineStatus(id, { status: 'paused', state: 'paused' });
    res.json({
      ok: true,
      paused: true,
      state: 'paused',
      scheduleLevel: result.scheduleLevel || false,
      executionId: result.executionId || null,
      message: result.scheduleLevel
        ? 'Pipeline paused at the schedule level. No active execution to pause.'
        : `Paused active execution ${result.executionId}. The runner will halt at the next stage boundary.`,
    });
  });

  router.post('/:id/resume', (req, res) => {
    const { id } = req.params;
    const row = getDb().prepare('SELECT id FROM pipeline_schedules WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Pipeline not found' });
    const result = pipelineState.requestResume(id);
    if (!result.ok) {
      return res.status(400).json({
        error: result.error || 'Cannot resume pipeline',
        hint: 'resume_failed',
      });
    }
    // Don't overwrite last_status with 'resumed' — that's not a real
    // pipeline state. Either keep the existing last_status (if the
    // schedule-level resume happened with no active execution) or let the
    // runner's transitionExecution handle it (when there IS an active
    // execution).
    if (result.scheduleLevel) {
      getDb().prepare(
        `UPDATE pipeline_schedules
         SET current_state = 'idle',
             last_status = CASE WHEN last_status = 'paused' THEN 'idle' ELSE last_status END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      ).run(id);
    }
    broadcastPipelineStatus(id, { status: 'resumed', state: result.scheduleLevel ? 'idle' : 'resuming' });
    res.json({
      ok: true,
      paused: false,
      state: result.scheduleLevel ? 'idle' : 'resuming',
      scheduleLevel: result.scheduleLevel || false,
      executionId: result.executionId || null,
      message: result.scheduleLevel
        ? 'Schedule-level pause cleared. The pipeline will run on its next cron tick, or you can click Run Now.'
        : `Resume requested for execution ${result.executionId}. The runner will continue at the next stage boundary.`,
    });
  });

  router.post('/:id/stop', (req, res) => {
    const { id } = req.params;
    const row = getDb().prepare('SELECT id FROM pipeline_schedules WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Pipeline not found' });

    // Capture pre-stop state so we can give a meaningful response message.
    const activeExec = pipelineState.getActiveExecution(id);

    const result = pipelineState.requestStop(id);
    const stopped = result.stopped || 0;

    // Also kill any registered jobRegistry jobs for this pipeline so that
    // any in-flight AbortController-listening browser operations actually
    // receive the abort signal. Previously, requestStop only set the abort
    // flag — which the runner checks cooperatively between stages — but a
    // runner stuck INSIDE a stage (e.g., waiting for a browser selector)
    // never re-checked the flag. Killing the job registry jobs gives the
    // abort real "teeth" for the first time.
    let jobsKilled = 0;
    try { jobsKilled = jobRegistry.stopJobsByPipeline(id); } catch (_) {}

    // Update the schedule-level state. If we actually stopped something,
    // mark it as 'stopped'. If there was nothing to stop, leave the state
    // alone (the user might have clicked Stop on an already-idle pipeline).
    if (stopped > 0) {
      getDb().prepare(
        `UPDATE pipeline_schedules
         SET last_status = 'stopped',
             current_state = 'idle',
             current_execution_id = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      ).run(id);
    }

    logActivity({
      activityType: 'user_action',
      entityType: 'pipeline',
      entityId: id,
      actor: 'manual',
      status: stopped > 0 ? 'success' : 'skipped',
      summary: `Stop requested for pipeline ${id}${jobsKilled > 0 ? ` (also killed ${jobsKilled} background job(s))` : ''}`,
      details: { stopped, jobsKilled, sweptDb: result.sweptDb || false, executionId: result.executionId || null },
    });
    broadcastPipelineStatus(id, {
      status: stopped > 0 ? 'stopped' : 'idle',
      state: stopped > 0 ? 'stopped' : 'idle',
      jobsKilled,
    });
    res.json({
      ok: true,
      stopped,
      jobsKilled,
      sweptDb: result.sweptDb || false,
      execution_id: result.executionId || null,
      message: stopped > 0
        ? (result.sweptDb
            ? `Stopped stuck execution ${result.executionId} (no live runner was found — cleared DB state).`
            : `Stop requested for active run${jobsKilled > 0 ? ` and ${jobsKilled} background job(s) killed` : ''}. The runner will halt at the next stage boundary.`)
        : 'No active run to stop. The pipeline is already idle.',
    });
  });

  // ── POST /api/pipelines/:id/force-clear ── Force-clear a stuck execution
  //
  // Use this when a pipeline shows "Running" forever but no real progress is
  // being made (the runner died without ever calling markExecutionFailed or
  // markExecutionCompleted — e.g., an unhandled rejection inside a long
  // browser automation step, an OOM kill, or a sync crash).
  //
  // This is the user-facing escape hatch. It:
  //   - Aborts the in-memory runner (sets ABORT_FLAG).
  //   - Kills any registered jobRegistry jobs (sends AbortSignal to in-flight
  //     browser operations).
  //   - Marks ALL stuck DB rows as 'failed' with a clear error_message.
  //   - Clears the in-memory ACTIVE_EXECUTIONS / ABORT_FLAGS / PAUSE_FLAGS.
  //   - Resets the schedule-level state to 'idle'.
  //   - Clears the schedule-level pause flag (so the user can immediately
  //     re-Run) — unless the body contains `keep_pause_intent: true`.
  //   - Releases the content pipeline DB lock if applicable.
  //
  // After this returns, the user can immediately Run / Retry / Resume.
  router.post('/:id/force-clear', (req, res) => {
    const { id } = req.params;
    const reason = req.body?.reason ? String(req.body.reason) : 'manual';
    const keepPauseIntent = Boolean(req.body?.keep_pause_intent);
    const row = getDb().prepare('SELECT id FROM pipeline_schedules WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Pipeline not found' });

    // Capture pre-clear DB state for the response, so the UI can show the
    // user exactly what was cleared (and confirm the action was effective).
    const db = getDb();
    const preClearStuck = db
      .prepare(
        `SELECT id, status, started_at FROM pipeline_executions
         WHERE pipeline_id = ?
           AND status IN ('running', 'paused', 'resuming', 'stopping', 'retrying')
         ORDER BY started_at DESC`,
      )
      .all(id);

    const result = pipelineState.forceClearExecution(id, reason, { keepPauseIntent });

    logActivity({
      activityType: 'user_action',
      entityType: 'pipeline',
      entityId: id,
      actor: 'manual',
      status: result.cleared > 0 ? 'success' : 'skipped',
      summary: `Force-clear requested for pipeline ${id} (cleared ${result.cleared} execution(s), killed ${result.jobsKilled || 0} job(s))`,
      details: {
        cleared: result.cleared,
        previousStatus: result.previousStatus || null,
        executionId: result.executionId || null,
        jobsKilled: result.jobsKilled || 0,
        reason,
        keepPauseIntent,
        stuckRowsBefore: preClearStuck.map((r) => ({ id: r.id, status: r.status })),
      },
    });

    broadcastPipelineStatus(id, {
      status: result.cleared > 0 ? 'failed' : 'idle',
      state: result.cleared > 0 ? 'failed' : 'idle',
      forced: result.cleared > 0,
      jobsKilled: result.jobsKilled || 0,
    });

    res.json({
      ok: true,
      cleared: result.cleared || 0,
      execution_id: result.executionId || null,
      previous_status: result.previousStatus || null,
      jobs_killed: result.jobsKilled || 0,
      stuck_rows_before: preClearStuck.map((r) => ({ id: r.id, status: r.status })),
      pause_intent_preserved: keepPauseIntent,
      message: result.cleared > 0
        ? `Cleared ${result.cleared} stuck execution(s)${result.jobsKilled ? ` and killed ${result.jobsKilled} background job(s)` : ''}. Previous state: ${result.previousStatus}. You can now Run / Retry / Resume.`
        : `Pipeline state reset to idle (no stuck execution found in DB).${keepPauseIntent ? ' Pause intent preserved.' : ' Pause flag also cleared.'}`,
    });
  });
}

module.exports = { registerPauseStopRoutes, setPauseFlag };
