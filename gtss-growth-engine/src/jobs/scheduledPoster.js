const cron = require("node-cron");
const fs = require("fs");
const { getDb } = require("../db/database");
const {
  publishPost,
  getPostMediaPaths,
  getPrimaryPostMediaPath,
  getPostLocationTag,
} = require("../services/schedulerService");
const { isCheckingInbox } = require("../services/instagramReplyChecker");
const logger = require("../utils/logger");

const MAX_RETRIES = 5;
const BACKOFF_MINUTES = [2, 5, 15, 30, 60];

let isPublishing = false;

function logScheduledPost(level, stage, message, context = {}) {
  logger.db(level, "scheduled_post", stage, message, context);
}

function buildScheduledPostEmitter(jobId, post) {
  return (event = {}) => {
    const type = String(event.type || event.stage || "event").toLowerCase();
    const stage = event.stage || event.type || "event";
    let level = "info";
    if (type === "error") level = "error";
    if (type === "warning" || type === "warn") level = "warn";
    if (type === "retry" || type === "retrying") level = "retry";

    const message = event.message || String(stage);
    const context = {
      jobId,
      postId: post?.id,
    };
    if (event.platform) context.platform = event.platform;
    if (event.error) context.error = event.error;

    logScheduledPost(level, stage, message, context);

    const platformLabel = event.platform ? `${event.platform}: ` : "";
    if (level === "error") {
      logger.error(`[Cron Publish] ${platformLabel}${message}`);
    } else if (level === "warn") {
      logger.warn(`[Cron Publish] ${platformLabel}${message}`);
    } else {
      logger.info(`[Cron Publish] ${platformLabel}${message}`);
    }
  };
}

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

async function deleteMediaFiles(mediaPaths) {
  await Promise.all(mediaPaths.map((mediaPath) => deleteMediaFile(mediaPath)));
}

// Initializes the cron job to publish scheduled posts.
// Runs every minute: "* * * * *"
function initScheduledPoster() {
  logger.info("Initializing Scheduled Poster cron job (runs every minute)");

  // isPublishing prevents overlap; node-cron does not support a noOverlap option.
  cron.schedule(
    "* * * * *",
    async () => {
      if (isPublishing) {
        logger.debug("Scheduled poster already running, skipping tick.");
        return;
      }

      if (isCheckingInbox()) {
        logger.debug(
          "Scheduled poster deferred: Instagram inbox checker is currently running.",
        );
        return;
      }

      const { isCampaignQueueRunning } = require("./backgroundJobs");

      if (isCampaignQueueRunning()) {
        logger.debug(
          "Scheduled poster deferred: campaign queue is currently running.",
        );
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

        const duePosts = db
          .prepare(
            `SELECT *
             FROM posts
             WHERE (
               status = 'scheduled'
               AND scheduled_at IS NOT NULL
               AND datetime(scheduled_at) <= datetime('now')
             )
             OR (
               status = 'failed'
               AND retry_count < ?
               AND next_retry_at IS NOT NULL
               AND datetime(next_retry_at) <= datetime('now')
             )
             ORDER BY datetime(COALESCE(next_retry_at, scheduled_at)) ASC`,
          )
          .all(MAX_RETRIES);

        if (duePosts.length === 0) return;

        logger.info(`Cron: Found ${duePosts.length} due post(s) to publish`);

        for (const post of duePosts) {
          const jobId = `post:${post.id}`;
          logScheduledPost(
            "info",
            "start",
            `Scheduled post ${post.id} publish started`,
            { jobId, postId: post.id, platforms: post.platforms },
          );

          try {
            const emit = buildScheduledPostEmitter(jobId, post);
            const result = await publishPost(post.id, emit, {
              trace: false,
              skipPostStatusUpdate: true,
            });

            const anySucceeded = result.success.length > 0;
            const anyFailed = result.failed.length > 0;

            if (anySucceeded && !anyFailed) {
              db.prepare(
                `UPDATE posts
                 SET status = 'published',
                     published_at = CURRENT_TIMESTAMP,
                     retry_count = 0,
                     next_retry_at = NULL,
                     last_error = NULL
                 WHERE id = ?`,
              ).run(post.id);
              logger.info(`Cron: Post ${post.id} fully published.`);
              logScheduledPost(
                "info",
                "complete",
                `Scheduled post ${post.id} published`,
                { jobId, postId: post.id, success: result.success },
              );
              continue;
            }

            if (anySucceeded && anyFailed) {
              logger.warn(`Cron: Post ${post.id} partially published.`, {
                succeeded: result.success,
                failed: result.failed,
              });
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
              await deleteMediaFiles(getPostMediaPaths(post));
              logger.error(
                `Cron: Post ${post.id} permanently failed after ${MAX_RETRIES} retries.`,
              );
              logScheduledPost(
                "error",
                "failed",
                `Scheduled post ${post.id} permanently failed`,
                { jobId, postId: post.id, error: failureSummary },
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
            logScheduledPost(
              "retry",
              "retry",
              `Scheduled post ${post.id} retry scheduled (attempt ${newRetryCount}/${MAX_RETRIES})`,
              { jobId, postId: post.id, nextRetryAt },
            );
          } catch (err) {
            if (err.message && err.message.includes("already in use")) {
              logger.warn(
                `Cron: Post ${post.id} deferred — browser profile locked by another process. Will retry next tick.`,
              );
              continue;
            }

            logger.error(`Cron: Unhandled error publishing post ${post.id}`, {
              error: err.message,
            });

            logScheduledPost(
              "error",
              "error",
              `Scheduled post ${post.id} publish error`,
              { jobId, postId: post.id, error: err.message },
            );

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
              await deleteMediaFiles(getPostMediaPaths(post));
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
              logScheduledPost(
                "retry",
                "retry",
                `Scheduled post ${post.id} retry scheduled (attempt ${newRetryCount}/${MAX_RETRIES})`,
                { jobId, postId: post.id, nextRetryAt },
              );
            }
          }
        }
      } finally {
        isPublishing = false;
      }
    },
    {
      name: "scheduled-poster",
    },
  );
}

async function postToInstagram(post, browser, emitter) {
  const db = getDb();
  const loadedPost =
    db.prepare("SELECT * FROM posts WHERE id = ?").get(post.id) || post;
  const igPostType = loadedPost.ig_post_type || "feed";
  const mediaPaths = getPostMediaPaths(loadedPost);
  const primaryMediaPath = getPrimaryPostMediaPath(loadedPost);
  const locationTag = getPostLocationTag(loadedPost);

  const context = await browser.newContext();
  const page = await context.newPage();

  let result = { success: false };
  try {
    const instagram = require("../automation/instagram");
    switch (igPostType) {
      case "story":
        result = await instagram.postStory(
          page,
          { imagePath: primaryMediaPath },
          emitter,
        );
        break;
      case "carousel":
        result = await instagram.postCarousel(
          page,
          {
            imagePaths: mediaPaths,
            caption: loadedPost.body,
            locationTag,
          },
          emitter,
        );
        break;
      case "feed":
      default:
        result = await instagram.postImage(
          page,
          {
            imagePath: primaryMediaPath,
            caption: loadedPost.body,
            locationTag,
          },
          emitter,
        );
        break;
    }
  } finally {
    await page.close();
    await context.close();
  }
  return result;
}

async function postToPlatform(platform, post, browser, emitter) {
  switch (platform) {
    case "instagram":
      return await postToInstagram(post, browser, emitter);
    default:
      return { success: false, error: `Unsupported platform: ${platform}` };
  }
}

function isScheduledPosterRunning() {
  return isPublishing;
}

module.exports = {
  initScheduledPoster,
  postToInstagram,
  postToPlatform,
  isScheduledPosterRunning,
};
