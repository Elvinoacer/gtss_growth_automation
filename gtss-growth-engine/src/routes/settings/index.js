/**
 * Settings Routes — Index / Aggregator
 *
 * Creates the two Express routers that the original routes/settings.js
 * exported — `pageRouter` (mounted by server.js at /settings) and
 * `apiRouter` (mounted at /api/settings) — and registers every route
 * group in the same order the original file did, so that Express's
 * route-matching precedence is preserved exactly.
 *
 *   pageRouter:
 *     1. GET /                              (pageRoutes.js)
 *
 *   apiRouter:
 *     1. General settings + limits + notifications  (generalRoutes.js)
 *     2. Credentials (Gemini, Gmail, passphrase)    (credentialsRoutes.js)
 *     3. Templates + clear-data                     (templateRoutes.js)
 *     4. Pipeline settings                          (pipelineRoutes.js)
 *
 * Re-exports the pageRouter as the module and attaches `apiRouter` as
 * `module.exports.apiRouter` (matching the original
 * `module.exports = pageRouter; module.exports.apiRouter = apiRouter;`).
 *
 * Extracted from the original routes/settings.js for maintainability.
 */

const express = require("express");

const { registerPageRoutes } = require("./pageRoutes");
const { registerGeneralRoutes } = require("./generalRoutes");
const { registerCredentialsRoutes } = require("./credentialsRoutes");
const { registerTemplateRoutes } = require("./templateRoutes");
const { registerPipelineRoutes } = require("./pipelineRoutes");

const pageRouter = express.Router();
const apiRouter = express.Router();

// Page router — only the GET / page render.
registerPageRoutes(pageRouter);

// API router — register route groups in the same order as the original file.
// Express matches routes in registration order, so preserving the order is
// important for routes that share a path shape (e.g. PATCH / vs PATCH /limits
// vs PATCH /notifications vs PATCH /templates/:platform).
registerGeneralRoutes(apiRouter);
registerCredentialsRoutes(apiRouter);
registerTemplateRoutes(apiRouter);
registerPipelineRoutes(apiRouter);

module.exports = pageRouter;
module.exports.apiRouter = apiRouter;
