/**
 * Automation Routes — LinkedIn DM Diagnostics
 *
 * Express handlers for inspecting LinkedIn DM diagnostics files (saved by
 * the automation when a DM send fails so the developer can post-mortem the
 * DOM state):
 *   GET /api/automation/linkedin/diagnostics             — List recent diagnostics files (with metadata)
 *   GET /api/automation/linkedin/diagnostics/:filename   — Read a single diagnostics file's parsed JSON
 *
 * Cross-file dependencies: ../../automation/linkedinDiagnostics
 * (listRecentDiagnostics, readDiagnosticsFile) — required lazily inside the
 * handlers.
 *
 * Extracted from the original routes/automation.js for maintainability.
 */

/**
 * Register the LinkedIn diagnostics routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerLinkedinDiagnosticsRoutes(router) {
  // ---------------------------------------------------------------------------
  // LinkedIn DM Diagnostics API
  // ---------------------------------------------------------------------------

  router.get("/api/automation/linkedin/diagnostics", (req, res) => {
    try {
      const { listRecentDiagnostics } = require("../../automation/linkedinDiagnostics");
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
      const files = listRecentDiagnostics(limit);
      res.json({ success: true, files });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/api/automation/linkedin/diagnostics/:filename", (req, res) => {
    try {
      const { listRecentDiagnostics, readDiagnosticsFile } = require("../../automation/linkedinDiagnostics");
      const files = listRecentDiagnostics(100);
      const match = files.find((f) => f.filename === req.params.filename);
      if (!match) {
        return res.status(404).json({ error: "Diagnostics file not found" });
      }
      const data = readDiagnosticsFile(match.path);
      if (!data) {
        return res.status(500).json({ error: "Failed to parse diagnostics file" });
      }
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerLinkedinDiagnosticsRoutes };
