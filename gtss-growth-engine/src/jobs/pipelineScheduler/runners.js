/**
 * pipelineScheduler/runners.js
 *
 * The RUNNERS map: pipeline id → runner function. Each runner is the
 * actual work function called by `runPipelineWithLifecycle` /
 * `runExistingExecution`. Runners receive (limits, options) where:
 *   - limits    = the limits_json bag from pipeline_schedules (parsed)
 *   - options   = { trigger, executionId, resumeFrom, keywords }
 *
 * Runners:
 *   - outreach      — calls runFullPipeline (the 4-stage outreach pipeline)
 *   - content       — calls runContentPipeline (content generation + scheduling)
 *   - mass_follow   — calls runMassFollowPipeline (targeted follow runs)
 *   - dm_check      — checks each platform's DM inbox for replies; uses
 *                     isPipelinePaused + isWithinActiveHours (timeHelpers)
 *                     and isScheduledPosterRunning + isCheckingInbox
 *                     (mutexes) to skip when overlap would cause issues.
 *                     Registers with jobRegistry so a stuck scan can be
 *                     force-cleared via the Stop / Force-Clear UI.
 *
 * The split files live one directory deeper than the original
 * pipelineScheduler.js, so every `require("../X")` in the original file
 * becomes `require("../../X")` here for paths to ../../db, ../../pipeline,
 * ../../services, ../../automation, ../jobRegistry, ./timeHelpers.
 */

const crypto = require('crypto');
const jobRegistry = require('../jobRegistry');
const { runFullPipeline } = require('../../pipeline/pipelineRunner');
const { runContentPipeline } = require('../../pipeline/contentPipeline');
const { runMassFollowPipeline } = require('../../pipeline/massFollowPipeline');
const { detectReplies } = require('../../services/replyDetector');
const { checkInbox, isCheckingInbox } = require('../../services/instagramReplyChecker');
const { isSessionValid } = require('../../automation/sessionManager');
const { isScheduledPosterRunning } = require('../scheduledPoster');
const pipelineState = require('../../services/pipelineStateService');
const pipelineLogger = require('../../services/pipelineLogger');
const logger = require('../../utils/logger');
const { isPipelinePaused, isWithinActiveHours } = require('./timeHelpers');

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
      // Cron runs can soft-skip when the user has not added targets yet.
      // Manual/API runs must surface this as an actionable error instead of
      // briefly showing "triggered manually" and then "completed".
      const softErrors = new Set([
        'No supported platforms configured',
        'No eligible targets',
      ]);
      const isCronSoftSkip = (options.trigger || 'cron') === 'cron' && softErrors.has(result.error);
      if (!isCronSoftSkip) {
        throw new Error(result.error || 'Mass-follow pipeline failed');
      }
      logger.info(
        'PIPELINE-SCHEDULER',
        `Mass-follow pipeline soft-skipped: ${result.error}`,
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

    const jobId = options.executionId || crypto.randomUUID();
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

module.exports = { RUNNERS };
