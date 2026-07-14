/**
 * campaigns/queueControls.js
 *
 * Registers the manual queue-trigger and queue-status routes on the
 * campaigns API router:
 *   POST /api/campaigns/run-connection-queue — trigger Connection Queue run
 *   POST /api/campaigns/run-dm-queue         — trigger DM Queue run
 *   GET  /api/campaigns/queue-status/lock    — poll advisory-lock + in-progress
 *
 * Both POST handlers enforce the singleton mutex from backgroundJobs
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
 */

function register({ router, requireDeps }) {
  const {
    getDb,
    asyncHandler,
    isCampaignQueueInProgress,
    __private,
    logger,
  } = requireDeps();

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/campaigns/run-connection-queue — manual Connection Queue run.
  // ─────────────────────────────────────────────────────────────────────────
  router.post(
    "/run-connection-queue",
    asyncHandler(async (req, res) => {
      // 1. Thread-safe concurrency check
      if (isCampaignQueueInProgress()) {
        return res.status(409).json({
          error: "Concurrency lock active: Another campaign outreach queue run is in progress.",
          code: 409
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
          error: "Concurrency lock active: Another campaign outreach queue run is in progress.",
          code: 409
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
  // GET /api/campaigns/queue-status/lock — poll advisory lock + in-progress.
  // ─────────────────────────────────────────────────────────────────────────
  router.get(
    "/queue-status/lock",
    asyncHandler(async (req, res) => {
      const db = getDb();
      const lockRow = db.prepare("SELECT value FROM settings WHERE key = 'campaign_queue_lock'").get();
      const isLocked = lockRow ? lockRow.value === "true" : false;
      return res.json({
        locked: isLocked,
        inProgress: isCampaignQueueInProgress()
      });
    })
  );
}

module.exports = { register };
