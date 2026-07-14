/**
 * campaigns/queueControls.js
 *
 * Registers the manual queue-trigger, stop, and queue-status routes on the
 * campaigns API router:
 *   POST /api/campaigns/run-connection-queue — trigger Connection Queue run
 *   POST /api/campaigns/run-dm-queue         — trigger DM Queue run
 *   POST /api/campaigns/stop-queue           — halt in-flight queue + reclaim stuck jobs
 *   GET  /api/campaigns/queue-status/lock    — poll advisory-lock + in-progress
 *
 * Both POST run handlers enforce the singleton mutex from backgroundJobs
 * (`isCampaignQueueInProgress`) so a second manual trigger is rejected
 * with 409 instead of racing a Playwright instance against the running one.
 * The actual queue work is fired off asynchronously (not awaited) so the
 * HTTP request returns 202 immediately — the launcher UI polls
 * `queue-status/lock` to see when the run finishes.
 *
 * Required deps (passed in via `requireDeps`):
 *   - getDb, asyncHandler
 *   - isCampaignQueueInProgress, __private (from ../jobs/backgroundJobs)
 *   - logger
 *   - stopConnectionQueue, stopDmQueue (optional; required lazily if omitted)
 *   - reclaimStuckRunningJobs (optional; required lazily if omitted)
 */

function register({ router, requireDeps }) {
  const {
    getDb,
    asyncHandler,
    isCampaignQueueInProgress,
    __private,
    logger,
  } = requireDeps();

  const stopConnectionQueue =
    requireDeps().stopConnectionQueue ||
    require("../../campaign/connectionQueue").stopConnectionQueue;
  const stopDmQueue =
    requireDeps().stopDmQueue ||
    require("../../campaign/dmQueue").stopDmQueue;
  const reclaimStuckRunningJobs =
    requireDeps().reclaimStuckRunningJobs ||
    require("../../campaign/utils/reclaimStuckJobs").reclaimStuckRunningJobs;

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/campaigns/run-connection-queue — manual Connection Queue run.
  // ─────────────────────────────────────────────────────────────────────────
  router.post(
    "/run-connection-queue",
    asyncHandler(async (req, res) => {
      // 1. Thread-safe concurrency check
      if (isCampaignQueueInProgress()) {
        return res.status(409).json({
          error: "Concurrency lock active: Another campaign outreach queue run is in progress. Use Stop Queue first.",
          code: 409,
          hint: "stop_queue",
        });
      }

      // 2. Trigger connection queue asynchronously without blocking the HTTP request thread
      logger.info("API", "Manual run triggered for Connection Queue.");
      __private.runConnectionQueueJob().catch((err) => {
        logger.error("API", "Asynchronous manual connection queue processing failed", err);
      });

      // 3. Return 202 Accepted
      return res.status(202).json({
        success: true,
        status: "queued",
        message: "Connection queue processing run initiated."
      });
    })
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/campaigns/run-dm-queue — manual DM Queue run.
  // ─────────────────────────────────────────────────────────────────────────
  router.post(
    "/run-dm-queue",
    asyncHandler(async (req, res) => {
      // 1. Thread-safe concurrency check
      if (isCampaignQueueInProgress()) {
        return res.status(409).json({
          error: "Concurrency lock active: Another campaign outreach queue run is in progress. Use Stop Queue first.",
          code: 409,
          hint: "stop_queue",
        });
      }

      // 2. Trigger DM queue asynchronously without blocking the HTTP request thread
      logger.info("API", "Manual run triggered for DM Queue.");
      __private.runDmQueueJob().catch((err) => {
        logger.error("API", "Asynchronous manual DM queue processing failed", err);
      });

      // 3. Return 202 Accepted
      return res.status(202).json({
        success: true,
        status: "queued",
        message: "DM queue processing run initiated."
      });
    })
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/campaigns/stop-queue — halt in-flight connection + DM queue runs.
  //
  // Sets the module-level stop flags polled by processConnectionQueue /
  // processDmQueue (between jobs + inside interruptible sleeps). Also
  // reclaims any jobs left in `running` so they become eligible again, and
  // clears a stuck advisory lock when no runner is actually in memory.
  // ─────────────────────────────────────────────────────────────────────────
  router.post(
    "/stop-queue",
    asyncHandler(async (req, res) => {
      const db = getDb();
      const wasInProgress = isCampaignQueueInProgress();

      try {
        stopConnectionQueue();
      } catch (err) {
        logger.error("API", `stopConnectionQueue failed: ${err.message}`);
      }
      try {
        stopDmQueue();
      } catch (err) {
        logger.error("API", `stopDmQueue failed: ${err.message}`);
      }

      let reclaimed = { connectionJobs: 0, dmJobs: 0 };
      try {
        reclaimed = reclaimStuckRunningJobs(db, {
          reason: "Stopped by user from campaign page",
        });
      } catch (err) {
        logger.error("API", `Failed to reclaim stuck jobs on stop: ${err.message}`);
      }

      // If the in-memory runner is gone but the DB lock is still true
      // (crashed worker without startup sweep), release it so the next Run works.
      let lockCleared = false;
      if (!wasInProgress) {
        try {
          const result = db
            .prepare(
              "UPDATE settings SET value = 'false' WHERE key = 'campaign_queue_lock' AND value = 'true'",
            )
            .run();
          lockCleared = result.changes > 0;
        } catch (err) {
          logger.error("API", `Failed to clear stuck queue lock: ${err.message}`);
        }
      }

      logger.info(
        "API",
        `Campaign queue stop requested (inProgress=${wasInProgress}, reclaimed conn=${reclaimed.connectionJobs} dm=${reclaimed.dmJobs}, lockCleared=${lockCleared}).`,
      );

      return res.json({
        success: true,
        stopped: true,
        wasInProgress,
        reclaimed,
        lockCleared,
        message: wasInProgress
          ? "Stop signal sent. The queue will halt after the current profile action finishes."
          : reclaimed.connectionJobs + reclaimed.dmJobs > 0 || lockCleared
            ? "No live runner was active. Cleared stuck lock/jobs so you can run again."
            : "No active campaign queue run to stop.",
      });
    })
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/campaigns/queue-status/lock — poll advisory lock + in-progress.
  // ─────────────────────────────────────────────────────────────────────────
  router.get(
    "/queue-status/lock",
    asyncHandler(async (req, res) => {
      const db = getDb();
      const lockRow = db.prepare("SELECT value FROM settings WHERE key = 'campaign_queue_lock'").get();
      const isLocked = lockRow ? lockRow.value === "true" : false;
      const inProgress = isCampaignQueueInProgress();
      return res.json({
        locked: isLocked,
        inProgress,
        // UI convenience: treat either signal as "queue busy"
        busy: Boolean(isLocked || inProgress),
      });
    })
  );
}

module.exports = { register };
