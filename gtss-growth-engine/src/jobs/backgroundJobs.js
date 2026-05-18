require("dotenv").config();

const { initReplyChecker } = require("./replyChecker");
const { initScheduledPoster } = require("./scheduledPoster");
const { initInstagramWarmupJobs } = require("./instagramWarmupJob");
const { getDb } = require("../db/database");
const { stopAllJobs } = require("../automation/executor");
const { closeAllBrowsers } = require("../automation/browserBase");
const logger = require("../utils/logger");

let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn(
    "SERVER",
    `Background automation worker received ${signal}. Shutting down.`,
  );

  try {
    stopAllJobs();
    await closeAllBrowsers();
    logger.info("SERVER", "Background automation worker shutdown complete.");
    process.exit(0);
  } catch (error) {
    logger.error(
      "SERVER",
      "Background automation worker shutdown failed",
      error,
    );
    process.exit(1);
  }
}

function startBackgroundJobs() {
  logger.info("SERVER", "Background automation worker initializing.");
  initReplyChecker();
  initScheduledPoster();
  initInstagramWarmupJobs();

  // Cleanup orphan uploads (older than 7 days) at 3 AM daily
  const cron = require("node-cron");
  const fs = require("fs");
  const path = require("path");
  cron.schedule("0 3 * * *", () => {
    const dir = path.join(__dirname, "../../public/uploads");
    if (!fs.existsSync(dir)) return;
    const db = getDb();
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    fs.readdirSync(dir).forEach((f) => {
      const fp = path.join(dir, f);
      try {
        const stats = fs.statSync(fp);
        const pendingRow = db
          .prepare(
            `SELECT 1
             FROM posts
             WHERE media_path IN (?, ?, ?)
               AND (
                 status IN ('scheduled', 'draft')
                 OR (status = 'failed' AND (retry_count > 0 OR next_retry_at IS NOT NULL))
               )
             LIMIT 1`,
          )
          .get(fp, `/uploads/${f}`, `uploads/${f}`);

        if (!pendingRow && stats.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          logger.info("SERVER", `Cleaned up orphan upload: ${f}`);
        } else if (pendingRow) {
          logger.debug(
            "SERVER",
            `Keeping upload referenced by pending post: ${f}`,
          );
        }
      } catch (e) {
        /* ignore */
      }
    });
  });

  // Pipeline cron — run the full outreach pipeline on schedule
  const { pipelineCron } = require('../config/pipelineConfig');
  const { runFullPipeline } = require('../pipeline/pipelineRunner');
  const cronExpression = pipelineCron();

  if (cronExpression && cron.validate(cronExpression)) {
    cron.schedule(cronExpression, async () => {
      logger.info('PIPELINE', `Scheduled pipeline run triggered (cron: ${cronExpression})`);
      try {
        const runId = await runFullPipeline('cron');
        logger.info('PIPELINE', `Scheduled pipeline run completed: #${runId}`);
      } catch (err) {
        logger.error('PIPELINE', 'Scheduled pipeline run failed', { error: err.message });
      }
    });
    logger.info('SERVER', `Pipeline cron registered: ${cronExpression}`);
  } else if (cronExpression) {
    logger.warn('SERVER', `Invalid PIPELINE_CRON expression: "${cronExpression}" — pipeline cron NOT registered`);
  }

  // Instagram Inbox Reply Checker cron (runs every 30 minutes)
  const { checkInbox, checkFollowBacks } = require("../services/instagramReplyChecker");
  cron.schedule("*/30 * * * *", async () => {
    logger.info("SERVER", "Running scheduled Instagram checkInbox job...");
    try {
      await checkInbox();
      logger.info("SERVER", "Scheduled Instagram checkInbox job completed successfully.");
    } catch (err) {
      logger.error("SERVER", "Scheduled Instagram checkInbox job failed", err);
    }
  });
  logger.info("SERVER", "Instagram inbox checker cron registered: every 30 minutes");

  // Instagram Follow-Backs cron (runs at 4 AM daily)
  cron.schedule("0 4 * * *", async () => {
    logger.info("SERVER", "Running scheduled Instagram checkFollowBacks job...");
    try {
      const result = await checkFollowBacks();
      logger.info("SERVER", `Scheduled Instagram checkFollowBacks job completed. Found ${result.newFollowBacksCount || 0} new follow-backs.`);
    } catch (err) {
      logger.error("SERVER", "Scheduled Instagram checkFollowBacks job failed", err);
    }
  });
  logger.info("SERVER", "Instagram follow-backs cron registered: daily at 4:00 AM");

  logger.info("SERVER", "Background automation worker initialized.");
}

if (require.main === module && process.env.DISABLE_BACKGROUND_JOBS !== "true") {
  startBackgroundJobs();
}

process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

module.exports = {
  startBackgroundJobs,
};
