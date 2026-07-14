/**
 * Discovery Routes — Page Render + Max-Leads Config
 *
 * Express handlers for the Discovery page shell and the simple
 * max-leads-per-run setting persisted in the `settings` table:
 *   GET  /         — Render the Discovery page (mounted at /discovery by server.js)
 *   GET  /config   — Read the discovery_max_leads setting (default 20)
 *   POST /config   — Write the discovery_max_leads setting (validated 1-100)
 *
 * Cross-file dependencies: ../pageRenderer, ../../db/database (getDb).
 *
 * Extracted from the original routes/discovery.js for maintainability.
 */

const { renderPage } = require("../pageRenderer");
const { getDb } = require("../../db/database");

/**
 * Register the page render + max-leads config routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerPageAndConfigRoutes(router) {
  router.get("/", (req, res) => {
    renderPage(res, {
      title: "Discovery",
      primaryHeading: "Find prospects",
      primaryCopy:
        "Collect and normalize leads from LinkedIn, X, Instagram, and Facebook.",
    });
  });

  router.get("/config", (req, res) => {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = 'discovery_max_leads'")
      .get();
    res.json({ maxLeads: row ? Number(row.value) : 20 });
  });

  router.post("/config", (req, res) => {
    const maxLeads = Number(req.body.maxLeads);
    if (!Number.isInteger(maxLeads) || maxLeads < 1 || maxLeads > 100) {
      return res
        .status(400)
        .json({ error: "maxLeads must be between 1 and 100" });
    }
    getDb()
      .prepare(
        `
      INSERT INTO settings (key, value) VALUES ('discovery_max_leads', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
      )
      .run(String(maxLeads));
    res.json({ success: true });
  });
}

module.exports = { registerPageAndConfigRoutes };
