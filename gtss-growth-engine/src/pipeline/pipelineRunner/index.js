/**
 * pipelineRunner/index.js
 *
 * Re-exports the EXACT same module.exports surface as the original
 * pipelineRunner.js — so every in-tree caller that did
 * `require("../pipeline/pipelineRunner")` continues to resolve to this
 * index.js (Node.js directory-index resolution) and gets the same 9
 * functions.
 *
 * The split files live one directory deeper than the original, so every
 * `require("../X")` in the original file became `require("../../X")` in
 * the split files (paths from src/pipeline/ to src/services/X, src/db/X,
 * src/config/X, src/utils/X, src/jobs/X all need an extra "../" hop).
 */

const {
  runFullPipeline,
} = require("./runFullPipeline");
const {
  abortPipelineRun,
  isPipelineAborted,
  pausePipelineRun,
  resumePipelineRun,
} = require("./state");
const {
  registerPipelineStream,
  closePipelineStream,
} = require("./pipelineStream");
const { getPipelineRun, listPipelineRuns } = require("./pipelineRuns");

module.exports = {
  runFullPipeline,
  abortPipelineRun,
  isPipelineAborted,
  pausePipelineRun,
  resumePipelineRun,
  getPipelineRun,
  listPipelineRuns,
  registerPipelineStream,
  closePipelineStream,
};
