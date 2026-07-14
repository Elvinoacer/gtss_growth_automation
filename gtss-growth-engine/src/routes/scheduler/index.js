/**
 * Scheduler Routes — Index / Aggregator
 *
 * Creates the Express router for the scheduler and registers every route
 * group in the same order the original routes/scheduler.js did, so that
 * Express's route-matching precedence is preserved exactly.
 *
 *   1. Page render + post CRUD        (postRoutes.js)
 *   2. Publish-now + retry + SSE      (publishRoutes.js)
 *   3. AI caption + image generation  (aiRoutes.js)
 *   4. Pause / resume                 (pauseRoutes.js)
 *   5. Media upload                   (uploadRoutes.js)
 *
 * Re-exports the router as the module (matching the original
 * `module.exports = router;`).
 *
 * Extracted from the original routes/scheduler.js for maintainability.
 */

const express = require("express");

const { registerPostRoutes } = require("./postRoutes");
const { registerPublishRoutes } = require("./publishRoutes");
const { registerAiRoutes } = require("./aiRoutes");
const { registerPauseRoutes } = require("./pauseRoutes");
const { registerUploadRoutes } = require("./uploadRoutes");

const router = express.Router();

// Register route groups in the same order as the original file. Express
// matches routes in registration order, so preserving the order is
// important for routes that share a path shape (e.g. POST /api/scheduler/posts
// vs POST /api/scheduler/posts/:id/publish-now).
registerPostRoutes(router);
registerPublishRoutes(router);
registerAiRoutes(router);
registerPauseRoutes(router);
registerUploadRoutes(router);

module.exports = router;
