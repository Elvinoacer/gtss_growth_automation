/**
 * contentPipeline/index.js
 *
 * Re-exports the EXACT same module.exports surface as the original
 * contentPipeline.js — a single public function:
 *
 *   { runContentPipeline }
 *
 * (runContentPipelineNow is intentionally NOT exported — it was never
 * in the original module.exports and the only in-tree caller is
 * runContentPipeline itself + the pipelineScheduler via runContentPipeline.)
 *
 * Every in-tree caller that did `require("../pipeline/contentPipeline")`
 * (notably pipelineScheduler.js) continues to resolve to this index.js
 * (Node.js directory-index resolution). The split files live one
 * directory deeper than the original, so every `require("../X")` in
 * the original file became `require("../../X")` in the split files
 * for paths to ../../db, ../../services, ../../jobs, ../../utils.
 * Same-directory sibling requires to ../pipelineQueue stay one-level
 * (`../X`).
 */

const { runContentPipeline } = require("./runContentPipeline");

module.exports = { runContentPipeline };
