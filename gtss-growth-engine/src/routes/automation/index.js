/**
 * Automation Routes — Index / Aggregator
 *
 * Creates the Express router for /automation and registers every route
 * group in the same order the original routes/automation.js did, so that
 * Express's route-matching precedence is preserved exactly.
 *
 *   1. Page render + DOM captures  (pageAndCaptureRoutes.js)
 *   2. Daily limits                (limitsRoutes.js)
 *   3. Queue + history (read-only) (queueRoutes.js)
 *   4. Run / stream / stop / active (runRoutes.js)
 *   5. Skip / retry queue actions  (retryRoutes.js)
 *   6. Open manual browser         (browserRoutes.js)
 *   7. Pipeline run control + SSE  (pipelineRoutes.js)
 *   8. Instagram settings          (instagramSettingsRoutes.js)
 *   9. LinkedIn DM diagnostics     (linkedinDiagnosticsRoutes.js)
 *
 * Re-exports the router as the module (matching the original
 * `module.exports = router;`).
 *
 * Extracted from the original routes/automation.js for maintainability.
 */

const express = require("express");

const { registerPageAndCaptureRoutes } = require("./pageAndCaptureRoutes");
const { registerLimitsRoutes } = require("./limitsRoutes");
const { registerQueueRoutes } = require("./queueRoutes");
const { registerRunRoutes } = require("./runRoutes");
const { registerRetryRoutes } = require("./retryRoutes");
const { registerBrowserRoutes } = require("./browserRoutes");
const { registerPipelineRoutes } = require("./pipelineRoutes");
const { registerInstagramSettingsRoutes } = require("./instagramSettingsRoutes");
const { registerLinkedinDiagnosticsRoutes } = require("./linkedinDiagnosticsRoutes");

const router = express.Router();

// Register route groups in the same order as the original file. Express
// matches routes in registration order, so preserving the order is
// important for routes that share a path shape (e.g. GET /api/automation/queue
// vs GET /api/automation/queue/summary vs PATCH /api/automation/queue/:messageId/skip).
registerPageAndCaptureRoutes(router);
registerLimitsRoutes(router);
registerQueueRoutes(router);
registerRunRoutes(router);
registerRetryRoutes(router);
registerBrowserRoutes(router);
registerPipelineRoutes(router);
registerInstagramSettingsRoutes(router);
registerLinkedinDiagnosticsRoutes(router);

module.exports = router;
