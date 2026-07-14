/**
 * Pipelines Routes — Execution History, Logs, Health, Checkpoints
 *
 * Read-only Express handlers for inspecting pipeline runs:
 *   GET /:id/executions       — List recent executions (with state, progress, errors)
 *   GET /:id/executions/:eid  — Get a single execution detail (with checkpoints & recent logs)
 *   GET /:id/logs             — Searchable / filterable structured logs
 *   GET /:id/health           — Pipeline health snapshot (success rate, uptime, etc.)
 *   GET /:id/checkpoints      — List checkpoints for the active or specified execution
 *   GET /:id/history          — Legacy: recent pipeline runs (kept for compat)
 *
 * Extracted from the original routes/pipelines.js for maintainability.
 */

const { getDb } = require('../../db/database');
const logger = require('../../utils/logger');
const pipelineState = require('../../services/pipelineStateService');
const pipelineLogger = require('../../services/pipelineLogger');
const checkpointService = require('../../services/pipelineCheckpoint');
const { getHealth } = require('../../services/pipelineHealthService');

/**
 * Register execution / log / health / checkpoint / history routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerExecutionRoutes(router) {
  // ── GET /api/pipelines/:id/executions ── List recent executions
  router.get('/:id/executions', (req, res) => {
    const { id } = req.params;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT * FROM pipeline_executions
         WHERE pipeline_id = ?
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(id, limit);

    const result = rows.map((row) => {
      let metadata = null;
      try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null; } catch (_) {}
      return {
        ...row,
        metadata,
      };
    });

    res.json({ executions: result });
  });

  // ── GET /api/pipelines/:id/executions/:eid ── Get a single execution detail
  router.get('/:id/executions/:eid', (req, res) => {
    const { id, eid } = req.params;
    const db = getDb();
    const exec = db
      .prepare('SELECT * FROM pipeline_executions WHERE id = ? AND pipeline_id = ?')
      .get(String(eid), String(id));
    if (!exec) return res.status(404).json({ error: 'Execution not found' });

    let metadata = null;
    try { metadata = exec.metadata_json ? JSON.parse(exec.metadata_json) : null; } catch (_) {}

    const checkpoints = checkpointService.getCheckpoints(exec.id);
    const { logs } = pipelineLogger.query({
      executionId: exec.id,
      limit: Number(req.query.logLimit) || 200,
    });

    res.json({
      execution: { ...exec, metadata },
      checkpoints,
      logs,
    });
  });

  // ── GET /api/pipelines/:id/logs ── Searchable / filterable structured logs
  router.get('/:id/logs', (req, res) => {
    const { id } = req.params;
    const filters = {
      pipelineId: id,
      level: req.query.level,
      levels: req.query.levels,
      stage: req.query.stage,
      search: req.query.search,
      since: req.query.since,
      until: req.query.until,
      source: req.query.source,
      browserEvent: req.query.browserEvent,
      executionId: req.query.executionId,
      limit: Number(req.query.limit) || 200,
      offset: Number(req.query.offset) || 0,
    };

    try {
      const result = pipelineLogger.query(filters);
      const counts = pipelineLogger.countByLevel({
        pipelineId: id,
        since: req.query.since,
        executionId: req.query.executionId,
      });
      res.json({ ...result, counts });
    } catch (err) {
      logger.error('PIPELINES-API', `Failed to query logs for ${id}`, err);
      res.status(500).json({ error: err.message, logs: [], total: 0, counts: {} });
    }
  });

  // ── GET /api/pipelines/:id/health ── Pipeline health snapshot
  router.get('/:id/health', (req, res) => {
    try {
      const health = getHealth(req.params.id);
      if (!health) return res.status(404).json({ error: 'Pipeline not found' });
      res.json({ health });
    } catch (err) {
      logger.error('PIPELINES-API', `Failed to load health for ${req.params.id}`, err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/pipelines/:id/checkpoints ── List checkpoints
  router.get('/:id/checkpoints', (req, res) => {
    const { id } = req.params;
    const executionId = req.query.executionId
      ? String(req.query.executionId)
      : pipelineState.getActiveExecution(id)?.id;

    if (!executionId) {
      return res.json({ checkpoints: [] });
    }
    const checkpoints = checkpointService.getCheckpoints(executionId);
    res.json({ checkpoints, execution_id: executionId });
  });

  // ── GET /api/pipelines/:id/history ── Legacy: recent pipeline runs (kept for compat)
  router.get('/:id/history', (req, res) => {
    const db = getDb();
    const { id } = req.params;
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    if (id === 'outreach') {
      const runs = db.prepare(`
        SELECT id, trigger, mode, status, started_at, finished_at, stages_json
        FROM pipeline_runs
        ORDER BY started_at DESC
        LIMIT ?
      `).all(limit).map(run => {
        try { run.stages = JSON.parse(run.stages_json || '{}'); } catch (_) { run.stages = {}; }
        return run;
      });
      return res.json({ runs });
    }

    if (id === 'content') {
      const posts = db.prepare(`
        SELECT id, platforms, body, status, created_at, published_at, last_error
        FROM posts
        WHERE media_path LIKE '/uploads/auto-%'
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit);
      return res.json({ runs: posts });
    }

    if (id === 'dm_check') {
      const rows = db.prepare(`
        SELECT job_id AS id,
               MIN(created_at) AS started_at,
               MAX(created_at) AS finished_at,
               MAX(CASE WHEN level = 'error' THEN message ELSE NULL END) AS last_error,
               CASE
                 WHEN SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) > 0 THEN 'failed'
                 ELSE 'completed'
               END AS status
        FROM pipeline_events
        WHERE job_type = 'dm_check' AND job_id IS NOT NULL
        GROUP BY job_id
        ORDER BY finished_at DESC
        LIMIT ?
      `).all(limit);
      return res.json({ runs: rows });
    }

    if (id === 'mass_follow') {
      const rows = db.prepare(`
        SELECT id, trigger, status, current_stage, current_message, progress,
               total_steps, completed_steps, error_message, started_at, finished_at, duration_ms
        FROM pipeline_executions
        WHERE pipeline_id = 'mass_follow'
        ORDER BY started_at DESC
        LIMIT ?
      `).all(limit);
      return res.json({ runs: rows });
    }

    res.json({ runs: [] });
  });
}

module.exports = { registerExecutionRoutes };
