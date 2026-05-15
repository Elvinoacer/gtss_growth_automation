const cron = require("node-cron");
const fs = require("fs");
const { getDb } = require("../db/database");
const { publishPost } = require("../services/schedulerService");
const logger = require("../utils/logger");

const MAX_RETRIES = 5;
const BACKOFF_MINUTES = [2, 5, 15, 30, 60];

let isPublishing = false;

function backoffMinutes(retryCount) {
  const index = Math.max(retryCount - 1, 0);
  return BACKOFF_MINUTES[Math.min(index, BACKOFF_MINUTES.length - 1)];
}

async function deleteMediaFile(mediaPath) {
  if (!mediaPath) return;

  try {
    await fs.promises.unlink(mediaPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn("Could not delete media file after max retries", {
        path: mediaPath,
        error: error.message,
      });
    }
  }
}

// Initializes the cron job to publish scheduled posts.
// Runs every minute: "* * * * *"
function initScheduledPoster() {
  logger.info("Initializing Scheduled Poster cron job (runs every minute)");

  cron.schedule(
    "* * * * *",
    async () => {
      if (isPublishing) {
        logger.debug("Scheduled poster already running, skipping tick.");
        return;
      }
      isPublishing = true;

      try {
        const db = getDb();
        const pausedRow = db
          .prepare("SELECT value FROM settings WHERE key = 'scheduler_paused'")
          .get();

        if (pausedRow?.value === "true") {
          logger.debug("Scheduled poster is paused. Skipping.");
          return;
        }

        const now = new Date().toISOString();
        const duePosts = db
          .prepare(
            `SELECT *
             FROM posts
             WHERE (
               status = 'scheduled'
               AND scheduled_at <= ?
             )
             OR (
               status = 'failed'
               AND retry_count < ?
               AND next_retry_at IS NOT NULL
               AND next_retry_at <= ?
             )
             ORDER BY COALESCE(next_retry_at, scheduled_at) ASC`,
          )
          .all(now, MAX_RETRIES, now);

        if (duePosts.length === 0) return;

        logger.info(`Cron: Found ${duePosts.length} due post(s) to publish`);

        for (const post of duePosts) {
          const noopEmit = (event) => {
            logger.info(
              `[Cron Publish] ${event.platform || ""}: ${event.message || event.type}`,
            );
          };

          try {
            const result = await publishPost(post.id, noopEmit, {
              headless: true,
              allowHeadlessSocial: true,
              trace: false,
            });

            const anySucceeded = result.success.length > 0;
            const anyFailed = result.failed.length > 0;

            if (anySucceeded) {
              db.prepare(
                `UPDATE posts
                 SET retry_count = 0,
                     next_retry_at = NULL,
                     last_error = NULL
                 WHERE id = ?`,
              ).run(post.id);
            }

            if (anySucceeded && !anyFailed) {
              logger.info(`Cron: Post ${post.id} fully published.`);
              continue;
            }

            if (anySucceeded && anyFailed) {
              logger.warn(`Cron: Post ${post.id} partially published.`, {
                succeeded: result.success,
                failed: result.failed,
              });
              continue;
            }

            const newRetryCount = (post.retry_count || 0) + 1;
            const failureSummary =
              result.failed.length > 0
                ? `Failed platforms: ${result.failed.join(", ")}`
                : "Publish failed";

            if (newRetryCount > MAX_RETRIES) {
              db.prepare(
                `UPDATE posts
                 SET status = 'failed',
                     retry_count = ?,
                     next_retry_at = NULL,
                     last_error = ?
                 WHERE id = ?`,
              ).run(newRetryCount, failureSummary, post.id);
              await deleteMediaFile(post.media_path);
              logger.error(
                `Cron: Post ${post.id} permanently failed after ${MAX_RETRIES} retries.`,
              );
              continue;
            }

            const delayMinutes = backoffMinutes(newRetryCount);
            const nextRetryAt = new Date(
              Date.now() + delayMinutes * 60 * 1000,
            ).toISOString();

            db.prepare(
              `UPDATE posts
               SET status = 'failed',
                   retry_count = ?,
                   next_retry_at = ?,
                   last_error = ?
               WHERE id = ?`,
            ).run(newRetryCount, nextRetryAt, failureSummary, post.id);

            logger.warn(
              `Cron: Post ${post.id} failed (attempt ${newRetryCount}/${MAX_RETRIES}). Retrying at ${nextRetryAt}`,
            );
          } catch (err) {
            logger.error(`Cron: Unhandled error publishing post ${post.id}`, {
              error: err.message,
            });

            const newRetryCount = (post.retry_count || 0) + 1;
            if (newRetryCount > MAX_RETRIES) {
              db.prepare(
                `UPDATE posts
                 SET status = 'failed',
                     retry_count = ?,
                     next_retry_at = NULL,
                     last_error = ?
                 WHERE id = ?`,
              ).run(newRetryCount, err.message, post.id);
              await deleteMediaFile(post.media_path);
            } else {
              const delayMinutes = backoffMinutes(newRetryCount);
              const nextRetryAt = new Date(
                Date.now() + delayMinutes * 60 * 1000,
              ).toISOString();
              db.prepare(
                `UPDATE posts
                 SET status = 'failed',
                     retry_count = ?,
                     next_retry_at = ?,
                     last_error = ?
                 WHERE id = ?`,
              ).run(newRetryCount, nextRetryAt, err.message, post.id);
            }
          }
        }
      } finally {
        isPublishing = false;
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
