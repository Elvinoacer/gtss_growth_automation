/**
 * Discovery Routes — Index / Aggregator
 *
 * Creates the Express router for /api/discovery and registers every route
 * group in the same order the original routes/discovery.js did, so that
 * Express's route-matching precedence is preserved exactly.
 *
 *   1. Page render + max-leads config  (pageAndConfigRoutes.js)
 *   2. Start / stream / stop / active  (runRoutes.js)
 *   3. Results + queue actions         (resultsRoutes.js)
 *   4. History + rerun                  (historyRoutes.js)
 *   5. Keywords + keyword groups        (keywordRoutes.js)
 *
 * Re-exports the router as the module (matching the original
 * `module.exports = router;`).
 *
 * Extracted from the original routes/discovery.js for maintainability.
 */

const express = require("express");

const { registerPageAndConfigRoutes } = require("./pageAndConfigRoutes");
const { registerRunRoutes } = require("./runRoutes");
const { registerResultsRoutes } = require("./resultsRoutes");
const { registerHistoryRoutes } = require("./historyRoutes");
const { registerKeywordRoutes } = require("./keywordRoutes");

const router = express.Router();

// Register route groups in the same order as the original file. Express
// matches routes in registration order, so preserving the order is
// important for routes that share a path shape — notably
// DELETE /keywords/groups/:id (registered inside keywordRoutes.js BEFORE
// DELETE /keywords/:idx) so /keywords/groups/5 isn't captured by the index
// pattern.
registerPageAndConfigRoutes(router);
registerRunRoutes(router);
registerResultsRoutes(router);
registerHistoryRoutes(router);
registerKeywordRoutes(router);

module.exports = router;
