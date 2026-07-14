/**
 * backgroundJobs/runDmQueueJob.js
 *
 * Cron-triggered worker for the campaign DM Queue (LinkedIn / IG / X /
 * Facebook direct messages). Mirrors runConnectionQueueJob's structure
 * exactly — the only difference is the underlying queue table
 * (dm_jobs vs connection_jobs) and the queue processor
 * (processDmQueue vs processConnectionQueue).
 *
 * Same re-entrancy guard (state.campaignQueueInProgress), same cluster-
 * safe DB lock (campaign_queue_lock setting), same browser pre-launch +
 * Proxy page + close-on-finally flow.
 *
 * The DM query also includes status='scheduled' (DMs that were promoted
 * from 'pending' by the connection-queue outcome handler after a
 * connection was accepted) on top of the standard pending/retryable
 * statuses.
 */

const crypto = require("crypto");
const { getDb } = require("../../db/database");
const logger = require("../../utils/logger");
const { processDmQueue } = require("../../campaign/dmQueue");
const { state } = require("./state");
const {
  launchRequiredBrowsers,
  closeAllActivePages,
  createProxyPage,
} = require("./browserLifecycle");

/**
 * Worker runner job for campaign messaging DM Queue.
 */
async function runDmQueueJob(options = {}) {
  if (state.campaignQueueInProgress) {
    logger.info(
      "SERVER",
      "[DM-QUEUE] Skipping execution: another campaign outreach queue run is in progress.",
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
        "[DM-QUEUE] Skipping execution: another cluster instance or runner has acquired the queue lock.",
      );
      return;
    }
  } catch (err) {
    logger.error(
      "SERVER",
      "[DM-QUEUE] Failed to acquire persistent queue lock: ",
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
      "[DM-QUEUE] Starting campaign DM messaging queue run...",
    );
    logger.db("info", "campaign_dm", "start", "Campaign DM queue run started", {
      jobId,
    });

    const maxRetries = 5;
    const rows = db
      .prepare(
        `
      SELECT DISTINCT c.platform
      FROM dm_jobs dj
      JOIN campaigns c ON dj.campaign_id = c.id
      JOIN leads l ON dj.lead_id = l.id
      WHERE (dj.status = 'pending' OR dj.status = 'scheduled' OR (dj.status = 'failed' AND dj.retry_count < ? AND (dj.next_retry_at IS NULL OR datetime(dj.next_retry_at) <= datetime('now'))))
        AND c.status = 'active'
    `,
      )
      .all(maxRetries);

    if (rows.length === 0) {
      logger.info(
        "SERVER",
        "[DM-QUEUE] No active platform campaigns have pending, scheduled, or retryable DM messaging jobs.",
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
      `[DM-QUEUE] Pre-flight inspection: Launching contexts for platforms: ${requiredPlatforms.join(", ")}`,
    );

    activePages = await launchRequiredBrowsers(requiredPlatforms);
    const proxyPage = createProxyPage(activePages);

    const report = await processDmQueue(proxyPage, options);
    logger.info(
      "SERVER",
      `[DM-QUEUE] DM queue batch processing complete: ${JSON.stringify(report)}`,
    );
    logger.db(
      "info",
      "campaign_dm",
      "complete",
      "Campaign DM queue run completed",
      { jobId, report },
    );
  } catch (err) {
    logger.error(
      "SERVER",
      "[DM-QUEUE] DM queue cron runner encountered a critical error",
      err,
    );
    logger.db("error", "campaign_dm", "error", "Campaign DM queue run failed", {
      jobId,
      error: err.message,
    });
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
        "[DM-QUEUE] Failed to release persistent queue lock: ",
        err.message,
      );
    }
  }
}

module.exports = { runDmQueueJob };
