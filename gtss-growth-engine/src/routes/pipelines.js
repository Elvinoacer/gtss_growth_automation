/**
 * pipelines.js — Pipeline Manager API Routes
 *
 * GET    /api/pipelines           — List all pipeline schedules
 * PATCH  /api/pipelines/:id       — Update a pipeline schedule
 * POST   /api/pipelines/:id/run   — Trigger a manual run now
 * GET    /api/pipelines/:id/history — Recent pipeline runs
 */

const express = require('express');
const { getDb } = require('../db/database');
const {
  syncFromDb,
} = require('../jobs/pipelineScheduler');
const { runFullPipeline } = require('../pipeline/pipelineRunner');
const { runContentPipeline } = require('../pipeline/contentPipeline');
const cronRegistry = require('../jobs/cronRegistry');
const cron = require('node-cron');
const logger = require('../utils/logger');
const jobRegistry = require('../jobs/jobRegistry');
const { logActivity } = require('../services/auditService');

const router = express.Router();

const ALLOWED_CONTENT_PLATFORMS = new Set(['instagram', 'linkedin', 'x', 'facebook']);

function parseJsonObject(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch (_) {
    return fallback;
  }
}

function parseBoolean(value) {
  if (value === undefined) return undefined;
  if (value === true || value === 1 || value === 'true') return true;
  if (value === false || value === 0 || value === 'false') return false;
  return Boolean(value);
}

function normalizeLimits(id, limits) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    return {};
  }

  const next = { ...limits };
  for (const key of [
    'max_leads_per_keyword',
    'max_dms_per_run',
    'max_connections_per_run',
    'max_posts_per_run',
  ]) {
    if (next[key] !== undefined) {
      const numeric = Number(next[key]);
      if (!Number.isFinite(numeric) || numeric < 1) {
        throw new Error(`${key} must be a positive number`);
      }
      next[key] = Math.floor(numeric);
    }
  }

  if (id === 'content') {
    if (next.topic !== undefined) {
      next.topic = String(next.topic).trim();
    }
    if (next.style !== undefined) {
      next.style = String(next.style).trim() || 'photorealistic';
    }
    if (next.platforms !== undefined) {
      if (!Array.isArray(next.platforms)) {
        throw new Error('platforms must be an array');
      }
      next.platforms = next.platforms
        .map((platform) => String(platform).trim().toLowerCase())
        .filter((platform) => ALLOWED_CONTENT_PLATFORMS.has(platform));
      if (next.platforms.length === 0) {
        throw new Error('Select at least one content platform');
      }
    }
  }
  if (id === 'dm_check') {
    for (const key of ['active_hours_start', 'active_hours_end']) {
      if (next[key] !== undefined) next[key] = Number(next[key]);
    }
    if (next.platforms !== undefined && !Array.isArray(next.platforms)) {
      throw new Error('platforms must be an array');
    }
    if (Array.isArray(next.platforms)) {
      next.platforms = next.platforms.map((platform) => String(platform).trim().toLowerCase()).filter(Boolean);
    }
    if (next.timezone !== undefined) next.timezone = String(next.timezone).trim() || 'UTC';
    if (next.prompt !== undefined) next.prompt = String(next.prompt);
  }

  return next;
}

// ── GET /api/pipelines ── List all pipeline schedules
router.get('/', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM pipeline_schedules ORDER BY id').all();
  const activeCrons = cronRegistry.listAll();

  const result = rows.map(row => {
    const limits = parseJsonObject(row.limits_json);
    const paused = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(`pipeline_${row.id}_paused`);
    return {
      ...row,
      limits,
      paused: String(paused?.value || 'false') === 'true',
      is_registered: activeCrons.some(c => c.id === `pipeline:${row.id}`),
    };
  });

  res.json({ pipelines: result });
});

router.get('/active', (_req, res) => {
  res.json({ jobs: jobRegistry.listActiveJobs() });
});

// ── PATCH /api/pipelines/:id ── Update a pipeline schedule
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { enabled, cron: cronExpr, limits } = req.body;
  const db = getDb();

  const row = db.prepare('SELECT * FROM pipeline_schedules WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });

  const nextCron = cronExpr !== undefined ? String(cronExpr).trim() : row.cron;
  if (!cron.validate(nextCron)) {
    return res.status(400).json({ error: `Invalid cron expression: ${nextCron}` });
  }

  let mergedLimits;
  try {
    mergedLimits = {
      ...parseJsonObject(row.limits_json),
      ...normalizeLimits(id, limits),
    };
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const nextEnabled =
    enabled !== undefined ? parseBoolean(enabled) : Boolean(row.enabled);

  if (nextEnabled && id === 'content') {
    if (!mergedLimits.topic || !String(mergedLimits.topic).trim()) {
      return res.status(400).json({
        error: 'A content topic is required before enabling the Auto-Content Pipeline',
      });
    }
  }

  db.prepare(`
    UPDATE pipeline_schedules
    SET enabled = ?, cron = ?, limits_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(nextEnabled ? 1 : 0, nextCron, JSON.stringify(mergedLimits), id);

  await syncFromDb();

  const updated = db.prepare('SELECT * FROM pipeline_schedules WHERE id = ?').get(id);
  const updatedLimits = parseJsonObject(updated.limits_json);

  res.json({
    ok: true,
    pipeline: {
      ...updated,
      limits: updatedLimits,
      is_registered: cronRegistry.isRegistered(`pipeline:${id}`),
    },
  });
});

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

  if (id === 'content' && (!limits.topic || !String(limits.topic).trim())) {
    return res.status(400).json({
      error: 'A content topic is required before running the Auto-Content Pipeline',
    });
  }

  // Respond immediately; run in background
  res.json({ ok: true, message: `Pipeline "${row.name}" triggered manually` });

  setImmediate(async () => {
    db.prepare(`
      UPDATE pipeline_schedules
      SET last_run_at = CURRENT_TIMESTAMP, last_status = 'running',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);

    // Broadcast pipeline status: running
    try {
      const { broadcast } = require('../services/socketService');
      broadcast('pipeline:status', {
        id: row.id,
        status: 'running',
        last_run_at: new Date().toISOString(),
      });
    } catch (_) {}

    try {
      if (id === 'outreach') {
        const runId = await runFullPipeline('manual', { limits, keywords });
        logger.info('PIPELINES-API', `Manual outreach run #${runId} complete`);
      } else if (id === 'content') {
        const result = await runContentPipeline({ ...limits, trigger: 'manual' });
        const failed =
          result &&
          (result.success === false ||
            (Array.isArray(result.runs) && result.runs.every((run) => run.success === false)));
        if (failed) {
          throw new Error(result.error || 'Content pipeline failed');
        }
        logger.info('PIPELINES-API', `Manual content run complete`, result);
      } else if (id === 'dm_check') {
        const { syncFromDb } = require('../jobs/pipelineScheduler');
        const scheduler = require('../jobs/pipelineScheduler');
        const runner = scheduler.__getRunner ? scheduler.__getRunner('dm_check') : null;
        if (runner) await runner(limits);
        else {
          await syncFromDb();
          throw new Error('DM checker can run on its next configured cron tick');
        }
      }

      // Update DB status
      db.prepare(`
        UPDATE pipeline_schedules
        SET last_run_at = CURRENT_TIMESTAMP, last_status = 'completed',
            run_count = run_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(id);

      // Broadcast pipeline status: completed
      try {
        const { broadcast } = require('../services/socketService');
        broadcast('pipeline:status', {
          id: row.id,
          status: 'completed',
          last_run_at: new Date().toISOString(),
        });
      } catch (_) {}
    } catch (err) {
      logger.error('PIPELINES-API', `Manual run of "${id}" failed`, err);

      db.prepare(`
        UPDATE pipeline_schedules
        SET last_run_at = CURRENT_TIMESTAMP, last_status = 'failed',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(id);

      try {
        const { broadcast } = require('../services/socketService');
        broadcast('pipeline:status', {
          id: row.id,
          status: 'failed',
          last_run_at: new Date().toISOString(),
          error: err.message,
        });
      } catch (_) {}
    }
  });
});

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

router.post('/:id/pause', (req, res) => {
  const { id } = req.params;
  const row = getDb().prepare('SELECT id FROM pipeline_schedules WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });
  setPauseFlag(id, true);
  res.json({ ok: true, paused: true });
});

router.post('/:id/resume', (req, res) => {
  const { id } = req.params;
  const row = getDb().prepare('SELECT id FROM pipeline_schedules WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });
  setPauseFlag(id, false);
  res.json({ ok: true, paused: false });
});

router.post('/:id/stop', (req, res) => {
  const { id } = req.params;
  const stopped = jobRegistry.stopJobsByPipeline(id);
  logActivity({
    activityType: 'user_action',
    entityType: 'pipeline',
    entityId: id,
    actor: 'manual',
    status: stopped > 0 ? 'success' : 'skipped',
    summary: `Stop requested for pipeline ${id}`,
    details: { stopped },
  });
  res.json({ ok: true, stopped });
});

// ── GET /api/pipelines/:id/history ── Recent pipeline runs
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
    // Content pipeline posts are visible in the posts table
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

  res.json({ runs: [] });
});

module.exports = router;
