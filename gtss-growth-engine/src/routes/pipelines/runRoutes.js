/**
 * Pipelines Routes — Run + Restart Endpoints
 *
 * Express handlers for triggering immediate pipeline runs:
 *   POST /:id/run      — Trigger a manual run now (respects pause + active execs)
 *   POST /:id/restart  — Stop current (if any) and start a fresh run
 *
 * Both handlers respond immediately and run the actual lifecycle in the
 * background via setImmediate + runPipelineWithLifecycle.
 *
 * Extracted from the original routes/pipelines.js for maintainability.
 */

const { getDb } = require('../../db/database');
const {
  runPipelineWithLifecycle,
  isPipelinePaused,
} = require('../../jobs/pipelineScheduler');
const logger = require('../../utils/logger');
const pipelineState = require('../../services/pipelineStateService');
const checkpointService = require('../../services/pipelineCheckpoint');

const {
  parseJsonObject,
  broadcastPipelineStatus,
} = require('./shared');
const {
  normalizeLimits,
  preflightMassFollowWithImport,
} = require('./massFollowHelpers');

/**
 * Register run + restart routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerRunRoutes(router) {
  // ── POST /api/pipelines/:id/run ── Trigger a manual run now
  router.post('/:id/run', async (req, res) => {
    const { id } = req.params;
    const db = getDb();
    const row = db.prepare('SELECT * FROM pipeline_schedules WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Pipeline not found' });

    let limits = {};
    limits = {
      ...parseJsonObject(row.limits_json),
      ...normalizeLimits(id, req.body?.limits || {}),
    };
    const keywords = Array.isArray(req.body?.keywords)
      ? req.body.keywords.map((keyword) => String(keyword).trim()).filter(Boolean)
      : [];

    if (isPipelinePaused(id)) {
      return res.status(409).json({
        error: 'Pipeline is paused. Click Resume first, or use Restart to override the pause.',
        hint: 'paused',
      });
    }

    // If there's an active execution that IS genuinely making progress,
    // refuse with a clear error — don't interrupt real work. If the
    // execution is stuck (no progress for >60s), auto-clear it and
    // proceed. The previous behavior always auto-cleared, which could
    // interrupt a runner that was just slow but actually working.
    const active = pipelineState.getActiveExecution(id);
    if (active) {
      if (pipelineState.isExecutionProgressing(id)) {
        return res.status(409).json({
          error: `Pipeline "${id}" is already running (execution ${active.id}). Wait for it to finish, or click Stop / Force Clear first.`,
          hint: 'already_running',
          active_execution_id: active.id,
        });
      }
      logger.warn('PIPELINES-API', `Run of "${id}": auto force-clearing stuck execution ${active.id} before run.`);
      pipelineState.forceClearExecution(id, `run (auto-cleared stale execution)`);
    }

    if (id === 'content' && (!limits.topic || !String(limits.topic).trim())) {
      return res.status(400).json({
        error: 'A content topic is required before running the Auto-Content Pipeline',
      });
    }

    let massFollowSeeded = null;
    if (id === 'mass_follow') {
      const result = preflightMassFollowWithImport(limits);
      massFollowSeeded = result.seeded;
      if (!result.ok) {
        return res.status(400).json({
          ok: false,
          reason: result.reason,
          error: result.error,
          seeded: massFollowSeeded,
        });
      }
    }

    // Respond immediately; run in background via the lifecycle service
    const seededText = massFollowSeeded && (massFollowSeeded.inserted > 0 || massFollowSeeded.updated > 0)
      ? ` after importing ${massFollowSeeded.inserted} lead target(s)`
      : '';
    res.json({ ok: true, message: `Pipeline "${row.name}" triggered manually${seededText}`, seeded: massFollowSeeded });

    setImmediate(async () => {
      try {
        const execId = await runPipelineWithLifecycle(id, 'manual', limits, {
          keywords,
          force: true,
        });
        logger.info('PIPELINES-API', `Manual run of "${id}" started as execution ${execId}`);
      } catch (err) {
        logger.error('PIPELINES-API', `Manual run of "${id}" failed`, err);
        broadcastPipelineStatus(id, {
          status: 'failed',
          state: 'failed',
          error: err.message,
        });
      }
    });
  });

  // ── POST /api/pipelines/:id/restart ── Stop current (if any) and start fresh
  router.post('/:id/restart', async (req, res) => {
    const { id } = req.params;
    const db = getDb();
    const row = db.prepare('SELECT * FROM pipeline_schedules WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Pipeline not found' });

    // Restart is the user's "I want this pipeline to start over RIGHT NOW"
    // button. It always clears the pause flag and proceeds, even if the
    // pipeline was paused. (Previously, restart refused when paused,
    // forcing the user to click Resume first, then Restart — the exact
    // "buttons don't work" frustration they reported.)
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, 'false')
       ON CONFLICT(key) DO UPDATE SET value = 'false'`,
    ).run(`pipeline_${id}_paused`);

    // If there's an active execution, attempt a graceful stop first. If
    // the runner responds to the abort flag within the grace period, we
    // let it exit cleanly. If not (i.e., the runner is truly stuck), we
    // force-clear the execution so the new run can start.
    //
    // The grace period is 1.5s — long enough for a cooperative runner to
    // notice the abort flag between stages, short enough that the user
    // doesn't think restart is hung. For runners stuck INSIDE a long
    // browser operation, force-clear's jobRegistry.abort() provides the
    // real teeth.
    const active = pipelineState.getActiveExecution(id);
    if (active) {
      pipelineState.requestStop(id);
      // Brief grace period for the runner to notice the abort flag.
      await new Promise((r) => setTimeout(r, 1500));
      const stillActive = pipelineState.getActiveExecution(id);
      if (stillActive && stillActive.id === active.id) {
        logger.warn('PIPELINES-API', `Restart of "${id}": stuck execution ${active.id} did not respond to stop — force-clearing (also kills background jobs and clears pause flag).`);
        pipelineState.forceClearExecution(id, `restart (stuck execution did not respond to stop)`);
      }
      // Clear any checkpoints for the previous execution so the new run
      // starts fresh. (If the execution was force-cleared, this is a
      // no-op for unrelated executions.)
      try { checkpointService.clearCheckpoints(active.id); } catch (_) {}
    } else if (pipelineState.hasStuckDbRow(id)) {
      // Even without an in-memory active execution, the DB may have stale
      // "running" rows that would block createExecution. Sweep them now.
      pipelineState.forceClearExecution(id, `restart (preemptive sweep of stale DB rows)`);
    }

    let limits = {
      ...parseJsonObject(row.limits_json),
      ...normalizeLimits(id, req.body?.limits || {}),
    };
    const keywords = Array.isArray(req.body?.keywords)
      ? req.body.keywords.map((keyword) => String(keyword).trim()).filter(Boolean)
      : [];

    if (id === 'content' && (!limits.topic || !String(limits.topic).trim())) {
      return res.status(400).json({
        error: 'A content topic is required before restarting the Auto-Content Pipeline',
      });
    }

    let massFollowSeeded = null;
    if (id === 'mass_follow') {
      const result = preflightMassFollowWithImport(limits);
      massFollowSeeded = result.seeded;
      if (!result.ok) {
        return res.status(400).json({
          ok: false,
          reason: result.reason,
          error: result.error,
          seeded: massFollowSeeded,
        });
      }
    }

    const seededText = massFollowSeeded && (massFollowSeeded.inserted > 0 || massFollowSeeded.updated > 0)
      ? ` after importing ${massFollowSeeded.inserted} lead target(s)`
      : '';
    res.json({ ok: true, message: `Pipeline "${row.name}" restarting${seededText}`, seeded: massFollowSeeded });

    setImmediate(async () => {
      try {
        const execId = await runPipelineWithLifecycle(id, 'manual', limits, { keywords, force: true });
        logger.info('PIPELINES-API', `Restart of "${id}" started as execution ${execId}`);
      } catch (err) {
        logger.error('PIPELINES-API', `Restart of "${id}" failed`, err);
        broadcastPipelineStatus(id, { status: 'failed', state: 'failed', error: err.message });
      }
    });
  });
}

module.exports = { registerRunRoutes };
