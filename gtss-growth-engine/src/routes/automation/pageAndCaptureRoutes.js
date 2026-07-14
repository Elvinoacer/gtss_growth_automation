/**
 * Automation Routes — Page Render + DOM Capture
 *
 * Express handlers for the automation page render and the manual DOM
 * recorder endpoints (which only read the user-controlled CDP Chrome tab
 * and never click, type, navigate, or start an automation job):
 *   GET  /automation                          — Render the Automation page
 *   GET  /api/automation/dom-captures/tabs    — List platform Chrome tabs available for capture
 *   GET  /api/automation/dom-captures         — List recent DOM captures
 *   POST /api/automation/dom-captures         — Save a new manual DOM checkpoint
 *
 * Cross-file dependencies: ../pageRenderer, ../../services/domCaptureService
 * (captureDom, getPlatformPages, listCaptures), ../../utils/logger.
 *
 * Extracted from the original routes/automation.js for maintainability.
 */

const { renderPage } = require("../pageRenderer");
const {
  captureDom,
  getPlatformPages,
  listCaptures,
} = require("../../services/domCaptureService");
const logger = require("../../utils/logger");

/**
 * Register the automation page render + DOM capture routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerPageAndCaptureRoutes(router) {
  // ---------------------------------------------------------------------------
  // Page Routes
  // ---------------------------------------------------------------------------

  router.get("/automation", (req, res) => {
    renderPage(res, {
      title: "Automation",
      primaryHeading: "Automation Control",
      primaryCopy: "Manage and monitor active browser routines.",
    });
  });

  // ---------------------------------------------------------------------------
  // API Routes
  // ---------------------------------------------------------------------------

  // Manual DOM recorder. This intentionally only reads the user-controlled CDP
  // Chrome tab; it never clicks, types, navigates, or starts an automation job.
  router.get("/api/automation/dom-captures/tabs", async (req, res) => {
    try {
      res.json(await getPlatformPages(req.query.platform));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.get("/api/automation/dom-captures", async (req, res) => {
    try {
      res.json(await listCaptures(req.query.limit));
    } catch (error) {
      logger.error("DOM_CAPTURE", "Could not list DOM captures", error);
      res.status(500).json({ error: "Could not list DOM captures" });
    }
  });

  router.post("/api/automation/dom-captures", async (req, res) => {
    try {
      const capture = await captureDom(req.body || {});
      logger.info("DOM_CAPTURE", "Saved manual DOM checkpoint", {
        captureId: capture.captureId,
        platform: capture.platform,
        pipeline: capture.pipeline,
        label: capture.label,
      });
      res.status(201).json(capture);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
}

module.exports = { registerPageAndCaptureRoutes };
