/**
 * Automation Routes — Run / Stream / Stop / Active
 *
 * Express handlers for starting an automation queue run, subscribing to
 * its SSE event stream, signalling stop (single job or panic button), and
 * checking whether any run is currently in progress:
 *   POST /api/automation/run          — Allocate a jobId; executor fires when SSE connects (5s headless fallback)
 *   GET  /api/automation/stream/:jobId — SSE stream for a run's progress events
 *   POST /api/automation/stop/:jobId   — Stop one job (executor + DM queue + connection queue)
 *   POST /api/automation/stop-all      — Panic button: stop every runner
 *   GET  /api/automation/active        — Durable "is a run in progress?" check (queries automation_jobs)
 *
 * Module-level state:
 *   - `activeStreams` Map — jobId → SSE response (so future reconnections could find it)
 *   - `pendingExecutors` Map — jobId → true (set by /run, cleared when SSE connects or 5s fallback fires)
 *
 * These two Maps are private to this file — they are not referenced by any
 * other route handler. Kept at module scope (not in a shared state file)
 * because they are an implementation detail of the run/stream coordination.
 *
 * Cross-file dependencies: crypto, ../../db/database (getDb),
 * ../../automation/executor (enqueueActionQueue, stopJob, stopAllJobs),
 * ../../campaign/dmQueue (stopDmQueue), ../../campaign/connectionQueue
 * (stopConnectionQueue).
 *
 * Extracted from the original routes/automation.js for maintainability.
 */

const crypto = require("crypto");
const { getDb } = require("../../db/database");
const {
  enqueueActionQueue,
  stopJob,
  stopAllJobs,
} = require("../../automation/executor");
const { stopDmQueue } = require("../../campaign/dmQueue");
const { stopConnectionQueue } = require("../../campaign/connectionQueue");
const { getPlatformKeys } = require("../../services/platformCatalog");

// SSE response storage
const activeStreams = new Map();

// Store pending executor options, keyed by jobId.
// Value is the options object passed to enqueueActionQueue (e.g. { platforms }).
const pendingExecutors = new Map();

/**
 * Normalize platforms from the request body into a list of known platform keys.
 * Empty / missing → [] (executor treats empty as "all platforms").
 * Unknown keys are dropped so a typo cannot silently no-op the whole run.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeRunPlatforms(raw) {
  if (!Array.isArray(raw)) return [];
  const known = new Set(getPlatformKeys());
  return [
    ...new Set(
      raw
        .map((platform) => String(platform || "").trim().toLowerCase())
        .filter((platform) => platform && known.has(platform)),
    ),
  ];
}

/**
 * Register run / stream / stop / active routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerRunRoutes(router) {
  // Run automation queue
  // Body (optional): { platforms: string[] } — e.g. ["linkedin","x"]
  // When platforms is non-empty, only queued actions for those platforms run.
  router.post("/api/automation/run", (req, res) => {
    const jobId = crypto.randomUUID();
    const platforms = normalizeRunPlatforms(req.body?.platforms);
    const options = platforms.length > 0 ? { platforms } : {};

    res.json({ jobId, platforms: platforms.length > 0 ? platforms : null });

    // Mark as pending — executor will be triggered when SSE connects
    pendingExecutors.set(jobId, options);

    // Safety fallback: if SSE never connects within 5s, run headless
    setTimeout(() => {
      if (pendingExecutors.has(jobId)) {
        const opts = pendingExecutors.get(jobId) || {};
        pendingExecutors.delete(jobId);
        enqueueActionQueue(jobId, null, opts).catch(console.error);
      }
    }, 5000);
  });

  // SSE stream endpoint
  router.get("/api/automation/stream/:jobId", (req, res) => {
    const { jobId } = req.params;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    activeStreams.set(jobId, res);

    // If executor is pending, start it now that SSE is connected
    if (pendingExecutors.has(jobId)) {
      const opts = pendingExecutors.get(jobId) || {};
      pendingExecutors.delete(jobId);
      enqueueActionQueue(jobId, res, opts).catch(console.error);
    }

    req.on("close", () => {
      activeStreams.delete(jobId);
      // Automation continues — user can reconnect or it completes on its own
    });
  });

  // Stop a running job
  //
  // Signals stop to BOTH runners:
  //   1. Executor (Runner A — automation-page-triggered queue) via STOP_FLAGS
  //   2. Campaign DM queue (Runner B — cron-triggered) via stopDmQueue()
  //   3. Campaign connection queue (Runner B — cron-triggered) via stopConnectionQueue()
  //
  // The cron runners previously had no stop mechanism at all — once a cron tick
  // started processDmQueue, it ran to completion. Now they check their stop
  // flag between profiles and inside the cooldown sleep, so the stop button on
  // the automation page actually halts them.
  router.post("/api/automation/stop/:jobId", (req, res) => {
    const { jobId } = req.params;
    const stopped = stopJob(jobId);
    // Also halt any in-flight cron-triggered queue runs.
    try { stopDmQueue(); } catch (_) {}
    try { stopConnectionQueue(); } catch (_) {}
    res.json({ success: true, stopped });
  });

  // Stop ALL running queues (no jobId required) — useful as a panic button.
  router.post("/api/automation/stop-all", (_req, res) => {
    try { stopAllJobs(); } catch (_) {}
    try { stopDmQueue(); } catch (_) {}
    try { stopConnectionQueue(); } catch (_) {}
    res.json({ success: true, stopped: true });
  });

  // GET /api/automation/active — is there an automation run currently in
  // progress? A job is "still running" as long as its automation_jobs row has
  // no completed_at (journal.js only sets completed_at once a terminal status
  // like COMPLETED/FAILED/MANUAL_INTERVENTION_REQUIRED is reached), so this
  // reflects durable state rather than any in-memory map that would reset on
  // server restart or be invisible to a second tab.
  router.get("/api/automation/active", (req, res) => {
    const job = getDb()
      .prepare(
        `SELECT id, status, started_at FROM automation_jobs
         WHERE completed_at IS NULL
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get();

    if (!job) {
      return res.json({ active: false });
    }

    return res.json({
      active: true,
      jobId: job.id,
      status: job.status,
      startedAt: job.started_at,
    });
  });
}

module.exports = { registerRunRoutes };
