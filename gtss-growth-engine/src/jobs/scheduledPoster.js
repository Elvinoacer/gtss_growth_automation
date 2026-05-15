const cron = require("node-cron");
const { getDb } = require("../db/database");
const { publishPost } = require("../services/schedulerService");
const logger = require("../utils/logger");

// Initializes the cron job to publish scheduled posts.
// Runs every minute: "* * * * *"
function initScheduledPoster() {
  logger.info("Initializing Scheduled Poster cron job (runs every minute)");

  cron.schedule(
    "* * * * *",
    async () => {
      const db = getDb();

      // Check if scheduler is paused
      const pausedRow = db
        .prepare("SELECT value FROM settings WHERE key = 'scheduler_paused'")
        .get();
      if (pausedRow && pausedRow.value === "true") {
        logger.debug("Scheduled poster is paused. Skipping.");
        return;
      }

      // Find all posts that are due
      const duePosts = db
        .prepare(
          `
      SELECT * FROM posts
      WHERE status = 'scheduled'
        AND scheduled_at <= datetime('now')
    `,
        )
        .all();

      if (duePosts.length === 0) return;

      logger.info(`Cron: Found ${duePosts.length} due post(s) to publish`);

      for (const post of duePosts) {
        try {
          const noopEmit = (event) => {
            logger.info(
              `[Cron Publish] ${event.platform || ""}: ${event.message || event.type}`,
            );
          };

          const result = await publishPost(post.id, noopEmit, {
            headless: true,
            allowHeadlessSocial: true,
            trace: false,
          });
          logger.info(`Cron: Published post ${post.id}`, {
            success: result.success,
            failed: result.failed,
          });
        } catch (err) {
          logger.error(`Cron: Failed to publish post ${post.id}`, {
            error: err.message,
          });
          // Mark as failed so it doesn't retry indefinitely
          db.prepare(`UPDATE posts SET status = 'failed' WHERE id = ?`).run(
            post.id,
          );
        }
      }
    },
    {
      noOverlap: true,
      name: "scheduled-poster",
    },
  );
}

module.exports = {
  initScheduledPoster,
};
