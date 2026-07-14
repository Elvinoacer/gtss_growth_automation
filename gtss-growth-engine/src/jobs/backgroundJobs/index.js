/**
 * backgroundJobs/index.js
 *
 * Re-exports the EXACT same module.exports surface as the original
 * backgroundJobs.js:
 *
 *   {
 *     startBackgroundJobs,
 *     isCampaignQueueRunning,
 *     isCampaignQueueInProgress: isCampaignQueueRunning,  // alias
 *     __private: { runConnectionQueueJob, runDmQueueJob }
 *   }
 *
 * Plus the same module-load side effects as the original:
 *   1. require("dotenv").config() — load .env into process.env.
 *   2. installPlatformAdapterTracking() — monkey-patch
 *      platformAdapter.runConnectionAction / runDmAction to set
 *      state.currentPlatform on every call (the require of
 *      ./platformAdapterWrappers runs install at first load).
 *   3. process.on("SIGINT") / process.on("SIGTERM") — register the
 *      gracefulShutdown handler so the worker exits cleanly on signal.
 *   4. If this module is the run-main AND DISABLE_BACKGROUND_JOBS !==
 *      "true", call startBackgroundJobs() to register the crons and
 *      start the worker.
 *
 * Every in-tree caller that did `require("../jobs/backgroundJobs")`
 * continues to resolve to this index.js (Node.js directory-index
 * resolution). The split files live one directory deeper than the
 * original, so every `require("../X")` in the original file became
 * `require("../../X")` in the split files for paths to ../../db,
 * ../../automation, ../../services, ../../campaign, ../../utils. Same-
 * directory sibling requires to ../instagramWarmupJob,
 * ../scheduledPoster, ../pipelineScheduler stay one-level (`../X`).
 */

require("dotenv").config();

// The require itself triggers installPlatformAdapterTracking() as a
// module-load side effect (matching the original backgroundJobs.js).
require("./platformAdapterWrappers");

const { startBackgroundJobs } = require("./startBackgroundJobs");
const { gracefulShutdown } = require("./gracefulShutdown");
const { isCampaignQueueRunning } = require("./state");
const { runConnectionQueueJob } = require("./runConnectionQueueJob");
const { runDmQueueJob } = require("./runDmQueueJob");

// Always register the signal handlers on require (matches the original,
// which registered them unconditionally — even when required as a non-main
// module, so the parent process can forward signals to us and we'll
// clean up the browsers correctly).
process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

// Self-invoke startBackgroundJobs() when run as the entry point (e.g.
// `node src/jobs/backgroundJobs.js` or the desktop launcher spawning us
// as a child process). DISABLE_BACKGROUND_JOBS env lets the test runner
// or the parent process suppress the auto-start.
if (require.main === module && process.env.DISABLE_BACKGROUND_JOBS !== "true") {
  startBackgroundJobs();
}

module.exports = {
  startBackgroundJobs,
  isCampaignQueueRunning,
  isCampaignQueueInProgress: isCampaignQueueRunning,
  __private: {
    runConnectionQueueJob,
    runDmQueueJob,
  },
};
