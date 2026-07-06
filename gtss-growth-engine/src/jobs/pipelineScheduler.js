/**
 * pipelineScheduler.js
 * Reads pipeline_schedules from DB and registers/unregisters cron tasks.
 *
 * Production-grade behaviors added in the pipelines overhaul:
 *   - Single-instance enforcement via pipelineStateService (no duplicate executions)
 *   - Survives application restarts (stateService.recoverOnStartup clears stale 'running' rows)
 *   - Respects schedule-level paused flag (pipeline_<id>_paused)
 *   - Emits structured pipeline_logs entries (via stateService + pipelineLogger)
 *   - Updates pipeline_executions lifecycle (created by runners, finalised here)
 *
 * Call syncFromDb() at startup and after any UI update.
 */
const { getDb } = require('../db/database');
const cronRegistry = require('./cronRegistry');
const { runFullPipeline } = require('../pipeline/pipelineRunner');
const { runContentPipeline } = require('../pipeline/contentPipeline');
const { detectReplies } = require('../services/replyDetector');
const { checkInbox, isCheckingInbox } = require('../services/instagramReplyChecker');
const { isSessionValid } = require('../automation/sessionManager');
const { isScheduledPosterRunning } = require('./scheduledPoster');
const pipelineState = require('../services/pipelineStateService');
const pipelineLogger = require('../services/pipelineLogger');
const logger = require('../utils/logger');

/** Map pipeline id → runner function */
const RUNNERS = {
  outreach: async (limits, options = {}) => {
    const runId = await runFullPipeline(options.trigger || 'cron', {
      limits,
      keywords: options.keywords || [],
      executionId: options.executionId,
      resumeFrom: options.resumeFrom,
    });
    logger.info('PIPELINE-SCHEDULER', `Outreach pipeline run #${runId} complete`);
    return runId;
  },
  content: async (limits, options = {}) => {
    const result = await runContentPipeline({
      ...limits,
      trigger: options.trigger || 'cron',
      executionId: options.executionId,
      resumeFrom: options.resumeFrom,
    });
    const failed =
      result &&
      (result.success === false ||
        (Array.isArray(result.runs) && result.runs.every((run) => run.success === false)));
    if (failed) {
      throw new Error(result.error || 'Content pipeline failed');
    }
  },
  dm_check: async (limits = {}, options = {}) => {
    if (isPipelinePaused('dm_check')) {
      logger.info('PIPELINE-SCHEDULER', 'DM checker skipped: pipeline paused');
      return;
    }
    if (!isWithinActiveHours(limits.active_hours_start, limits.active_hours_end, limits.timezone)) {
      logger.info('PIPELINE-SCHEDULER', 'DM checker skipped: outside active hours');
      return;
    }
    if (isScheduledPosterRunning()) {
      logger.info('PIPELINE-SCHEDULER', 'DM checker skipped: scheduled poster is running');
      return;
    }
    if (isCheckingInbox()) {
      logger.info('PIPELINE-SCHEDULER', 'DM checker skipped: previous Instagram scan is running');
      return;
    }

    const jobId = options.executionId || require('crypto').randomUUID();
    const platforms = Array.isArray(limits.platforms) && limits.platforms.length > 0
      ? limits.platforms
      : ['instagram'];
    pipelineLogger.log({
      pipelineId: 'dm_check',
      executionId: jobId,
      level: 'info',
      stage: 'start',
      message: 'DM inbox checker started',
      context: { platforms },
    });

    let repliesFound = 0;
    for (const platform of platforms) {
      if (pipelineState.isAborted(jobId)) break;
      if (!isSessionValid(platform)) {
        pipelineLogger.log({
          pipelineId: 'dm_check',
          executionId: jobId,
          level: 'warn',
          stage: 'platform',
          message: `Skipping ${platform}: no valid session`,
          context: { platform },
        });
        continue;
      }
      try {
        if (platform === 'instagram') {
          const result = await checkInbox({ prompt: limits.prompt });
          repliesFound += result?.repliesFound || 0;
        } else {
          const result = await detectReplies(platform, () => {}, {
            headless: true,
            allowHeadlessSocial: true,
            trace: false,
          });
          repliesFound += result?.repliesFound || 0;
        }
      } catch (err) {
        pipelineLogger.log({
          pipelineId: 'dm_check',
          executionId: jobId,
          level: 'error',
          stage: 'platform',
          message: `DM check failed on ${platform}: ${err.message}`,
          context: { platform, error: err.message },
        });
      }
    }

    pipelineLogger.log({
      pipelineId: 'dm_check',
      executionId: jobId,
      level: 'success',
      stage: 'complete',
      message: 'DM inbox checker completed',
      context: { repliesFound },
    });
  },
};

function isPipelinePaused(id) {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(`pipeline_${id}_paused`);
  return String(row?.value || 'false') === 'true';
}

function getHourInTimezone(timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(new Date());
    return Number(parts.find((part) => part.type === 'hour')?.value);
  } catch (_) {
    return new Date().getHours();
  }
}

function isWithinActiveHours(start = 0, end = 24, timezone = 'UTC') {
  const startHour = Math.max(0, Math.min(23, Number(start) || 0));
  const endHour = Math.max(1, Math.min(24, Number(end) || 24));
  const hour = getHourInTimezone(timezone);
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

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

/**
 * Run a single pipeline via the state service, with single-instance enforcement.
 *
 * @param {string} pipelineId
 * @param {string} trigger - 'cron' | 'manual' | 'api' | 'retry' | 'resume'
 * @param {Object} limits - limits_json bag
 * @param {Object} [options] - { executionId, resumeFrom, keywords }
 */
async function runPipelineWithLifecycle(pipelineId, trigger, limits, options = {}) {
  if (!pipelineState.canStart(pipelineId, { force: trigger === 'manual' && options.force })) {
    const active = pipelineState.getActiveExecution(pipelineId);
    const message = `Pipeline "${pipelineId}" is already running${active ? ` (execution ${active.id})` : ''} or paused.`;
    pipelineLogger.log({
      pipelineId,
      level: 'warn',
      stage: 'scheduler',
      message,
      context: { trigger, activeExecutionId: active?.id || null },
    });
    throw new Error(message);
  }

  const totalSteps = pipelineId === 'outreach' ? 4 : pipelineId === 'content' ? 4 : 1;
  const exec = pipelineState.createExecution(pipelineId, trigger, {
    startMessage: `Initializing ${pipelineId} pipeline…`,
    totalSteps,
    maxRetries: 3,
    limits,
    resumeFrom: options.resumeFrom || null,
    keywords: options.keywords || null,
    platforms: limits?.platforms || null,
  });

  try {
    const runner = RUNNERS[pipelineId];
    if (!runner) throw new Error(`No runner registered for pipeline "${pipelineId}"`);
    await runner(limits, {
      trigger,
      executionId: exec.id,
      resumeFrom: options.resumeFrom,
      keywords: options.keywords,
    });
    pipelineState.markExecutionCompleted(exec.id);
    return exec.id;
  } catch (err) {
    pipelineState.markExecutionFailed(exec.id, err, err.failedStage || null);
    throw err;
  }
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
  computeNextRun,
  isWithinActiveHours,
  isPipelinePaused,
  runPipelineWithLifecycle,
  __getRunner: (id) => RUNNERS[id],
};
