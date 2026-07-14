/**
 * campaigns/index.js
 *
 * Public entry point for `require("../routes/campaigns")`.
 *
 * Preserves the EXACT module.exports surface of the original
 * campaigns.js monolith:
 *   module.exports        = <express.Router>   // API router (all /api/campaigns routes)
 *   module.exports.pageRouter = <express.Router>  // page-views router (/campaigns, /campaigns/:id)
 *
 * The split files live one directory deeper than the original, so every
 * `require("../X")` in the original file became `require("../../X")`
 * here for paths to ../../db, ../../utils, ../../campaign, ../../jobs,
 * ../../services. The relative path to the sibling `../pageRenderer`
 * module became `../pageRenderer` (unchanged — pageRouter.js lives at
 * the same depth as the original campaigns.js relative to pageRenderer).
 *
 * The split files don't require their own deps at module-load time —
 * instead, they receive a `requireDeps()` thunk via the `register()`
 * call. This keeps all path-resolution in one place (this index.js) so
 * each split file is purely a route-registration function, decoupled
 * from where the deps live on disk.
 *
 * File manifest:
 *   createAndLifecycle.js  — POST /  POST /:id/pause  POST /:id/resume
 *   queries.js             — GET /  GET /:id  GET /:id/events
 *   jobs.js                — GET /:id/connection-jobs  GET /:id/dm-jobs
 *   stream.js              — GET /:id/stream (SSE)
 *   queueControls.js       — POST /run-connection-queue  POST /run-dm-queue
 *                            POST /stop-queue  GET /queue-status/lock
 *   pageRouter.js          — buildPageRouter() → /campaigns + /campaigns/:id
 *   index.js               — this file
 */

const express = require("express");
const { getDb } = require("../../db/database");
const { asyncHandler } = require("../../utils/errorHandlers");
const { isValidPlatform } = require("../../utils/validation");
const {
  startCampaign,
  pauseCampaign,
  resumeCampaign,
} = require("../../campaign/campaignOrchestrator");
const { isCampaignQueueInProgress, __private } = require("../../jobs/backgroundJobs");
const { stopConnectionQueue } = require("../../campaign/connectionQueue");
const { stopDmQueue } = require("../../campaign/dmQueue");
const { reclaimStuckRunningJobs } = require("../../campaign/utils/reclaimStuckJobs");
const { registerCampaignStream } = require("../../campaign/utils/campaignUtils");
const logger = require("../../utils/logger");
const { broadcast } = require("../../services/socketService");
const { renderPage } = require("../pageRenderer");

const router = express.Router();

// Single source of truth for every dep the split files need. Defined once
// here so the split files don't have to know where anything lives on disk.
const requireDeps = () => ({
  express,
  getDb,
  asyncHandler,
  isValidPlatform,
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  isCampaignQueueInProgress,
  __private,
  stopConnectionQueue,
  stopDmQueue,
  reclaimStuckRunningJobs,
  registerCampaignStream,
  logger,
  broadcast,
  renderPage,
});

// Register each thematic group of routes on the API router.
require("./createAndLifecycle").register({ router, requireDeps });
require("./queries").register({ router, requireDeps });
require("./jobs").register({ router, requireDeps });
require("./stream").register({ router, requireDeps });
require("./queueControls").register({ router, requireDeps });

// Build the page-views sub-router (attached as `module.exports.pageRouter`
// to preserve the original API surface exactly).
const pageRouter = require("./pageRouter").buildPageRouter({ requireDeps });

module.exports = router;
module.exports.pageRouter = pageRouter;
