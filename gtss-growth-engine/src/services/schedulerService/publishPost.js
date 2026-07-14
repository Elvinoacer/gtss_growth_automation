/**
 * Scheduler Service — publishPost (multi-platform publisher)
 * publishPost — the central multi-platform publisher. Loads the post row,
 * pre-flights media files, iterates each target platform, drives the
 * per-platform postToX / postToLinkedIn / postToFacebook /
 * instagram.postImage|postStory|postCarousel flow inside a 3-attempt
 * retry loop that REUSES the same browserState across attempts (so a
 * transient failure doesn't flicker the user's Chrome), updates the
 * posts table status at the end, and cleans up media files on success.
 * Extracted from the original schedulerService.js for maintainability.
 *
 * This is a single ~450-line function — allowed to exceed 500 lines per
 * the worklog rules. Kept intact because the per-platform switch and the
 * retry-loop control flow are tightly intertwined and splitting them
 * would obscure the FIX 2a (tab-reuse-across-retries) and FIX 2c/2d
 * (close-reason differentiation) logic.
 */

const { getDb } = require("../../db/database");
const {
  createBrowser,
  closeBrowser,
  closeBrowserContext,
  createInstagramBrowser,
} = require("../../automation/browserBase");
const { isSessionValid } = require("../../automation/sessionManager");
const { logActivity } = require("../auditService");
const logger = require("../../utils/logger");
const {
  preparePlatformPostBody,
} = require("./textNormalization");
const {
  getPostMediaPaths,
  getPostLocationTag,
  resolveMediaFilePath,
  deleteMediaFiles,
} = require("./mediaPaths");
const { postToLinkedIn } = require("./postLinkedIn");
const { postToX } = require("./postX");
const { postToFacebook } = require("./postFacebook");

async function publishPost(postId, emit, browserOptions = {}) {
  const { skipPostStatusUpdate = false, ...launchOptions } = browserOptions;
  const db = getDb();
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId);
  if (!post) throw new Error(`Post ${postId} not found`);

  // ── Media pre-flight ──────────────────────────────────────────────────────
  const mediaPaths = getPostMediaPaths(post);
  if (mediaPaths.length > 0) {
    const resolvedMediaPaths = mediaPaths
      .map((mediaPath) => resolveMediaFilePath(mediaPath))
      .filter(Boolean);

    if (resolvedMediaPaths.length === 0) {
      emit({
        type: "error",
        message: `Media file not found on disk: ${mediaPaths.join(", ")}. Post will be published without media.`,
      });
      post.media_paths = null;
      post.media_path = null;
    } else if (
      resolvedMediaPaths.length < mediaPaths.length &&
      post.ig_post_type === "carousel"
    ) {
      emit({
        type: "error",
        message: `Missing files for Instagram carousel. Found ${resolvedMediaPaths.length} of ${mediaPaths.length} files. Post failed.`,
      });
      if (!skipPostStatusUpdate) {
        db.prepare(
          "UPDATE posts SET status = 'failed', last_error = ? WHERE id = ?",
        ).run("Missing carousel media files", postId);
      }
      return { success: [], failed: JSON.parse(post.platforms) };
    } else {
      post.media_paths = JSON.stringify(resolvedMediaPaths);
      post.media_path = resolvedMediaPaths[0];
      const ALLOWED_EXT = /\.(jpe?g|png|gif|webp|mp4|mov|avi|mkv|m4v)$/i;
      if (!ALLOWED_EXT.test(post.media_path)) {
        emit({
          type: "warning",
          message: `Unexpected file extension for media: ${post.media_path}. Skipping media.`,
        });
        post.media_paths = null;
        post.media_path = null;
      }
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const platforms = JSON.parse(post.platforms);
  const succeeded = [];
  const failed = [];
  const failureMessages = [];

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (const platform of platforms) {
    emit({ type: "info", platform, message: `Publishing to ${platform}...` });

    if (!isSessionValid(platform)) {
      emit({
        type: "warning",
        platform,
        message: `No valid session for ${platform}. Skipping.`,
      });
      failed.push(platform);
      continue;
    }

    let platformSuccess = false;
    let lastPlatformError = null;

    // ─── Tab reuse across retries (NEW, FIX 2a) ───────────────────────────
    //
    // Previously `browserState` was declared INSIDE the per-attempt try
    // block and `closeBrowserContext(...)` was called in the per-attempt
    // `finally`. That meant every attempt — whether it succeeded or
    // failed — opened a tab, did a few seconds of work, then closed the
    // tab. If all 3 attempts failed quickly (selector drift, modal
    // Chrome shows, network blip), the user saw the tab open and close
    // three times in ~15 seconds — the "tab opens then closes
    // immediately" symptom.
    //
    // Now `browserState` is hoisted to the platform-loop scope. We only
    // call createBrowser/createInstagramBrowser ONCE per platform (or
    // again only if the previous page died mid-attempt). The retry loop
    // reuses the SAME tab across attempts. The tab is closed ONCE in an
    // OUTER finally after the loop — either because the post succeeded
    // (with a short visible delay so the user can confirm) or because
    // all 3 attempts failed.
    //
    // The `success` flag is passed to closeBrowserContext so the log
    // line can distinguish "Closed automation tab after successful
    // post" from "Closed automation tab after failed attempt (n/3)".
    let browserState = null;
    let standaloneBrowser = null;
    let standaloneContext = null;

    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        let browser, context;
        try {
          emit({
            type: "info",
            platform,
            message: `Attempt ${attempt}/3 for ${platform}`,
          });
          logger.db("info", "content", "publish", `Publishing attempt ${attempt}/3 for ${platform}`, {
            postId,
            platform,
            attempt,
          });
          logActivity({
            activityType: "post_attempt",
            entityType: "post",
            entityId: postId,
            platform,
            status: "running",
            summary: `Publishing ${platform} attempt ${attempt}/3`,
            details: { attempt },
          });

          // Only open a fresh browser/tab when we don't already have a
          // usable one from a previous attempt. If the previous attempt
          // failed but the page is still alive (the common case — a
          // selector timeout doesn't close the tab), reuse it so we
          // don't flicker the user's Chrome.
          //
          // If the previous attempt's page DID die (e.g. an uncaught
          // error called page.close() somewhere, or Chrome crashed the
          // tab), close the dead browserState first to release its
          // lock, then create a fresh one.
          if (browserState && (!browserState.page || browserState.page.isClosed())) {
            try {
              await closeBrowserContext(platform, browserState, {
                success: false,
                attempt,
                reason: "page-closed-mid-attempt",
              });
            } catch (closeErr) {
              logger.warn(`Error closing dead browser state for ${platform} before retry`, {
                error: closeErr.message,
                attempt,
              });
            }
            browserState = null;
            standaloneBrowser = null;
            standaloneContext = null;
          }

          if (!browserState) {
            if (platform === "instagram") {
              // Instagram needs the specialized launcher so it can attach to the
              // running Chrome session or restore cookies before posting. Posting
              // must go straight to the compose flow; organic warmup belongs to the
              // dedicated warmup job and can otherwise trap scheduled posts scrolling.
              browserState = await createInstagramBrowser({ skipDailyWarmup: true });
            } else {
              browserState = await createBrowser(platform, launchOptions);
            }
            standaloneBrowser = browserState.browser;
            standaloneContext = browserState.context;
          }

          browser = browserState.browser;
          context = browserState.context;
          const page = browserState.page;

          // ── Per-platform caption resolution ──────────────────────────────
          // The content pipeline persists one caption per platform in
          // `posts.captions_json`. Use the platform-specific caption if
          // available; otherwise fall back to `posts.body` (the primary
          // caption). Previously the publisher re-normalised the SAME
          // primary caption for every platform, so an Instagram-length
          // caption (2200 chars) would get truncated to 280 chars on X
          // instead of using the X-tailored caption that had been
          // generated specifically for X.
          let perPlatformBody = post.body;
          try {
            if (post.captions_json) {
              const captionsMap = JSON.parse(post.captions_json);
              if (captionsMap && typeof captionsMap === 'object' && typeof captionsMap[platform] === 'string' && captionsMap[platform].length > 0) {
                perPlatformBody = captionsMap[platform];
              }
            }
          } catch (_) { /* fall back to post.body */ }
          const platformBody = preparePlatformPostBody(platform, perPlatformBody);

          let success = false;
          switch (platform) {
          case "linkedin":
            success = await postToLinkedIn(
              page,
              platformBody,
              post.media_path,
              emit,
            );
            break;
          case "x":
            success = await postToX(page, platformBody, post.media_path, emit);
            break;
          case "facebook":
            success = await postToFacebook(
              page,
              platformBody,
              post.media_path,
              emit,
            );
            break;
          case "instagram":
            {
              const instagram = require("../../automation/instagram");
              const locationTag = getPostLocationTag(post);
              // Resolve the full set of media paths for this post. When the
              // user grouped multiple images together (or uploaded a carousel
              // set), media_paths will have >1 entry and we should drive the
              // carousel flow instead of forcing a single-image post.
              const allMediaPaths = getPostMediaPaths(post);
              const isVideoPost = allMediaPaths.some((p) => /\.(mp4|mov|avi|mkv|m4v)$/i.test(p || ""));
              const effectiveIgType =
                post.ig_post_type === "story"
                  ? "story"
                  : allMediaPaths.length > 1
                    ? "carousel"
                    : isVideoPost
                      ? "video"
                      : "feed";
              if (effectiveIgType === "story") {
                const res = await instagram.postStory(
                  page,
                  { imagePath: post.media_path },
                  emit,
                );
                success = res.success;
                if (!success && res && res.error) {
                  failureMessages.push(`instagram: ${res.error}`);
                  emit({
                    type: "error",
                    platform,
                    message: `Instagram story failed: ${res.error}`,
                  });
                }
              } else if (effectiveIgType === "carousel") {
                const res = await instagram.postCarousel(
                  page,
                  {
                    imagePaths: allMediaPaths,
                    caption: platformBody,
                    locationTag,
                  },
                  emit,
                );
                success = res.success;
                if (!success && res && res.error) {
                  failureMessages.push(`instagram: ${res.error}`);
                  emit({
                    type: "error",
                    platform,
                    message: `Instagram carousel failed: ${res.error}`,
                  });
                }
              } else {
                // Single feed post (image or video — instagram.postImage
                // handles both, the name is historical).
                const res = await instagram.postImage(
                  page,
                  {
                    imagePath: post.media_path,
                    caption: platformBody,
                    locationTag,
                  },
                  emit,
                );
                success = res.success;
                if (!success && res && res.error) {
                  failureMessages.push(`instagram: ${res.error}`);
                  emit({
                    type: "error",
                    platform,
                    message: `Instagram post failed: ${res.error}`,
                  });
                }
              }
            }
            break;
          default:
            emit({
              type: "warning",
              platform,
              message: `Unknown platform: ${platform}`,
            });
            throw new Error(`Unknown platform: ${platform}`);
        }

        if (success) {
          succeeded.push(platform);
          platformSuccess = true;
          emit({
            type: "published",
            platform,
            postId,
            message: `✓ Posted to ${platform}`,
          });
          logger.db("info", "content", "publish", `Published to ${platform}`, {
            postId,
            platform,
            attempt,
          });
          logActivity({
            activityType: "post_attempt",
            entityType: "post",
            entityId: postId,
            platform,
            status: "success",
            summary: `Published to ${platform}`,
            details: { attempt },
          });
          break;
        } else {
          lastPlatformError = new Error(`Failed to post to ${platform}`);
          emit({
            type: attempt < 3 ? "warning" : "error",
            platform,
            message: `Attempt ${attempt}/3 failed for ${platform}`,
          });
          // DON'T close the tab here — the next attempt will reuse it.
          // The tab is closed once at the end of the platform-loop in
          // the outer finally below.
        }
      } catch (err) {
        lastPlatformError = err;
        logger.error(`Error publishing to ${platform}`, { error: err.message, attempt });
        emit({
          type: attempt < 3 ? "warning" : "error",
          platform,
          message: `Attempt ${attempt}/3 failed for ${platform}: ${err.message}`,
        });
        logger.db("warn", "content", "publish", `Platform ${platform} attempt ${attempt}/3 failed`, {
          postId,
          platform,
          attempt,
          error: err.message,
        });
        logActivity({
          activityType: "post_attempt",
          entityType: "post",
          entityId: postId,
          platform,
          status: "failure",
          summary: `${platform} attempt ${attempt}/3 failed`,
          details: { attempt, error: err.message },
        });
        // DON'T close the tab here either — the next attempt will
        // reuse it (or close it if the page died). The outer finally
        // handles final cleanup.
      }

        if (!platformSuccess && attempt < 3) {
          await wait(15000);
        }
      }
    } finally {
      // ─── Close once after the retry loop is fully done (FIX 2a) ────────
      //
      // This is the ONLY place we close the tab/browser for this
      // platform. Whether we succeeded on attempt 1, failed all 3
      // times, or threw an uncaught error — this finally runs once.
      // That eliminates the open→close→wait→open→close flicker that
      // used to happen on every transient failure.
      //
      // The `success` flag tells closeBrowserContext (and the log
      // line it emits) whether this close is "after successful post"
      // or "after failed attempt (n/3)" — see FIX 2c/2d in
      // browserBase.js closeBrowser.
      if (browserState) {
        try {
          await closeBrowserContext(platform, browserState, {
            success: platformSuccess,
            attempt: 3,
          });
        } catch (closeErr) {
          logger.warn(`Error closing browser state for ${platform} after retry loop`, {
            error: closeErr.message,
          });
        }
      } else if (standaloneBrowser) {
        // Rare path: createBrowser threw before browserState was
        // assigned but the browser object was created. Fallback to the
        // old closeBrowser(browser, ...) signature.
        try {
          await closeBrowser(standaloneBrowser, platform, standaloneContext);
        } catch (closeErr) {
          logger.warn(`Error closing standalone browser for ${platform}`, {
            error: closeErr.message,
          });
        }
      }
    }

    if (!platformSuccess) {
      failed.push(platform);
      const message =
        lastPlatformError?.message || `All attempts failed for ${platform}`;
      failureMessages.push(`${platform}: ${message}`);
      emit({
        type: "error",
        platform,
        message: `All 3 attempts failed for ${platform}: ${message}`,
      });
      logger.db("error", "content", "publish", `All 3 attempts failed for ${platform}`, {
        postId,
        platform,
        error: message,
      });
    }
  }

  // Update post status unless the caller is managing cron state separately.
  if (!skipPostStatusUpdate) {
    if (succeeded.length > 0) {
      db.prepare(
        `UPDATE posts
         SET status = 'published',
             published_at = CURRENT_TIMESTAMP,
             last_error = NULL
         WHERE id = ?`,
      ).run(postId);
    } else {
      const lastError =
        failureMessages.length > 0
          ? failureMessages.join("; ")
          : failed.length > 0
            ? `Failed platforms: ${failed.join(", ")}`
            : "Publish failed";
      db.prepare(
        `UPDATE posts SET status = 'failed', last_error = ? WHERE id = ?`,
      ).run(lastError, postId);
    }
  }

  // Cleanup uploaded media file
  const cleanupMediaPaths = getPostMediaPaths(post);
  if (cleanupMediaPaths.length > 0 && failed.length === 0) {
    await deleteMediaFiles(cleanupMediaPaths);
  } else if (cleanupMediaPaths.length > 0 && failed.length > 0) {
    logger.info("Keeping media file for retry", { path: cleanupMediaPaths[0] });
  }

  return { success: succeeded, failed };
}

module.exports = {
  publishPost,
};
