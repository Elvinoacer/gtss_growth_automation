/**
 * Connection Queue — Public API
 *
 * Re-exports the exact module.exports surface of the original
 * connectionQueue.js so that downstream `require("../campaign/connectionQueue")`
 * calls continue to resolve transparently to this directory's index file.
 *
 * Public exports:
 *   - processConnectionQueue          — main per-job processing loop
 *   - stopConnectionQueue             — set the global stop flag (called by automation route)
 *   - resetConnectionQueueStopFlag    — clear the stop flag (called at start of each run)
 *   - isConnectionQueueStopped        — read the stop flag (polled in-loop + in sleep())
 *
 * Side-effect on require: ensureConnectionJobsSchema(db) is invoked from
 * ./processConnectionQueue to add the `retry_count` and `next_retry_at`
 * columns to the `connection_jobs` table if missing (preserves the original
 * module-load behavior).
 *
 * Mirrors the dmQueue/index.js pattern from Task 6.
 *
 * Extracted from the original connectionQueue.js for maintainability.
 */

const { processConnectionQueue } = require("./processConnectionQueue");
const {
  stopConnectionQueue,
  resetConnectionQueueStopFlag,
  isConnectionQueueStopped,
} = require("./stopFlag");

module.exports = {
  processConnectionQueue,
  stopConnectionQueue,
  resetConnectionQueueStopFlag,
  isConnectionQueueStopped,
};
