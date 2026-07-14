/**
 * Pipelines Routes — Mass-Follow Target Management Endpoints
 *
 * Express handlers for the mass_follow pipeline's target queue:
 *   GET    /mass-follow/targets                  — List targets (with filters + summary)
 *   POST   /mass-follow/targets                  — Add one or many targets (idempotent)
 *   POST   /mass-follow/targets/import-leads     — Seed targets from CRM/discovery leads
 *   DELETE /mass-follow/targets/:id              — Remove a single target
 *   POST   /mass-follow/targets/:id/retry        — Reset a failed target back to pending
 *   POST   /mass-follow/targets/clear            — Bulk delete by filter
 *
 * The mass_follow pipeline operates on rows in `mass_follow_targets`. These
 * endpoints are the only way the table gets populated — the pipeline itself
 * only flips status.
 *
 * Extracted from the original routes/pipelines.js for maintainability.
 */

const { getDb } = require('../../db/database');
const logger = require('../../utils/logger');
const { logActivity } = require('../../services/auditService');

const { ALLOWED_MASS_FOLLOW_PLATFORMS } = require('./shared');
const {
  importMassFollowTargetsFromLeads,
  normalizeMassFollowTarget,
} = require('./massFollowHelpers');

/**
 * Register mass-follow target-management routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerMassFollowRoutes(router) {
  // ── GET /api/pipelines/mass-follow/targets ── list with optional filters
  router.get('/mass-follow/targets', (req, res) => {
    const db = getDb();
    const platform = req.query.platform ? String(req.query.platform).trim().toLowerCase() : null;
    const status = req.query.status ? String(req.query.status).trim().toLowerCase() : null;
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const where = [];
    const args = [];
    if (platform && ALLOWED_MASS_FOLLOW_PLATFORMS.has(platform)) {
      where.push('platform = ?');
      args.push(platform);
    }
    const validStatuses = new Set(['pending', 'running', 'sent', 'accepted', 'skipped', 'failed']);
    if (status && validStatuses.has(status)) {
      where.push('status = ?');
      args.push(status);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const rows = db
      .prepare(
        `SELECT id, platform, profile_url, handle, status, source, campaign_id, lead_id,
                error_message, retry_count, max_retries, next_retry_at, attempted_at, sent_at,
                created_at, updated_at
         FROM mass_follow_targets
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset);

    const totalRow = db
      .prepare(`SELECT COUNT(*) AS count FROM mass_follow_targets ${whereClause}`)
      .get(...args);

    // Summary counts for the UI
    const summary = db
      .prepare(
        `SELECT platform, status, COUNT(*) AS count
         FROM mass_follow_targets
         ${whereClause ? whereClause + ' AND ' : 'WHERE '} 1=1
         GROUP BY platform, status`,
      )
      .all(...args);

    const summaryMap = {};
    for (const row of summary) {
      if (!summaryMap[row.platform]) summaryMap[row.platform] = {};
      summaryMap[row.platform][row.status] = row.count;
    }

    res.json({ targets: rows, total: totalRow ? totalRow.count : 0, summary: summaryMap });
  });

  // ── POST /api/pipelines/mass-follow/targets ── add one or many targets
  //
  // Body: { targets: [{ platform, profile_url, handle?, source? }, ...] }
  //   OR  { platform, profile_url, handle?, source? }  (single-target shorthand)
  //
  // Idempotent on (platform, profile_url) — re-adding an existing target is a
  // no-op (returns its existing id, not an error). Failed targets that are
  // re-added are reset to 'pending' so the next run retries them.
  router.post('/mass-follow/targets', (req, res) => {
    const db = getDb();
    let incoming;
    if (Array.isArray(req.body.targets)) {
      incoming = req.body.targets;
    } else if (req.body && req.body.platform && req.body.profile_url) {
      incoming = [req.body];
    } else {
      return res.status(400).json({ error: 'Provide a `targets` array or a single {platform, profile_url} object' });
    }

    const inserted = [];
    const updated = [];
    const errors = [];

    const insertStmt = db.prepare(
      `INSERT INTO mass_follow_targets (platform, profile_url, handle, source, status, max_retries)
       VALUES (?, ?, ?, ?, 'pending', 3)
       ON CONFLICT(platform, profile_url) DO UPDATE SET
         handle = COALESCE(excluded.handle, mass_follow_targets.handle),
         source = COALESCE(excluded.source, mass_follow_targets.source),
         status = CASE WHEN mass_follow_targets.status IN ('sent','accepted') THEN mass_follow_targets.status ELSE 'pending' END,
         error_message = NULL,
         retry_count = 0,
         next_retry_at = NULL,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id, (changes() > 0) AS was_inserted`,
    );

    for (let i = 0; i < incoming.length; i++) {
      const item = incoming[i];
      try {
        const normalized = normalizeMassFollowTarget(
          item.platform,
          item.profile_url,
          item.handle,
          item.source,
        );
        const row = insertStmt.get(
          normalized.platform,
          normalized.profile_url,
          normalized.handle,
          normalized.source,
        );
        if (row && row.was_inserted) {
          inserted.push({ id: row.id, ...normalized });
        } else if (row) {
          updated.push({ id: row.id, ...normalized });
        }
      } catch (err) {
        errors.push({ index: i, input: item, error: err.message });
      }
    }

    logActivity({
      activityType: 'mass_follow_target_added',
      entityType: 'pipeline',
      entityId: 'mass_follow',
      actor: req.user?.id || 'system',
      status: errors.length === 0 ? 'success' : 'partial',
      summary: `Added ${inserted.length} new mass-follow target(s), updated ${updated.length}, ${errors.length} error(s)`,
      details: { inserted: inserted.length, updated: updated.length, errors: errors.length },
    });

    res.status(201).json({
      inserted: inserted.length,
      updated: updated.length,
      errors: errors.length,
      inserted_ids: inserted.map((t) => t.id),
      updated_ids: updated.map((t) => t.id),
      errors_detail: errors,
    });
  });

  // ── POST /api/pipelines/mass-follow/targets/import-leads ── seed targets from CRM/discovery leads
  //
  // Body: { platforms?: string[], statuses?: string[], limit?: number }
  // Defaults to discovered/qualified leads on the currently supported
  // mass-follow platforms. This keeps profile discovery in the discovery/CRM
  // layer and lets mass-follow operate on a reviewable queue.
  router.post('/mass-follow/targets/import-leads', (req, res) => {
    try {
      const result = importMassFollowTargetsFromLeads({
        platforms: req.body?.platforms,
        statuses: req.body?.statuses,
        limit: req.body?.limit,
      });

      logActivity({
        activityType: 'mass_follow_targets_imported',
        entityType: 'pipeline',
        entityId: 'mass_follow',
        actor: req.user?.id || 'system',
        status: 'success',
        summary: `Imported ${result.inserted} new mass-follow target(s) from leads, updated ${result.updated}`,
        details: result,
      });

      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error('PIPELINES-API', 'Failed to import mass-follow targets from leads', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── DELETE /api/pipelines/mass-follow/targets/:id ── remove a single target
  router.delete('/mass-follow/targets/:id', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid target id' });
    }
    const result = db.prepare('DELETE FROM mass_follow_targets WHERE id = ?').run(id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Target not found' });
    }
    res.json({ deleted: true, id });
  });

  // ── POST /api/pipelines/mass-follow/targets/:id/retry ── reset a failed target back to pending
  router.post('/mass-follow/targets/:id/retry', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid target id' });
    }
    const result = db
      .prepare(
        `UPDATE mass_follow_targets
         SET status = 'pending', retry_count = 0, next_retry_at = NULL,
             error_message = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'failed'`,
      )
      .run(id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Target not found or not in failed status' });
    }
    res.json({ retried: true, id });
  });

  // ── POST /api/pipelines/mass-follow/targets/clear ── bulk delete by filter
  //
  // Body: { platform?, status?, older_than_days? }
  // Useful for clearing out a stale campaign before re-importing a fresh target list.
  router.post('/mass-follow/targets/clear', (req, res) => {
    const db = getDb();
    const platform = req.body?.platform ? String(req.body.platform).trim().toLowerCase() : null;
    const status = req.body?.status ? String(req.body.status).trim().toLowerCase() : null;
    const olderThanDays = Number(req.body?.older_than_days) || 0;

    const where = [];
    const args = [];
    if (platform && ALLOWED_MASS_FOLLOW_PLATFORMS.has(platform)) {
      where.push('platform = ?');
      args.push(platform);
    }
    const validStatuses = new Set(['pending', 'running', 'sent', 'accepted', 'skipped', 'failed']);
    if (status && validStatuses.has(status)) {
      where.push('status = ?');
      args.push(status);
    }
    if (olderThanDays > 0) {
      where.push("datetime(created_at) < datetime('now', ?)");
      args.push(`-${olderThanDays} days`);
    }
    if (where.length === 0) {
      return res.status(400).json({ error: 'Provide at least one filter (platform, status, or older_than_days)' });
    }
    const result = db
      .prepare(`DELETE FROM mass_follow_targets WHERE ${where.join(' AND ')}`)
      .run(...args);
    res.json({ deleted: result.changes });
  });
}

module.exports = { registerMassFollowRoutes };
