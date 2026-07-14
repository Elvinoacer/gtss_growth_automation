/**
 * pipelineScheduler/sync.js
 *
 * DB→cron sync and the setPipeline* mutation helpers:
 *   - syncFromDb()                 — read every pipeline_schedules row,
 *                                     compute next_run_at via
 *                                     computeNextRun, register/unregister
 *                                     the cron task accordingly. The cron
 *                                     callback enforces the paused flag
 *                                     and single-instance lock before
 *                                     calling runPipelineWithLifecycle.
 *   - setPipelineEnabled(id, en)   — toggle the enabled flag, then sync
 *   - setPipelineCron(id, cron)    — update the cron expression, then sync
 *   - setPipelineLimits(id, obj)   — update the limits_json bag, then sync
 *
 * Call syncFromDb() at startup and after any UI update.
 *
 * The split files live one directory deeper than the original
 * pipelineScheduler.js, so every `require("../X")` in the original file
 * becomes `require("../../X")` here for paths to ../../db, ../../services,
 * ../../utils, ../cronRegistry, ./cronParsing, ./lifecycle, ./timeHelpers,
 * ./runners.
 */

const { getDb } = require('../../db/database');
const cronRegistry = require('../cronRegistry');
const pipelineState = require('../../services/pipelineStateService');
const pipelineLogger = require('../../services/pipelineLogger');
const logger = require('../../utils/logger');
const { computeNextRun } = require('./cronParsing');
const { isPipelinePaused } = require('./timeHelpers');
const { runPipelineWithLifecycle } = require('./lifecycle');
const { RUNNERS } = require('./runners');

async function syncFromDb() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM pipeline_schedules').all();

  for (const row of rows) {
    const runner = RUNNERS[row.id];
    if (!runner) continue;

    const nextRunAt = row.enabled ? computeNextRun(row.cron) : null;
    db.prepare(`
      UPDATE pipeline_schedules
      SET next_run_at = ?
      WHERE id = ?
    `).run(nextRunAt, row.id);

    if (row.enabled && row.cron) {
      let limits = {};
      try { limits = JSON.parse(row.limits_json || '{}'); } catch (_) {}

      cronRegistry.register(
        `pipeline:${row.id}`,
        row.cron,
        async () => {
          logger.info('PIPELINE-SCHEDULER', `Cron trigger: ${row.name}`);

          // Respect paused flag
          if (isPipelinePaused(row.id)) {
            pipelineLogger.log({
              pipelineId: row.id,
              level: 'info',
              stage: 'scheduler',
              message: `Cron tick skipped: pipeline is paused`,
            });
            return;
          }

          // Single-instance enforcement
          if (pipelineState.getActiveExecution(row.id)) {
            pipelineLogger.log({
              pipelineId: row.id,
              level: 'warn',
              stage: 'scheduler',
              message: `Cron tick skipped: previous execution is still running`,
            });
            return;
          }

          try {
            await runPipelineWithLifecycle(row.id, 'cron', limits);
          } catch (err) {
            logger.error('PIPELINE-SCHEDULER', `${row.name} cron run failed`, err);
          }
        },
        row.name,
      );
    } else {
      cronRegistry.unregister(`pipeline:${row.id}`);
    }
  }
}

/** Enable or disable a pipeline and sync immediately. */
async function setPipelineEnabled(id, enabled) {
  const db = getDb();
  db.prepare(`
    UPDATE pipeline_schedules
    SET enabled = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(enabled ? 1 : 0, id);
  await syncFromDb();
}

/** Update cron expression and sync. */
async function setPipelineCron(id, cronExpression) {
  const db = getDb();
  db.prepare(`
    UPDATE pipeline_schedules
    SET cron = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(cronExpression, id);
  await syncFromDb();
}

/** Update limits JSON bag. */
async function setPipelineLimits(id, limitsObj) {
  const db = getDb();
  db.prepare(`
    UPDATE pipeline_schedules
    SET limits_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(limitsObj), id);
  await syncFromDb();
}

module.exports = {
  syncFromDb,
  setPipelineEnabled,
  setPipelineCron,
  setPipelineLimits,
};
