/**
 * backgroundJobs/startBackgroundJobs.js
 *
 * The background-jobs worker entry point. Called from index.js when the
 * module is the run-main (i.e. `node src/jobs/backgroundJobs.js` or the
 * desktop launcher spawned it as a child process).
 *
 * Flow:
 *   1. Pipeline lifecycle recovery: sweep any pipeline executions left
 *      in transient states (running/paused/resuming/stopping/retrying)
 *      from a previous server crash and mark them 'failed' so the UI
 *      doesn't show phantom "still running" pipelines.
 *   2. Sync the DB-backed pipeline scheduler (pipelineScheduler.syncFromDb)
 *      so cron schedules edited through the UI take effect immediately.
 *   3. Startup sweeper: reset connection_jobs + dm_jobs stuck in
 *      'running' (from a crashed worker) back to 'pending', and reset
 *      the campaign_queue_lock setting to 'false' (in case the previous
 *      worker crashed mid-run and left the lock stuck).
 *   4. Register the scheduled poster + Instagram warmup jobs.
 *   5. Register the cron jobs (each via node-cron):
 *      - 3 AM daily: cleanupOrphanUploads (deletes uploads >7 days old
 *        not referenced by any pending post).
 *      - 4 AM daily: checkFollowBacks (IG follow-back detector).
 *      - every 20 min: runConnectionQueueJob (campaign connection invites).
 *      - every 2 min: runDmQueueJob (campaign DMs).
 */

const { initInstagramWarmupJobs } = require("../instagramWarmupJob");
const { initScheduledPoster } = require("../scheduledPoster");
const {
  checkFollowBacks,
} = require("../../services/instagramReplyChecker");
const { getDb } = require("../../db/database");
const logger = require("../../utils/logger");

const { runConnectionQueueJob } = require("./runConnectionQueueJob");
const { runDmQueueJob } = require("./runDmQueueJob");
const { cleanupOrphanUploads } = require("./cleanupOrphanUploads");

async function startBackgroundJobs() {
  logger.info("SERVER", "Background automation worker initializing.");

  // ── Pipeline lifecycle recovery: mark any executions left in transient
  //    states (running / paused / resuming / stopping / retrying) as 'failed'
  //    so the UI never shows a phantom "still running" pipeline after a
  //    server restart.
  try {
    const pipelineState = require("../../services/pipelineStateService");
    const recovered = pipelineState.recoverOnStartup();
    logger.info(
      "SERVER",
      `[PIPELINE-RECOVERY] ${recovered.recovered} stale execution(s) marked failed on startup.`,
    );
  } catch (err) {
    logger.error("SERVER", "[PIPELINE-RECOVERY] Failed to sweep stale executions:", err);
  }

  // Centralized DB-backed pipeline scheduler integration
  const pipelineScheduler = require("../pipelineScheduler");
  await pipelineScheduler.syncFromDb();

  // ── STARTUP RECOVERY SWEEPER & LOCK RESET ──────────────────────────────────
  try {
    const db = getDb();

    // Clear connection jobs stuck in 'running' state on server boot
    const connSweep = db
      .prepare(
        `
      UPDATE connection_jobs 
      SET status = 'pending', updated_at = CURRENT_TIMESTAMP 
      WHERE status = 'running'
    `,
      )
      .run();
    logger.info(
      "SERVER",
      `[STARTUP-SWEEP] Reset ${connSweep.changes} connection jobs stuck in 'running' status back to 'pending'.`,
    );

    // Clear DM jobs stuck in 'running' state
    const dmSweep = db
      .prepare(
        `
      UPDATE dm_jobs 
      SET status = 'pending', updated_at = CURRENT_TIMESTAMP 
      WHERE status = 'running'
    `,
      )
      .run();
    logger.info(
      "SERVER",
      `[STARTUP-SWEEP] Reset ${dmSweep.changes} DM jobs stuck in 'running' status back to 'pending'.`,
    );

    // Initialize/Reset the database lock to false
    db.prepare(
      `
      INSERT INTO settings (key, value) VALUES ('campaign_queue_lock', 'false')
      ON CONFLICT(key) DO UPDATE SET value = 'false'
    `,
    ).run();
    logger.info(
      "SERVER",
      "[STARTUP-SWEEP] Initialized/Reset persistent campaign queue lock to 'false'.",
    );
  } catch (err) {
    logger.error(
      "SERVER",
      "[STARTUP-SWEEP] Failed to execute startup sweeper & lock reset: ",
      err,
    );
  }

  // DM/reply checking is registered through the DB-backed pipeline scheduler
  // as pipeline_schedules.id = 'dm_check'.
  initScheduledPoster();
  initInstagramWarmupJobs();

  // Cleanup orphan uploads (older than 7 days) at 3 AM daily
  const cron = require("node-cron");
  cron.schedule("0 3 * * *", () => {
    cleanupOrphanUploads();
  });

  // Instagram Follow-Backs cron (runs at 4 AM daily)
  cron.schedule("0 4 * * *", async () => {
    logger.info(
      "SERVER",
      "Running scheduled Instagram checkFollowBacks job...",
    );
    try {
      const result = await checkFollowBacks();
      logger.info(
        "SERVER",
        `Scheduled Instagram checkFollowBacks job completed. Found ${result.newFollowBacksCount || 0} new follow-backs.`,
      );
    } catch (err) {
      logger.error(
        "SERVER",
        "Scheduled Instagram checkFollowBacks job failed",
        err,
      );
    }
  });
  logger.info(
    "SERVER",
    "Instagram follow-backs cron registered: daily at 4:00 AM",
  );

  // Campaign Connection Queue cron (runs every 20 minutes)
  cron.schedule("*/20 * * * *", async () => {
    logger.info(
      "SERVER",
      "Running scheduled campaign Connection Queue cron job...",
    );
    try {
      await runConnectionQueueJob();
      logger.info(
        "SERVER",
        "Scheduled campaign Connection Queue job completed successfully.",
      );
    } catch (err) {
      logger.error(
        "SERVER",
        "Scheduled campaign Connection Queue job failed",
        err,
      );
    }
  });
  logger.info(
    "SERVER",
    "Campaign Connection Queue cron registered: every 20 minutes",
  );

  // Campaign DM Queue cron (runs every 2 minutes)
  cron.schedule("*/2 * * * *", async () => {
    logger.info("SERVER", "Running scheduled campaign DM Queue cron job...");
    try {
      await runDmQueueJob();
      logger.info(
        "SERVER",
        "Scheduled campaign DM Queue job completed successfully.",
      );
    } catch (err) {
      logger.error("SERVER", "Scheduled campaign DM Queue job failed", err);
    }
  });
  logger.info("SERVER", "Campaign DM Queue cron registered: every 2 minutes");

  logger.info("SERVER", "Background automation worker initialized.");
}

module.exports = { startBackgroundJobs };
