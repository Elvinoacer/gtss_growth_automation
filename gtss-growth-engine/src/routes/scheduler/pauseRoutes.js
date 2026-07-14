/**
 * Scheduler Routes — Pause / Resume
 *
 * Express handlers for the global scheduler pause flag (persisted in the
 * `settings` table under key `scheduler_paused`):
 *   PATCH /api/scheduler/pause  — Set the pause flag (true/false)
 *   GET   /api/scheduler/pause  — Read the current pause flag
 *
 * Cross-file dependencies: ../../db/database.
 *
 * Extracted from the original routes/scheduler.js for maintainability.
 */

const { getDb } = require("../../db/database");

/**
 * Register pause/resume routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerPauseRoutes(router) {
  // ---------------------------------------------------------------------------
  // API: Pause / Resume Scheduler
  // ---------------------------------------------------------------------------

  router.patch("/api/scheduler/pause", (req, res) => {
    const { paused } = req.body;

    try {
      const db = getDb();
      db.prepare(
        `
        INSERT INTO settings (key, value) VALUES ('scheduler_paused', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
      ).run(paused ? "true" : "false");

      res.json({ paused: Boolean(paused) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/api/scheduler/pause", (req, res) => {
    try {
      const db = getDb();
      const row = db
        .prepare("SELECT value FROM settings WHERE key = 'scheduler_paused'")
        .get();
      res.json({ paused: row ? row.value === "true" : false });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = { registerPauseRoutes };
