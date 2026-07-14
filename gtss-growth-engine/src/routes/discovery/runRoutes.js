/**
 * Discovery Routes — Start / Stream / Stop / Active
 *
 * Express handlers for kicking off a discovery run, subscribing to its SSE
 * event stream, signalling stop, and querying the currently-active run:
 *   POST /start            — Validate keyword+platforms+maxLeads, insert a discovery_runs row, fire-and-forget discoverLeads()
 *   GET  /stream/:jobId    — SSE stream for a discovery run's progress events
 *   POST /stop/:jobId      — Mark the run as 'stopping' + call stopDiscovery() in the service
 *   GET  /active           — Read the latest 'running' discovery_runs row (for UI rehydration on page load)
 *
 * Cross-file dependencies: ../../db/database (getDb), ../../services/discoveryService
 * (discoverLeads, listDiscoverySources, registerJobStream, emitJobEvent,
 * closeJobStream, stopDiscovery), ./shared (parseJsonArray).
 *
 * Extracted from the original routes/discovery.js for maintainability.
 */

const { getDb } = require("../../db/database");
const {
  discoverLeads,
  listDiscoverySources,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
  stopDiscovery,
} = require("../../services/discoveryService");
const { parseJsonArray } = require("./shared");

/**
 * Register the start / stream / stop / active routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerRunRoutes(router) {
  router.post("/start", (req, res) => {
    const { keyword, platforms, maxLeads, ig_auto_warmup } = req.body;
    const selectedPlatforms = Array.isArray(platforms) ? platforms : [];

    if (ig_auto_warmup !== undefined) {
      const db = getDb();
      const val = ig_auto_warmup ? "1" : "0";
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_warmup_on_qualify', ?)",
      ).run(val);
    }
    const parsedMaxLeads = Number(maxLeads);
    const validPlatforms = listDiscoverySources();

    if (!keyword || !String(keyword).trim()) {
      return res.status(400).json({ error: "Keyword is required" });
    }

    if (selectedPlatforms.length === 0) {
      return res.status(400).json({ error: "At least one platform is required" });
    }

    if (
      selectedPlatforms.some((platform) => !validPlatforms.includes(platform))
    ) {
      return res.status(400).json({ error: "Unsupported platform selected" });
    }

    if (
      !Number.isInteger(parsedMaxLeads) ||
      parsedMaxLeads < 1 ||
      parsedMaxLeads > 100
    ) {
      return res
        .status(400)
        .json({ error: "maxLeads must be between 1 and 100" });
    }

    const run = getDb()
      .prepare(
        `INSERT INTO discovery_runs (keyword, platforms, leads_found, status)
         VALUES (?, ?, 0, 'running')`,
      )
      .run(String(keyword).trim(), JSON.stringify(selectedPlatforms));

    const jobId = run.lastInsertRowid;

    setImmediate(() => {
      discoverLeads(
        String(keyword).trim(),
        selectedPlatforms,
        parsedMaxLeads,
        jobId,
      ).catch((error) => {
        getDb()
          .prepare("UPDATE discovery_runs SET status = ? WHERE id = ?")
          .run("failed", jobId);
        emitJobEvent(jobId, { type: "error", jobId, message: error.message });
        closeJobStream(jobId);
      });
    });

    return res.status(202).json({ jobId });
  });

  router.get("/stream/:jobId", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    registerJobStream(req.params.jobId, res);
  });

  router.post("/stop/:jobId", (req, res) => {
    const result = getDb()
      .prepare(
        "UPDATE discovery_runs SET status = 'stopping' WHERE id = ? AND status = 'running'",
      )
      .run(req.params.jobId);

    stopDiscovery(req.params.jobId);
    return res.json({ stopped: result.changes > 0 });
  });

  // GET /api/discovery/active — returns the currently-running discovery job,
  // if any, so the frontend can rehydrate the "running" UI on page load or
  // refresh instead of always starting from the idle form.
  router.get("/active", (req, res) => {
    const run = getDb()
      .prepare(
        "SELECT * FROM discovery_runs WHERE status = 'running' ORDER BY run_at DESC, id DESC LIMIT 1",
      )
      .get();

    if (!run) {
      return res.json({ active: false });
    }

    return res.json({
      active: true,
      jobId: run.id,
      keyword: run.keyword,
      platforms: parseJsonArray(run.platforms),
    });
  });
}

module.exports = { registerRunRoutes };
