/**
 * pipelineScheduler/index.js — Public entry point for
 * `require("../jobs/pipelineScheduler")`.
 *
 * Preserves the EXACT module.exports surface of the original
 * pipelineScheduler.js monolith:
 *
 *   module.exports = {
 *     syncFromDb,
 *     setPipelineEnabled,
 *     setPipelineCron,
 *     setPipelineLimits,
 *     computeNextRun,
 *     isWithinActiveHours,
 *     isPipelinePaused,
 *     runPipelineWithLifecycle,
 *     runExistingExecution,
 *     __getRunner: (id) => RUNNERS[id],
 *   };
 *
 * The split files live one directory deeper than the original
 * pipelineScheduler.js, so every `require("../X")` in the original file
 * became `require("../../X")` in the split files for paths to ../../db,
 * ../../pipeline, ../../services, ../../automation, ../../utils, and
 * `require("./X")` for paths to ../cronRegistry, ../jobRegistry,
 * ../scheduledPoster (now ./X within the split dir for timeHelpers /
 * cronParsing / runners / lifecycle / sync).
 *
 * File manifest:
 *   timeHelpers.js   — isPipelinePaused, getHourInTimezone, isWithinActiveHours
 *   cronParsing.js   — parseCronField, computeNextRun (pure, no I/O)
 *   runners.js       — RUNNERS map (outreach, content, mass_follow, dm_check)
 *   lifecycle.js     — runPipelineWithLifecycle, runExistingExecution
 *   sync.js          — syncFromDb, setPipelineEnabled, setPipelineCron,
 *                      setPipelineLimits
 *   index.js         — this file
 */

const { syncFromDb, setPipelineEnabled, setPipelineCron, setPipelineLimits } = require('./sync');
const { computeNextRun } = require('./cronParsing');
const { isWithinActiveHours, isPipelinePaused } = require('./timeHelpers');
const { runPipelineWithLifecycle, runExistingExecution } = require('./lifecycle');
const { RUNNERS } = require('./runners');

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
