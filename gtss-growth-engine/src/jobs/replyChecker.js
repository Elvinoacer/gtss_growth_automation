const crypto = require("crypto");
const cron = require("node-cron");
const { detectReplies } = require("../services/replyDetector");
const { isSessionValid } = require("../automation/sessionManager");
const { getPlatformKeys } = require("../services/platformCatalog");
const logger = require("../utils/logger");

/**
 * Returns true if the DM Inbox Checker pipeline is enabled.
 *
 * The reply checker cron is a long-running background job, but it MUST honor
 * the user's intent: if the `dm_check` pipeline schedule is disabled (the
 * default) or the `pipeline_dm_check_paused` setting is "true", the cron
 * tick is a no-op. This keeps the DM checker OFF by default — the user has
 * to explicitly enable the pipeline on the Pipelines page (or via the API)
 * before any inbox scanning happens.
 */
function isDmCheckEnabled() {
  try {
    const { getDb } = require("../db/database");
    const db = getDb();
    const row = db
      .prepare("SELECT enabled FROM pipeline_schedules WHERE id = 'dm_check'")
      .get();
    if (!row || !row.enabled) return false;

    const paused = db
      .prepare("SELECT value FROM settings WHERE key = 'pipeline_dm_check_paused'")
      .get();
    if (paused && String(paused.value).toLowerCase() === "true") return false;

    return true;
  } catch (err) {
    logger.warn("DM check enabled-flag lookup failed; treating as disabled", {
      error: err.message,
    });
    return false;
  }
}

// Initializes the cron job to check for replies periodically.
// Runs every 30 minutes by default: "*/30 * * * *"
//
// IMPORTANT: The cron is always registered (so it can pick up the moment the
// user enables the dm_check pipeline), but each tick bails out immediately
// if the pipeline is disabled or paused. This means the DM Inbox Checker is
// OFF by default — the user must enable it on the Pipelines page first.
function initReplyChecker() {
  logger.info("Initializing Reply Checker cron job (runs every 30 mins; disabled by default — enable the dm_check pipeline to activate)");

  cron.schedule(
    "*/30 * * * *",
    async () => {
      // Gate: respect the pipeline_schedules.enabled flag and the pause
      // setting. The DM checker is disabled by default.
      if (!isDmCheckEnabled()) {
        logger.debug(
          "Skipping scheduled reply detection (dm_check pipeline is disabled or paused). Enable it on the Pipelines page to activate.",
        );
        return;
      }

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
