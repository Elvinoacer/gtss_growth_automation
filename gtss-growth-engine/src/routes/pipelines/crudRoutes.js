/**
 * Pipelines Routes — CRUD + Health Endpoints
 *
 * Express handlers for the read/update side of pipeline schedules:
 *   GET    /                    — List all pipeline schedules (with runtime state)
 *   GET    /active              — List currently active jobs from jobRegistry
 *   GET    /health              — Health snapshot for all pipelines
 *   PATCH  /:id                 — Update a pipeline schedule (cron, enabled, limits)
 *
 * Extracted from the original routes/pipelines.js for maintainability.
 */

const express = require('express');
const { getDb } = require('../../db/database');
const { syncFromDb, isPipelinePaused } = require('../../jobs/pipelineScheduler');
const cronRegistry = require('../../jobs/cronRegistry');
const cron = require('node-cron');
const logger = require('../../utils/logger');
const jobRegistry = require('../../jobs/jobRegistry');
const { getHealthForAll } = require('../../services/pipelineHealthService');

const {
  PIPELINE_STAGES,
  parseJsonObject,
  parseBoolean,
  buildRuntimeState,
} = require('./shared');
const { normalizeLimits } = require('./massFollowHelpers');

/**
 * Register CRUD + health routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerCrudRoutes(router) {
  // ── GET /api/pipelines ── List all pipeline schedules
  router.get('/', (req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM pipeline_schedules ORDER BY id').all();
    const activeCrons = cronRegistry.listAll();

    const result = rows.map(row => {
      const limits = parseJsonObject(row.limits_json);
      const paused = isPipelinePaused(row.id);
      return {
        ...row,
        limits,
        paused,
        stages: PIPELINE_STAGES[row.id] || [],
        ...buildRuntimeState(row, paused),
        is_registered: activeCrons.some(c => c.id === `pipeline:${row.id}`),
      };
    });

    res.json({ pipelines: result });
  });

  router.get('/active', (_req, res) => {
    res.json({ jobs: jobRegistry.listActiveJobs() });
  });

  // ── GET /api/pipelines/health ── Health snapshot for all pipelines
  router.get('/health', (req, res) => {
    try {
      const all = getHealthForAll();
      res.json({ pipelines: all });
    } catch (err) {
      logger.error('PIPELINES-API', 'Failed to load health', err);
      res.status(500).json({ error: err.message, pipelines: [] });
    }
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
    const paused = isPipelinePaused(id);

    res.json({
      ok: true,
      pipeline: {
        ...updated,
        limits: updatedLimits,
        paused,
        stages: PIPELINE_STAGES[id] || [],
        ...buildRuntimeState(updated, paused),
        is_registered: cronRegistry.isRegistered(`pipeline:${id}`),
      },
    });
  });
}

module.exports = { registerCrudRoutes };
