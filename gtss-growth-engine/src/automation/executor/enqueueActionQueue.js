/**
 * Executor — enqueueActionQueue (Serialized Run Queue)
 *
 * enqueueActionQueue(jobId, sseRes, options) chains a new processActionQueue
 * call onto the global RUN_QUEUE so that automation runs never overlap
 * (even when triggered from multiple routes / jobs at once). Returns a
 * promise that resolves with the run's summary (or rejects on error — the
 * rejection is also swallowed into the next RUN_QUEUE link so a single
 * failed run doesn't break the chain).
 *
 * Extracted from the original automation/executor.js for maintainability.
 */

const logger = require('../../utils/logger');
const { runtimeState } = require('./state');
const { processActionQueue } = require('./processActionQueue');

function enqueueActionQueue(jobId, sseRes, options = {}) {
  const run = () => processActionQueue(jobId, sseRes, options);
  const queuedRun = runtimeState.RUN_QUEUE.then(run, run);
  runtimeState.RUN_QUEUE = queuedRun.catch((error) => {
    logger.error('AUTOMATION', 'Queued automation run failed', error);
  });
  return queuedRun;
}

module.exports = { enqueueActionQueue };
