/**
 * Automation Routes — Instagram Settings
 *
 * Express handlers for reading and updating the Instagram-specific settings
 * (everything stored in the `settings` table under keys starting with `ig_`
 * or `warmup_`), plus the action-block status and selector-health report:
 *   GET  /api/automation/instagram/settings — Read IG settings + blocked status + selector health report
 *   POST /api/automation/instagram/settings — Update one or more IG/warmup settings (or delete by passing null)
 *
 * Cross-file dependencies: ../../db/database (getDb), ../../automation/browserBase
 * (isInstagramBlocked, getSelectorHealthReport) — required lazily inside the
 * handlers so the Playwright stack is not loaded on every other automation
 * route.
 *
 * Extracted from the original routes/automation.js for maintainability.
 */

const { getDb } = require("../../db/database");

/**
 * Register the Instagram settings routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerInstagramSettingsRoutes(router) {
  // GET /api/automation/instagram/settings - Fetch Instagram settings, action block status, and selector health
  router.get("/api/automation/instagram/settings", (req, res) => {
    try {
      const db = getDb();
      const { isInstagramBlocked, getSelectorHealthReport } = require("../../automation/browserBase");

      const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ig_%' OR key LIKE 'warmup_%'").all();
      const settings = {};
      rows.forEach(r => {
        settings[r.key] = r.value;
      });

      res.json({
        success: true,
        settings,
        blockedStatus: isInstagramBlocked(),
        healthReport: getSelectorHealthReport()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/automation/instagram/settings - Update Instagram settings or reset blocks
  router.post("/api/automation/instagram/settings", (req, res) => {
    try {
      const db = getDb();
      const { isInstagramBlocked, getSelectorHealthReport } = require("../../automation/browserBase");
      const updates = req.body || {};

      const insertStmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
      const deleteStmt = db.prepare("DELETE FROM settings WHERE key = ?");

      const transaction = db.transaction((settingsObj) => {
        for (const [key, value] of Object.entries(settingsObj)) {
          if (key.startsWith("ig_") || key.startsWith("warmup_")) {
            if (value === null || value === "") {
              deleteStmt.run(key);
            } else {
              insertStmt.run(key, String(value));
            }
          }
        }
      });

      transaction(updates);

      const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ig_%' OR key LIKE 'warmup_%'").all();
      const settings = {};
      rows.forEach(r => {
        settings[r.key] = r.value;
      });

      res.json({
        success: true,
        settings,
        blockedStatus: isInstagramBlocked(),
        healthReport: getSelectorHealthReport()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerInstagramSettingsRoutes };
