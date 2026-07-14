/**
 * Pipelines Routes — Index / Aggregator
 *
 * Creates the Express router for /api/pipelines and registers every route
 * group in the same order the original routes/pipelines.js did, so that
 * Express's route-matching precedence is preserved exactly.
 *
 *   1. CRUD + health     (crudRoutes.js)
 *   2. Run + restart     (runRoutes.js)
 *   3. Retry + resume    (retryRoutes.js)
 *   4. Pause/stop/clear  (pauseStopRoutes.js)
 *   5. Executions/logs   (executionRoutes.js)
 *   6. Mass-follow queue (massFollowRoutes.js)
 *
 * Re-exports the router as the module (matching the original
 * `module.exports = router;`).
 *
 * Extracted from the original routes/pipelines.js for maintainability.
 */

const express = require('express');

const { registerCrudRoutes } = require('./crudRoutes');
const { registerRunRoutes } = require('./runRoutes');
const { registerRetryRoutes } = require('./retryRoutes');
const { registerPauseStopRoutes } = require('./pauseStopRoutes');
const { registerExecutionRoutes } = require('./executionRoutes');
const { registerMassFollowRoutes } = require('./massFollowRoutes');

const router = express.Router();

// Register route groups in the same order as the original file. Express
// matches routes in registration order, so preserving the order is
// important for routes that share a path shape (e.g. /:id/executions vs
// /mass-follow/targets).
registerCrudRoutes(router);
registerRunRoutes(router);
registerRetryRoutes(router);
registerPauseStopRoutes(router);
registerExecutionRoutes(router);
registerMassFollowRoutes(router);

module.exports = router;
