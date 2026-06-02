/**
 * Send Pipeline — Stage 4 of the Pipeline Orchestrator
 *
 * Thin wrapper around the existing executor.js processActionQueue().
 * Checks platform sessions, then delegates the actual send/retry/CAPTCHA
 * logic to the executor which already handles all of that robustly.
 */

const crypto = require('crypto');
const {
  enqueueActionQueue,
  getQueuedActions,
  isWithinLimit,
} = require('../automation/executor');
const { isSessionValid } = require('../automation/sessionManager');
const { getPlatformKeys } = require('../services/platformCatalog');
const logger = require('../utils/logger');

/**
 * Run the send stage of the pipeline.
 *
 * 1. Check platform sessions — skip platforms without a valid session
 * 2. Check if any approved messages are ready to send
 * 3. Delegate to the executor's processActionQueue() which handles
 *    sessions, limits, CAPTCHA, retries, and cooldowns
 *
 * @param {number} pipelineRunId - Pipeline run ID for tracking
 * @param {Function} emit - Event emitter for pipeline SSE stream
 * @returns {Promise<{sent: number, failed: number, skipped: number, limitReached: boolean}>}
 */
async function runSendStage(
  pipelineRunId,
  emit,
  maxDmsPerRun,
  platforms = [],
  maxConnectionsPerRun,
) {
  const selectedPlatforms = Array.isArray(platforms)
    ? platforms.map((platform) => String(platform).trim().toLowerCase()).filter(Boolean)
    : [];
  // ── 1. Check the queue ──────────────────────────────────────────────────
  const queue = getQueuedActions({ platforms: selectedPlatforms });

  if (queue.length === 0) {
    emit({ type: 'info', message: 'No approved messages ready to send.' });
    return { sent: 0, failed: 0, skipped: 0, limitReached: false };
  }

  // Identify platforms that actually have queued/runnable actions
  const platformsWithQueuedActions = [...new Set(queue.map(a => a.platform))];

  // ── 2. Check platform sessions ──────────────────────────────────────────
  const platformsToCheck = platformsWithQueuedActions.length > 0
    ? platformsWithQueuedActions
    : getPlatformKeys();

  const activePlatforms = [];
  const inactivePlatforms = [];

  for (const platform of platformsToCheck) {
    if (isSessionValid(platform)) {
      activePlatforms.push(platform);
    } else {
      inactivePlatforms.push(platform);
    }
  }

  if (inactivePlatforms.length > 0) {
    emit({
      type: 'warn',
      message: `No valid session for: ${inactivePlatforms.join(', ')}. Messages for these platforms will be skipped.`,
    });
  }

  if (activePlatforms.length === 0) {
    emit({
      type: 'error',
      message: 'No platform with pending messages has a valid session. Aborting send stage. Please re-authenticate the required platforms.',
    });
    return { sent: 0, failed: 0, skipped: 0, limitReached: false };
  }

  // Check for limit-reached platforms
  let limitReached = false;
  for (const platform of activePlatforms) {
    if (!isWithinLimit(platform, 'dms')) {
      emit({
        type: 'warn',
        message: `Daily DM limit reached for ${platform}. Some messages may be skipped.`,
      });
      limitReached = true;
    }
  }

  const runnableCount = queue.filter(a => a.runnable).length;
  emit({
    type: 'info',
    message: `Send stage: ${runnableCount} runnable actions in queue across ${activePlatforms.length} platform(s). Delegating to executor.`,
  });

  // ── 3. Delegate to executor ─────────────────────────────────────────────
  // The executor handles everything: browser sessions, CAPTCHA detection,
  // action execution, retry logic, snooze scheduling, and outcome recording.
  const jobId = crypto.randomUUID();

  try {
    const summary = await enqueueActionQueue(jobId, null, {
      maxDmsPerRun,
      maxConnectionsPerRun,
      platforms: selectedPlatforms,
    });
    const sent = summary?.successes || 0;
    const failed = summary?.failures || 0;
    const skipped = summary?.skipped || 0;

    emit({
      type: 'complete',
      message: `Send stage complete: ${sent} sent, ${failed} failed, ${skipped} skipped`,
    });

    return { sent, failed, skipped, limitReached };
  } catch (err) {
    logger.error('PIPELINE', 'Executor error during send stage', { error: err.message });
    emit({ type: 'error', message: `Executor error: ${err.message}` });
  }

  return { sent: 0, failed: 1, skipped: 0, limitReached };
}

module.exports = {
  runSendStage,
};
