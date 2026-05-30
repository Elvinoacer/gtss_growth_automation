/**
 * pipelineScheduler.js
 * Reads pipeline_schedules from DB and registers/unregisters cron tasks.
 * Call syncFromDb() at startup and after any UI update.
 */
const { getDb } = require('../db/database');
const cronRegistry = require('./cronRegistry');
const { runFullPipeline } = require('../pipeline/pipelineRunner');
const { runContentPipeline } = require('../pipeline/contentPipeline'); // Phase 3
const logger = require('../utils/logger');

/** Map pipeline id → runner function */
const RUNNERS = {
  outreach: async (limits) => {
    const runId = await runFullPipeline('cron', { limits });
    logger.info('PIPELINE-SCHEDULER', `Outreach pipeline run #${runId} complete`);
  },
  content: async (limits) => {
    const result = await runContentPipeline({ ...limits, trigger: 'cron' });
    const failed =
      result &&
      (result.success === false ||
        (Array.isArray(result.runs) && result.runs.every((run) => run.success === false)));
    if (failed) {
      throw new Error(result.error || 'Content pipeline failed');
    }
  },
};

function parseCronField(field, min, max) {
  const allowed = new Set();
  const parts = String(field || '').split(',');

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) return null;

    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) return null;

    let start;
    let end;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [rawStart, rawEnd] = rangePart.split('-').map(Number);
      start = rawStart;
      end = rawEnd;
    } else {
      start = Number(rangePart);
      end = Number(rangePart);
    }

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      return null;
    }

    for (let value = start; value <= end; value += step) {
      allowed.add(value);
    }
  }

  return allowed;
}

function computeNextRun(cronExpression, fromDate = new Date()) {
  const parts = String(cronExpression || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minuteField, hourField, dayField, monthField, dowField] = parts;
  const minutes = parseCronField(minuteField, 0, 59);
  const hours = parseCronField(hourField, 0, 23);
  const days = parseCronField(dayField, 1, 31);
  const months = parseCronField(monthField, 1, 12);
  const dows = parseCronField(dowField.replace(/\b7\b/g, '0'), 0, 6);
  if (!minutes || !hours || !days || !months || !dows) return null;

  const candidate = new Date(fromDate.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxChecks = 366 * 24 * 60;
  for (let i = 0; i < maxChecks; i += 1) {
    if (
      minutes.has(candidate.getMinutes()) &&
      hours.has(candidate.getHours()) &&
      days.has(candidate.getDate()) &&
      months.has(candidate.getMonth() + 1) &&
      dows.has(candidate.getDay())
    ) {
      return candidate.toISOString();
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

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
          // Mark as running
          db.prepare(`
            UPDATE pipeline_schedules
            SET last_run_at = CURRENT_TIMESTAMP, last_status = 'running'
            WHERE id = ?
          `).run(row.id);

          // Broadcast running status via Socket.IO
          try {
            const { broadcast } = require('../services/socketService');
            broadcast('pipeline:status', {
              id: row.id,
              status: 'running',
              last_run_at: new Date().toISOString(),
            });
          } catch (_) {}

          try {
            await runner(limits);
            db.prepare(`
              UPDATE pipeline_schedules
              SET last_status = 'completed', run_count = run_count + 1,
                  next_run_at = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(computeNextRun(row.cron), row.id);

            // Broadcast completed status
            try {
              const { broadcast } = require('../services/socketService');
              broadcast('pipeline:status', {
                id: row.id,
                status: 'completed',
                last_run_at: new Date().toISOString(),
              });
            } catch (_) {}
          } catch (err) {
            logger.error('PIPELINE-SCHEDULER', `${row.name} failed`, err);
            db.prepare(`
              UPDATE pipeline_schedules
              SET last_status = 'failed', next_run_at = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(computeNextRun(row.cron), row.id);

            // Broadcast failed status
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
  computeNextRun,
};
