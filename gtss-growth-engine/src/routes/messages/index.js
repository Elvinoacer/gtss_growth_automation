/**
 * messages/index.js — Express router entry point for the Messages page.
 *
 * Creates the router, hands it to each thematic split module so they can
 * register their routes, then exports the router. Preserves the EXACT
 * module.exports shape of the original routes/messages.js (561 lines):
 * a single Express router, mounted at "/" in src/server.js line 204 via
 * `app.use("/", require("./routes/messages"))`.
 *
 * Split files in this directory (each exports a function that takes the
 * router and registers its routes):
 *   pageRoutes.js          — GET /messages (page render)
 *   generateRoutes.js      — POST /api/messages/generate (single-lead) +
 *                            POST /api/messages/generate-all (background
 *                            bulk job) + POST /api/messages/retry-fallbacks
 *                            (re-run Gemini for template-fallback leads) +
 *                            GET /api/messages/stream/:jobId (SSE) +
 *                            GET /api/messages/active (is a bulk job
 *                            running?). Owns the module-private
 *                            `nextJobId` counter.
 *   listRoutes.js          — GET /api/messages (paginated filtered list with
 *                            lead data) + GET /api/messages/stats (header
 *                            counters: pending / approved / sent / skipped /
 *                            followUps / unscored_qualified / charLimits)
 *   approveRoutes.js       — PATCH /api/messages/:id/approve (single approve
 *                            + skip sibling + promote lead) +
 *                            POST /api/messages/bulk-approve (variant A/B
 *                            bulk approve in a transaction) +
 *                            PATCH /api/messages/:id/skip (skip + deprioritize
 *                            lead). All three broadcast `messages:mutation`.
 *   regenerateRoutes.js    — POST /api/messages/:id/regenerate (delete
 *                            pending variants + re-run generator)
 *   followUpRoutes.js      — GET /api/messages/follow-ups (leads whose
 *                            follow-up window has opened) +
 *                            POST /api/messages/follow-up/:leadId (generate
 *                            follow-up for one lead) +
 *                            PATCH /api/messages/:id/snooze (snooze N days)
 *   charLimitsRoutes.js    — GET /api/messages/char-limits (returns the
 *                            per-platform CHAR_LIMITS object)
 *
 * Route registration order matches the original routes/messages.js order
 * exactly: page → generate (single → bulk → stream → active) → list → stats →
 * approve → bulk-approve → skip → regenerate → follow-ups → follow-up →
 * snooze → char-limits.
 */

const express = require("express");

const router = express.Router();

// Register routes in the original route-declaration order so any path-shape
// or method-specific matching behavior is identical to the original file.
require("./pageRoutes")(router);
require("./generateRoutes")(router);
require("./listRoutes")(router);
require("./approveRoutes")(router);
require("./regenerateRoutes")(router);
require("./followUpRoutes")(router);
require("./charLimitsRoutes")(router);

module.exports = router;
