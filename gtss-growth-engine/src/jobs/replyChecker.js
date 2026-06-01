const crypto = require("crypto");
const cron = require("node-cron");
const { detectReplies } = require("../services/replyDetector");
const { isSessionValid } = require("../automation/sessionManager");
const { getPlatformKeys } = require("../services/platformCatalog");
const logger = require("../utils/logger");

// Initializes the cron job to check for replies periodically.
// Runs every 30 minutes by default: "*/30 * * * *"
function initReplyChecker() {
  logger.info("Initializing Reply Checker cron job (runs every 30 mins)");

  cron.schedule(
    "*/30 * * * *",
    async () => {
      const jobId = crypto.randomUUID();
      logger.db(
        "info",
        "dm_check",
        "start",
        "Scheduled reply detection started",
        { jobId },
      );
      logger.info("Cron triggered: Starting scheduled reply detection...");

      let totalReplies = 0;

      for (const platform of getPlatformKeys()) {
        if (isSessionValid(platform)) {
          try {
            const result = await detectReplies(platform, () => {}, {
              headless: true,
              allowHeadlessSocial: true,
              trace: false,
            });
            totalReplies += result.repliesFound;
          } catch (err) {
            logger.error(`Cron error detecting replies for ${platform}`, {
              error: err.message,
            });
            logger.db(
              "error",
              "dm_check",
              "platform",
              `Reply detection failed for ${platform}`,
              { jobId, platform, error: err.message },
            );
          }
        } else {
          logger.debug(
            `Skipping scheduled reply detection for ${platform} (no valid session)`,
          );
        }
      }

      logger.info(
        `Scheduled reply detection completed. Total replies found: ${totalReplies}`,
      );
      logger.db(
        "info",
        "dm_check",
        "complete",
        "Scheduled reply detection completed",
        { jobId, repliesFound: totalReplies },
      );
    },
    {
      noOverlap: true,
      name: "reply-checker",
    },
  );
}

module.exports = {
  initReplyChecker,
};
