/**
 * platformAdapter/index.js — Re-export entry point for the platform adapter
 * module.
 *
 * Preserves the exact `module.exports = { runConnectionAction, runDmAction }`
 * surface of the original `platformAdapter.js` (655 lines) so every in-tree
 * caller — `require("../platformAdapter")` from src/campaign/dmQueue/ and
 * src/campaign/connectionQueue/, `require("../../campaign/platformAdapter")`
 * from src/pipeline/massFollowPipeline/ and src/jobs/backgroundJobs/ — keeps
 * resolving unchanged via Node.js directory-index resolution.
 *
 * Split files in this directory:
 *   helpers.js              — getInstagramUsername + getEmitCallback +
 *                             classifyAndNormalizeError (shared by both
 *                             action runners)
 *   runConnectionAction.js  — runConnectionAction (per-platform connection
 *                             action dispatcher: linkedin/instagram/x/
 *                             facebook/tiktok)
 *   runDmAction.js          — runDmAction (per-platform DM action dispatcher:
 *                             linkedin/instagram/x/facebook/tiktok)
 */

const { runConnectionAction } = require("./runConnectionAction");
const { runDmAction } = require("./runDmAction");

module.exports = {
  runConnectionAction,
  runDmAction,
};
