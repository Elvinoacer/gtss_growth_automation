/**
 * massFollowPipeline/index.js
 *
 * Barrel module that re-exports the EXACT same module.exports surface as the
 * original massFollowPipeline.js. Existing require('./massFollowPipeline')
 * callers resolve transparently to this file via Node.js's directory-index
 * resolution.
 *
 * Public API:
 *   - runMassFollowPipeline     Public entry point (wraps the runner in pipelineQueue)
 *   - runMassFollowPipelineNow  Bypass the queue (used by runMassFollowPipeline + tests)
 *   - MASS_FOLLOW_STAGES        ["select_targets", "follow", "report"]
 *   - SUPPORTED_PLATFORMS       Set{"instagram","x","linkedin","facebook"}
 *
 * Private API (under _internal — preserved for test introspection):
 *   - selectTargetsBatch
 *   - recordOutcome
 *   - isWithinActiveWindow
 *   - getDailyFollowCount
 *   - getHourlyFollowCount
 *   - getWeeklyFollowCount
 *   - getEffectiveDailyLimit
 *   - getEffectiveHourlyLimit
 *   - getEffectiveWeeklyLimit
 *   - isRateLimitResult
 */

const {
  MASS_FOLLOW_STAGES,
  SUPPORTED_PLATFORMS,
  isWithinActiveWindow,
} = require("./shared");
const {
  getDailyFollowCount,
  getHourlyFollowCount,
  getWeeklyFollowCount,
  getEffectiveDailyLimit,
  getEffectiveHourlyLimit,
  getEffectiveWeeklyLimit,
  isRateLimitResult,
} = require("./followLimits");
const { selectTargetsBatch } = require("./selectTargetsBatch");
const { recordOutcome } = require("./recordOutcome");
const { runMassFollowPipelineNow } = require("./runMassFollowPipelineNow");
const { runMassFollowPipeline } = require("./runMassFollowPipeline");

module.exports = {
  runMassFollowPipeline,
  runMassFollowPipelineNow,
  MASS_FOLLOW_STAGES,
  SUPPORTED_PLATFORMS,
  // Exported for tests
  _internal: {
    selectTargetsBatch,
    recordOutcome,
    isWithinActiveWindow,
    getDailyFollowCount,
    getHourlyFollowCount,
    getWeeklyFollowCount,
    getEffectiveDailyLimit,
    getEffectiveHourlyLimit,
    getEffectiveWeeklyLimit,
    isRateLimitResult,
  },
};
