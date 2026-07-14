/**
 * Pipelines Routes — Retry-Stage + Resume-From-Checkpoint Endpoints
 *
 * Express handlers for resuming a failed/stopped execution:
 *   POST /:id/retry-stage            — Retry a specific failed stage of an execution
 *   POST /:id/resume-from-checkpoint — Resume from the last successful checkpoint
 *
 * Both handlers reset the execution row to 'retrying', clear the schedule
 * pause flag, and run the existing execution in the background via
 * runExistingExecution with resumeFrom set.
 *
 * Extracted from the original routes/pipelines.js for maintainability.
 */

const { getDb } = require('../../db/database');
const { runExistingExecution } = require('../../jobs/pipelineScheduler');
const logger = require('../../utils/logger');
const { logActivity } = require('../../services/auditService');
const pipelineState = require('../../services/pipelineStateService');
const pipelineLogger = require('../../services/pipelineLogger');
const checkpointService = require('../../services/pipelineCheckpoint');

const {
  PIPELINE_STAGES,
  parseJsonObject,
  broadcastPipelineStatus,
} = require('./shared');
const { normalizeLimits } = require('./massFollowHelpers');

/**
 * Register retry-stage + resume-from-checkpoint routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerRetryRoutes(router) {
  // ── POST /api/pipelines/:id/retry-stage ── Retry a specific failed stage
  //
  // Body: { stage?: "discovery" | "send" | "publish" | ..., executionId?: "...", force?: boolean }
  //
  // Behavior:
  //   - If no executionId is provided, uses the most recent FAILED execution
  //     for this pipeline. Returns 404 if none exists.
  //   - If no `stage` is provided AND the execution has no recorded
  //     `failed_stage`, defaults to the FIRST stage of the pipeline (i.e.,
  //     start over). This fixes the previous "specify stage in the body"
  //     dead-end.
  //   - If there's a stuck in-memory active execution, it is auto-cleared
  //     before the retry proceeds (unless `force: false` is explicitly
  //     passed in the body).
  router.post('/:id/retry-stage', async (req, res) => {
    const { id } = req.params;
    const db = getDb();
    const row = db.prepare('SELECT * FROM pipeline_schedules WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Pipeline not found' });

    const stage = req.body?.stage ? String(req.body.stage) : null;
    let executionId = req.body?.executionId ? String(req.body.executionId) : null;

    if (!executionId) {
      // Find the most recent failed execution for this pipeline. We also
      // accept 'stopped' executions because the user may have stopped a
      // run mid-stage and want to retry from that stage.
      const recent = db
        .prepare(
          `SELECT id FROM pipeline_executions
           WHERE pipeline_id = ? AND status IN ('failed', 'stopped')
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(id);
      if (!recent) {
        return res.status(404).json({
          error: 'No failed or stopped execution found to retry. Run the pipeline first.',
        });
      }
      executionId = recent.id;
    }

    const exec = db
      .prepare('SELECT * FROM pipeline_executions WHERE id = ?')
      .get(executionId);
    if (!exec) {
      return res.status(404).json({ error: `Execution ${executionId} not found` });
    }
    if (exec.pipeline_id !== id) {
      return res.status(400).json({ error: 'Execution does not belong to this pipeline' });
    }
    // Refuse if the execution is currently running / paused — the user
    // must Stop it first. (We don't auto-clear here because the execution
    // the user wants to retry is the SAME as the active one — clearing it
    // would defeat the purpose of the retry.)
    if (exec.status === 'running' || exec.status === 'paused' || exec.status === 'resuming' || exec.status === 'stopping') {
      return res.status(409).json({
        error: `Execution is currently ${exec.status}. Stop it first before retrying.`,
        hint: 'stop_first',
      });
    }

    // If there's a DIFFERENT in-memory active execution (i.e., the user
    // started a new run while the old failed one was still in the
    // history), auto-clear it before retrying. This is the fix for the
    // "buttons don't work" complaint: previously the user had to click
    // Force Clear first, then click Retry, which was frustrating.
    const activeExec = pipelineState.getActiveExecution(id);
    if (activeExec && activeExec.id !== executionId) {
      if (pipelineState.isExecutionProgressing(id)) {
        return res.status(409).json({
          error: `Another execution is currently running (${activeExec.id}). Stop it first, or use Force Clear.`,
          hint: 'another_running',
          active_execution_id: activeExec.id,
        });
      }
      logger.warn('PIPELINES-API', `Retry-stage for "${id}": auto force-clearing stuck execution ${activeExec.id} before retry.`);
      pipelineState.forceClearExecution(id, `retry-stage (auto-cleared stale execution)`);
    }

    // Determine the stage to retry:
    //  1. If a stage is provided in the body, use it.
    //  2. Otherwise, use the failed_stage recorded on the execution row.
    //  3. If neither is set (the runner died before recording a failed_stage),
    //     fall back to the FIRST stage of the pipeline — i.e., retry from the
    //     beginning. This is the fix for the "we need to specify stage in the
    //     reset body" dead-end.
    const orderedStages = PIPELINE_STAGES[id] || [];
    let failedStage = stage || exec.failed_stage;
    if (!failedStage) {
      failedStage = orderedStages[0] || null;
    }
    if (!failedStage) {
      return res.status(400).json({
        error: 'Could not determine which stage to retry. Pass "stage" in the request body.',
      });
    }

    // Clear the failed checkpoint so the runner will re-run that stage
    try {
      db.prepare(
        'DELETE FROM pipeline_checkpoints WHERE execution_id = ? AND stage = ?',
      ).run(executionId, failedStage);
    } catch (_) {}

    // Reset the execution row back to 'retrying' state. The runner will
    // transition it to 'running' once it starts (via runExistingExecution).
    db.prepare(
      `UPDATE pipeline_executions
       SET status = 'retrying',
           state = 'retrying',
           error_message = NULL,
           stack_trace = NULL,
           failed_stage = NULL,
           retry_count = retry_count + 1,
           finished_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(executionId);

    // Make sure the schedule-level pause flag is cleared — retry implies
    // the user wants to make progress, not stay paused.
    try {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, 'false')
         ON CONFLICT(key) DO UPDATE SET value = 'false'`,
      ).run(`pipeline_${id}_paused`);
    } catch (_) {}

    // Reload limits from the schedule (merged with any body overrides).
    let limits = {
      ...parseJsonObject(row.limits_json),
      ...normalizeLimits(id, req.body?.limits || {}),
    };
    const keywords = Array.isArray(req.body?.keywords)
      ? req.body.keywords.map((k) => String(k).trim()).filter(Boolean)
      : [];

    logActivity({
      activityType: 'pipeline_retry',
      entityType: 'pipeline',
      entityId: executionId,
      actor: 'manual',
      status: 'running',
      summary: `Retrying stage "${failedStage}" of pipeline ${id} (execution ${executionId})`,
      details: { stage: failedStage, executionId },
    });

    pipelineLogger.log({
      pipelineId: id,
      executionId,
      level: 'info',
      stage: 'retry',
      message: `Retrying stage "${failedStage}"`,
      context: { stage: failedStage },
      source: 'user',
    });

    res.json({
      ok: true,
      message: `Retrying stage "${failedStage}" of pipeline "${row.name}"`,
      execution_id: executionId,
      stage: failedStage,
    });

    // Run the existing execution with resumeFrom=failedStage. This uses
    // the public runExistingExecution helper (which handles __setActive
    // and the RUNNING transition internally) instead of the previous
    // private-API dance.
    setImmediate(async () => {
      try {
        await runExistingExecution(id, executionId, 'retry', limits, {
          resumeFrom: failedStage,
          keywords,
        });
        logger.info('PIPELINES-API', `Retry of stage "${failedStage}" for "${id}" completed (execution ${executionId})`);
      } catch (err) {
        logger.error('PIPELINES-API', `Retry of stage "${failedStage}" for "${id}" failed`, err);
        broadcastPipelineStatus(id, { status: 'failed', state: 'failed', error: err.message });
      }
    });
  });

  // ── POST /api/pipelines/:id/resume-from-checkpoint ── Resume from the last successful checkpoint
  //
  // Body: { executionId?: string, force?: boolean, limits?: {...}, keywords?: [...] }
  //
  // Behavior:
  //   - If no executionId is provided, uses the most recent FAILED or
  //     STOPPED execution. Returns 404 if none exists.
  //   - If there's a stuck in-memory active execution that ISN'T making
  //     progress, it is auto-cleared before resuming (so the user doesn't
  //     need to click Force Clear first). If it IS progressing, we refuse
  //     with a 409 and a clear error.
  //   - If `force: true` is passed, we always clear the stuck execution
  //     (this is the escape hatch the UI uses by default).
  router.post('/:id/resume-from-checkpoint', async (req, res) => {
    const { id } = req.params;
    const db = getDb();
    const row = db.prepare('SELECT * FROM pipeline_schedules WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Pipeline not found' });

    let executionId = req.body?.executionId ? String(req.body.executionId) : null;
    const force = Boolean(req.body?.force);

    if (!executionId) {
      const recent = db
        .prepare(
          `SELECT id FROM pipeline_executions
           WHERE pipeline_id = ? AND status IN ('failed', 'stopped')
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(id);
      if (!recent) {
        return res.status(404).json({
          error: 'No failed or stopped execution found to resume. Run the pipeline first.',
        });
      }
      executionId = recent.id;
    }

    const exec = db
      .prepare('SELECT * FROM pipeline_executions WHERE id = ?')
      .get(executionId);
    if (!exec) return res.status(404).json({ error: `Execution ${executionId} not found` });
    if (exec.pipeline_id !== id) {
      return res.status(400).json({ error: 'Execution does not belong to this pipeline' });
    }
    // Refuse if the target execution is currently running / paused. The
    // user must Stop it first OR use the pause/resume buttons (which operate
    // on the active execution directly).
    if (['running', 'paused', 'resuming', 'stopping'].includes(exec.status)) {
      return res.status(409).json({
        error: `Execution is currently ${exec.status}. Stop it first, or use Pause / Resume to control the active run.`,
        hint: 'stop_first',
      });
    }

    // Check for a stuck in-memory active execution that would block the
    // resume. If it's the SAME as the target execution, we treat it as
    // already-running and refuse. If it's a DIFFERENT execution, we
    // auto-clear it (when stuck) or refuse (when progressing).
    const activeExec = pipelineState.getActiveExecution(id);
    if (activeExec) {
      if (activeExec.id === executionId) {
        return res.status(409).json({
          error: `Execution ${executionId} is already the active execution (status: ${activeExec.status}). Use Pause / Resume / Stop to control it.`,
          hint: 'already_active',
        });
      }
      if (!force && pipelineState.isExecutionProgressing(id)) {
        return res.status(409).json({
          error: `Another execution is currently running (${activeExec.id}) and making progress. Stop it first, or re-send with { "force": true } to clear it and resume.`,
          hint: 'another_running',
          active_execution_id: activeExec.id,
        });
      }
      pipelineState.forceClearExecution(id, `resume-from-checkpoint (cleared stale execution)`);
    }

    const orderedStages = PIPELINE_STAGES[id] || [];
    const resumeStage = checkpointService.getResumeStage(executionId, orderedStages);
    if (!resumeStage) {
      return res.status(400).json({
        error: 'All stages already have completed checkpoints. Use "Run Now" to start a fresh run instead.',
        hint: 'nothing_to_resume',
      });
    }

    // Reset execution row to 'retrying' (the runner will transition it to
    // 'running' via runExistingExecution). Don't set to 'running' here —
    // otherwise the UI shows running with no actual runner attached.
    db.prepare(
      `UPDATE pipeline_executions
       SET status = 'retrying',
           state = 'retrying',
           error_message = NULL,
           stack_trace = NULL,
           failed_stage = NULL,
           resumed_at = CURRENT_TIMESTAMP,
           finished_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(executionId);

    // Clear the schedule-level pause flag — resume implies the user wants
    // to make progress, not stay paused.
    try {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, 'false')
         ON CONFLICT(key) DO UPDATE SET value = 'false'`,
      ).run(`pipeline_${id}_paused`);
    } catch (_) {}

    const limits = {
      ...parseJsonObject(row.limits_json),
      ...normalizeLimits(id, req.body?.limits || {}),
    };
    const keywords = Array.isArray(req.body?.keywords)
      ? req.body.keywords.map((k) => String(k).trim()).filter(Boolean)
      : [];

    pipelineLogger.log({
      pipelineId: id,
      executionId,
      level: 'info',
      stage: 'resume',
      message: `Resuming execution from stage "${resumeStage}"`,
      context: { resumeFrom: resumeStage },
      source: 'user',
    });

    res.json({
      ok: true,
      message: `Resuming pipeline "${row.name}" from stage "${resumeStage}"`,
      execution_id: executionId,
      resume_from: resumeStage,
    });

    setImmediate(async () => {
      try {
        await runExistingExecution(id, executionId, 'resume', limits, {
          resumeFrom: resumeStage,
          keywords,
        });
        logger.info('PIPELINES-API', `Resume-from-checkpoint of "${id}" completed (execution ${executionId})`);
      } catch (err) {
        logger.error('PIPELINES-API', `Resume-from-checkpoint of "${id}" failed`, err);
        broadcastPipelineStatus(id, { status: 'failed', state: 'failed', error: err.message });
      }
    });
  });
}

module.exports = { registerRetryRoutes };
