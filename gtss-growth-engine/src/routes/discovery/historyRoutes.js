/**
 * Discovery Routes — Run History + Rerun
 *
 * Express handlers for browsing past discovery runs and re-running one
 * with the same keyword + platforms (optionally with a new maxLeads cap):
 *   GET  /history           — List every discovery_runs row (newest first), with platforms parsed
 *   POST /history/:id/rerun — Create a new running row copied from a past run, fire-and-forget discoverLeads()
 *
 * Cross-file dependencies: ../../db/database (getDb), ../../services/discoveryService
 * (discoverLeads, emitJobEvent, closeJobStream), ./shared (parseJsonArray).
 *
 * Extracted from the original routes/discovery.js for maintainability.
 */

const { getDb } = require("../../db/database");
const {
  discoverLeads,
  emitJobEvent,
  closeJobStream,
} = require("../../services/discoveryService");
const { parseJsonArray } = require("./shared");

/**
 * Register the history + rerun routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerHistoryRoutes(router) {
  router.get("/history", (req, res) => {
    const runs = getDb()
      .prepare("SELECT * FROM discovery_runs ORDER BY run_at DESC, id DESC")
      .all()
      .map((run) => ({
        ...run,
        platforms: parseJsonArray(run.platforms),
      }));

    res.json({ runs });
  });

  router.post("/history/:id/rerun", (req, res) => {
    const run = getDb()
      .prepare("SELECT * FROM discovery_runs WHERE id = ?")
      .get(req.params.id);

    if (!run) {
      return res.status(404).json({ error: "Discovery run not found" });
    }

    const platforms = parseJsonArray(run.platforms);
    const created = getDb()
      .prepare(
        `INSERT INTO discovery_runs (keyword, platforms, leads_found, status)
         VALUES (?, ?, 0, 'running')`,
      )
      .run(run.keyword, JSON.stringify(platforms));
    const jobId = created.lastInsertRowid;
    const maxLeads = Number(req.body.maxLeads) || 50;

    setImmediate(() => {
      discoverLeads(
        run.keyword,
        platforms,
        Math.min(Math.max(maxLeads, 1), 100),
        jobId,
      ).catch((error) => {
        getDb()
          .prepare("UPDATE discovery_runs SET status = ? WHERE id = ?")
          .run("failed", jobId);
        emitJobEvent(jobId, { type: "error", jobId, message: error.message });
        closeJobStream(jobId);
      });
    });

    // Return the platforms alongside the jobId so the rerun caller (discovery.js)
    // can populate the completion summary with the platforms that were actually
    // scanned, not just whatever is currently checked in the form.
    return res.status(202).json({ jobId, platforms });
  });
}

module.exports = { registerHistoryRoutes };
