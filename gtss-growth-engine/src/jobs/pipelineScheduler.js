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
const jobRegistry = require('./jobRegistry');
const { runFullPipeline } = require('../pipeline/pipelineRunner');
const { runContentPipeline } = require('../pipeline/contentPipeline');
const { runMassFollowPipeline } = require('../pipeline/massFollowPipeline');
const { runTikTokMassFollowPipeline } = require('../pipeline/tiktokMassFollowPipeline');
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
  mass_follow: async (limits, options = {}) => {
    const result = await runMassFollowPipeline({
      ...limits,
      trigger: options.trigger || 'cron',
      executionId: options.executionId,
      resumeFrom: options.resumeFrom,
    });
    if (result && result.success === false) {
      // 'No supported platforms configured' and 'No eligible targets' are
      // treated as soft-skips — we don't want to flip the pipeline to
      // 'failed' just because the user hasn't added targets yet. Only throw
      // on genuine errors.
      const softErrors = new Set([
        'No supported platforms configured',
        'No eligible targets',
      ]);
      if (!softErrors.has(result.error)) {
        throw new Error(result.error || 'Mass-follow pipeline failed');
      }
      logger.info(
        'PIPELINE-SCHEDULER',
        `Mass-follow pipeline soft-skipped: ${result.error}`,
      );
    }
  },
  tiktok_mass_follow: async (limits, options = {}) => {
    const result = await runTikTokMassFollowPipeline({
      ...limits,
      trigger: options.trigger || 'cron',
      executionId: options.executionId,
      resumeFrom: options.resumeFrom,
    });
    if (result && result.success === false) {
      // Soft-skip conditions — don't flip the pipeline to 'failed' just
      // because the user hasn't configured a search query yet, or the run
      // was outside the active window, or the daily/hourly cap was hit.
      const softErrors = new Set([
        'No search_query configured',
      ]);
      if (!softErrors.has(result.error) && !(result.summary && result.summary.skipped)) {
        throw new Error(result.error || 'TikTok mass-follow pipeline failed');
      }
      logger.info(
        'PIPELINE-SCHEDULER',
        `TikTok mass-follow pipeline soft-skipped: ${result.error || (result.summary && result.summary.reason) || 'skipped'}`,
      );
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

    // Register the job so force-clear / stop can abort it via the
    // jobRegistry. Without this, the dm_check runner has no
    // AbortController and force-clear's stopJobsByPipeline finds nothing
    // to abort — so a stuck Instagram scan can only be killed by
    // restarting the server.
    const controller = jobRegistry.startJob(jobId, {
      pipelineId: 'dm_check',
      type: 'dm_check',
      stage: 'scan',
    });
    const signal = controller.signal;

    pipelineLogger.log({
      pipelineId: 'dm_check',
      executionId: jobId,
      level: 'info',
      stage: 'start',
      message: 'DM inbox checker started',
      context: { platforms },
    });

    let repliesFound = 0;
    try {
      for (const platform of platforms) {
        if (pipelineState.isAborted(jobId) || signal.aborted) break;
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
          // If the abort signal fired, don't log it as an error —
          // it's an expected consequence of the user clicking Stop.
          if (pipelineState.isAborted(jobId) || signal.aborted) break;
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
        level: pipelineState.isAborted(jobId) || signal.aborted ? 'warn' : 'success',
        stage: 'complete',
        message: pipelineState.isAborted(jobId) || signal.aborted
          ? 'DM inbox checker aborted by user'
          : 'DM inbox checker completed',
        context: { repliesFound },
      });
    } finally {
      jobRegistry.finishJob(jobId);
    }
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
  // `force: true` means "auto-clear any stuck execution before running".
  // We only auto-clear when the active execution is NOT making progress
  // (i.e., genuinely stuck). If it IS progressing, we refuse with a clear
  // error so the user doesn't accidentally interrupt real work.
  const wantsForce = trigger === 'manual' && options.force;
  if (!pipelineState.canStart(pipelineId, { force: wantsForce })) {
    const active = pipelineState.getActiveExecution(pipelineId);
    if (active && pipelineState.isExecutionProgressing(pipelineId)) {
      // Genuinely running — refuse with a clear error.
      const message = `Pipeline "${pipelineId}" is already running (execution ${active.id}). Wait for it to finish, or click Stop / Force Clear first.`;
      pipelineLogger.log({
        pipelineId,
        level: 'warn',
        stage: 'scheduler',
        message,
        context: { trigger, activeExecutionId: active.id },
      });
      throw new Error(message);
    }
    // Stuck — auto-clear and proceed.
    if (active) {
      pipelineLogger.log({
        pipelineId,
        level: 'warn',
        stage: 'scheduler',
        message: `Auto force-clearing stuck execution ${active.id} before ${trigger} run.`,
        context: { trigger, activeExecutionId: active.id },
      });
      pipelineState.forceClearExecution(pipelineId, `${trigger} (auto-cleared stale execution)`);
    }
  }

  const totalSteps = pipelineId === 'outreach' ? 4 : pipelineId === 'content' ? 4 : (pipelineId === 'mass_follow' || pipelineId === 'tiktok_mass_follow') ? 3 : 1;
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

/**
 * Re-run an EXISTING execution (used by retry-stage and resume-from-checkpoint).
 *
 * Unlike runPipelineWithLifecycle, this does NOT create a new
 * pipeline_executions row — it reuses the provided executionId. This is
 * the public API that the retry-stage and resume-from-checkpoint routes
 * should use, replacing the previous pattern of calling __getRunner +
 * __setActive directly (which were private APIs and easy to misuse).
 *
 * @param {string} pipelineId
 * @param {string} executionId - existing execution to re-run
 * @param {string} trigger - 'retry' | 'resume'
 * @param {Object} limits - limits_json bag
 * @param {Object} [options] - { resumeFrom, keywords }
 */
async function runExistingExecution(pipelineId, executionId, trigger, limits, options = {}) {
  if (!pipelineId || !executionId) {
    throw new Error('pipelineId and executionId are required');
  }
  const runner = RUNNERS[pipelineId];
  if (!runner) throw new Error(`No runner registered for pipeline "${pipelineId}"`);

  // Re-arm the in-memory ACTIVE_EXECUTIONS map for this existing
  // executionId. Without this, the runner's throwIfAborted / awaitResume
  // / updateExecutionProgress calls would no-op (because the
  // executionId is no longer in the map after the previous run
  // terminated).
  pipelineState.__setActive(pipelineId, executionId);

  // Transition the execution row to 'running' so the UI shows the
  // correct state. If the transition fails (e.g., the row is in a
  // terminal state and the state machine refuses), we log and proceed
  // anyway — the runner will still update progress.
  try {
    pipelineState.transitionExecution(executionId, pipelineState.STATES.RUNNING);
  } catch (err) {
    pipelineLogger.log({
      pipelineId,
      executionId,
      level: 'warn',
      stage: 'scheduler',
      message: `Could not transition execution to RUNNING: ${err.message}`,
      context: { trigger },
    });
  }

  try {
    await runner(limits, {
      trigger,
      executionId,
      resumeFrom: options.resumeFrom,
      keywords: options.keywords,
    });
    pipelineState.markExecutionCompleted(executionId);
    return executionId;
  } catch (err) {
    pipelineState.markExecutionFailed(executionId, err, err.failedStage || null);
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
  runExistingExecution,
  __getRunner: (id) => RUNNERS[id],
};
