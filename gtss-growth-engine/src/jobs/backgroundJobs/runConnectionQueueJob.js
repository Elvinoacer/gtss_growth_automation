/**
 * backgroundJobs/runConnectionQueueJob.js
 *
 * Cron-triggered worker for the campaign Connection Queue (LinkedIn
 * connection invites, IG/X/FB follow requests, etc.).
 *
 * Re-entrancy guard: state.campaignQueueInProgress must be false (so the
 * DM queue runner and a manual API trigger don't overlap with a cron run).
 *
 * Cluster-safe DB lock: atomically UPDATE settings SET value='true' WHERE
 * key='campaign_queue_lock' AND value='false' — if changes===0, another
 * instance (or the DM runner) already holds the lock, so we skip. The
 * lock is released in the finally block (best-effort — a crash leaves
 * the lock stuck at 'true', but the startup sweeper in startBackgroundJobs
 * resets it on every boot).
 *
 * Flow:
 *   1. Acquire the in-memory re-entrancy guard (state.campaignQueueInProgress).
 *   2. Acquire the DB lock (cluster-safe).
 *   3. SELECT DISTINCT platform FROM connection_jobs joined to campaigns
 *      WHERE status='pending' OR (status='failed' AND retryable).
 *   4. If no platforms have work, release the lock + guard and return.
 *   5. Pre-launch a browser context for every platform that has work
 *      (launchRequiredBrowsers) and create a Proxy page that routes
 *      page.* calls to whichever platform is currently in flight.
 *   6. processConnectionQueue(proxyPage, options) — does the actual
 *      per-job work.
 *   7. finally: close every browser context, clear currentPlatform,
 *      release the in-memory guard + DB lock.
 */

const crypto = require("crypto");
const { getDb } = require("../../db/database");
const logger = require("../../utils/logger");
const { processConnectionQueue } = require("../../campaign/connectionQueue");
const { state } = require("./state");
const {
  launchRequiredBrowsers,
  closeAllActivePages,
  createProxyPage,
} = require("./browserLifecycle");

/**
 * Worker runner job for campaign invites Connection Queue.
 */
async function runConnectionQueueJob(options = {}) {
  if (state.campaignQueueInProgress) {
    logger.info(
      "SERVER",
      "[CONNECTION-QUEUE] Skipping execution: another campaign outreach queue run is in progress.",
    );
    return;
  }

  const db = getDb();

  // Acquire cluster-safe database lock atomic transition
  try {
    const lockRes = db
      .prepare(
        "UPDATE settings SET value = 'true' WHERE key = 'campaign_queue_lock' AND value = 'false'",
      )
      .run();
    if (lockRes.changes === 0) {
      logger.info(
        "SERVER",
        "[CONNECTION-QUEUE] Skipping execution: another cluster instance or runner has acquired the queue lock.",
      );
      return;
    }
  } catch (err) {
    logger.error(
      "SERVER",
      "[CONNECTION-QUEUE] Failed to acquire persistent queue lock: ",
      err.message,
    );
    return;
  }

  const jobId = crypto.randomUUID();
  state.campaignQueueInProgress = true;
  let activePages = {};

  try {
    logger.info(
      "SERVER",
      "[CONNECTION-QUEUE] Starting campaign connection invite queue run...",
    );
    logger.db(
      "info",
      "campaign_connection",
      "start",
      "Campaign connection queue run started",
      { jobId },
    );

    const maxRetries = 5;
    const rows = db
      .prepare(
        `
      SELECT DISTINCT c.platform
      FROM connection_jobs cj
      JOIN campaigns c ON cj.campaign_id = c.id
      JOIN leads l ON cj.lead_id = l.id
      WHERE (cj.status = 'pending' OR (cj.status = 'failed' AND cj.retry_count < ? AND (cj.next_retry_at IS NULL OR datetime(cj.next_retry_at) <= datetime('now'))))
        AND c.status = 'active'
    `,
      )
      .all(maxRetries);

    if (rows.length === 0) {
      logger.info(
        "SERVER",
        "[CONNECTION-QUEUE] No active platform campaigns have pending or retryable connection invite jobs.",
      );
      state.campaignQueueInProgress = false;
      try {
        db.prepare(
          "UPDATE settings SET value = 'false' WHERE key = 'campaign_queue_lock'",
        ).run();
      } catch (_) {}
      return;
    }

    const requiredPlatforms = rows.map((r) =>
      String(r.platform).toLowerCase().trim(),
    );
    logger.info(
      "SERVER",
      `[CONNECTION-QUEUE] Pre-flight inspection: Launching contexts for platforms: ${requiredPlatforms.join(", ")}`,
    );

    activePages = await launchRequiredBrowsers(requiredPlatforms);
    const proxyPage = createProxyPage(activePages);

    const report = await processConnectionQueue(proxyPage, options);
    logger.info(
      "SERVER",
      `[CONNECTION-QUEUE] Connection queue batch processing complete: ${JSON.stringify(report)}`,
    );
    logger.db(
      "info",
      "campaign_connection",
      "complete",
      "Campaign connection queue run completed",
      { jobId, report },
    );
  } catch (err) {
    logger.error(
      "SERVER",
      "[CONNECTION-QUEUE] Connection queue cron runner encountered a critical error",
      err,
    );
    logger.db(
      "error",
      "campaign_connection",
      "error",
      "Campaign connection queue run failed",
      { jobId, error: err.message },
    );
  } finally {
    await closeAllActivePages(activePages);
    state.currentPlatform = null;
    state.campaignQueueInProgress = false;
    try {
      db.prepare(
        "UPDATE settings SET value = 'false' WHERE key = 'campaign_queue_lock'",
      ).run();
    } catch (err) {
      logger.error(
        "SERVER",
        "[CONNECTION-QUEUE] Failed to release persistent queue lock: ",
        err.message,
      );
    }
  }
}

module.exports = { runConnectionQueueJob };
