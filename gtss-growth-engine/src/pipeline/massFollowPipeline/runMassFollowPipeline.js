/**
 * massFollowPipeline/runMassFollowPipeline.js
 *
 * Public entry point for the mass-follow pipeline. Wraps the actual run
 * (runMassFollowPipelineNow) in the global pipeline queue so only one
 * pipeline runs process-wide at a time. Mirrors
 * contentPipeline.runContentPipeline.
 */

const logger = require("../../utils/logger");
const { enqueuePipelineRun } = require("../pipelineQueue");
const { runMassFollowPipelineNow } = require("./runMassFollowPipelineNow");

/**
 * Public entry point — wraps the actual run in the global pipeline queue so
 * only one pipeline runs process-wide at a time (mirrors
 * contentPipeline.runContentPipeline).
 */
async function runMassFollowPipeline(config = {}) {
  return enqueuePipelineRun(
    "mass_follow",
    `mass_follow:${config.trigger || "manual"}:${Date.now()}`,
    () => runMassFollowPipelineNow(config),
    {
      onQueued: ({ position, activeRun }) => {
        logger.info(
          "MASS-FOLLOW-PIPELINE",
          `Mass-follow pipeline queued at position ${position}; waiting for active run to finish`,
          { activeRun },
        );
      },
    },
  );
}

module.exports = { runMassFollowPipeline };
