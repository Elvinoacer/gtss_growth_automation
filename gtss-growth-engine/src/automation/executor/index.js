/**
 * Executor — Index / Aggregator
 *
 * Re-exports the EXACT module.exports surface of the original
 * automation/executor.js so that every existing caller
 * (routes/api.js, routes/automation.js, pipeline/sendPipeline.js,
 * server.js, jobs/backgroundJobs.js) continues to work unchanged.
 *
 *   require('./automation/executor')
 *     → { processActionQueue, enqueueActionQueue, stopJob, stopAllJobs,
 *         authenticatePlatform, isManualAuthComplete, getQueuedActions,
 *         runAutomationAction, isWithinLimit, determineActionType,
 *         normalizeQueuedActionType, getLinkedInOutreachMode, getXOutreachMode }
 *
 * Extracted from the original automation/executor.js for maintainability.
 */

const { processActionQueue } = require('./processActionQueue');
const { enqueueActionQueue } = require('./enqueueActionQueue');
const { stopJob, stopAllJobs } = require('./state');
const { authenticatePlatform } = require('./authenticatePlatform');
const { isManualAuthComplete } = require('./sessionCheck');
const { getQueuedActions } = require('./queuedActions');
const { runAutomationAction } = require('./actionRouting');
const { isWithinLimit } = require('./limits');
const {
  determineActionType,
  normalizeQueuedActionType,
  getLinkedInOutreachMode,
  getXOutreachMode,
} = require('./actionTypes');

module.exports = {
  processActionQueue,
  enqueueActionQueue,
  stopJob,
  stopAllJobs,
  authenticatePlatform,
  isManualAuthComplete,
  getQueuedActions,
  runAutomationAction,
  isWithinLimit,
  determineActionType,
  normalizeQueuedActionType,
  getLinkedInOutreachMode,
  getXOutreachMode,
};
