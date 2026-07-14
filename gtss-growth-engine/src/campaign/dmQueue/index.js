/**
 * DM Queue — Public API
 *
 * Re-exports the exact module.exports surface of the original dmQueue.js so
 * that downstream `require("../campaign/dmQueue")` calls continue to resolve
 * transparently to this directory's index file.
 *
 * Public exports:
 *   - processDmQueue     — main per-lead processing loop
 *   - stopDmQueue        — set the global stop flag (called by automation route)
 *   - resetDmQueueStopFlag — clear the stop flag (called at start of each run)
 *   - isDmQueueStopped   — read the stop flag (polled in-loop + in sleep())
 *
 * Side-effect on require: ensureDmJobsSchema(db) is invoked from
 * ./processDmQueue to add the `retry_count` and `next_retry_at` columns to
 * the `dm_jobs` table if missing (preserves the original module-load behavior).
 */

const { processDmQueue } = require("./processDmQueue");
const { stopDmQueue, resetDmQueueStopFlag, isDmQueueStopped } = require("./stopFlag");

module.exports = {
  processDmQueue,
  stopDmQueue,
  resetDmQueueStopFlag,
  isDmQueueStopped,
};
