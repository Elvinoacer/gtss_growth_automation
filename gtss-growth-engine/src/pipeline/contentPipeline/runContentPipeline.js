/**
 * contentPipeline/runContentPipeline.js
 *
 * The auto-content pipeline orchestrator. Two public functions:
 *
 *  - runContentPipelineNow(config): the actual run. For each iteration
 *    (up to max_posts_per_run, default 1), picks an asset (library OR
 *    AI-generated), generates per-platform captions (image-aware when
 *    possible), inserts a posts row, and publishes immediately via
 *    publishPost. Stage isolation is preserved: a single iteration's
 *    failure doesn't abort the whole run (we just push a failure result
 *    and continue to the next iteration). The whole run is wrapped in
 *    acquireLock/releaseLock so two concurrent runs (a manual trigger
 *    while a cron run is mid-flight) don't race.
 *
 *  - runContentPipeline(config): thin wrapper that enqueues
 *    runContentPipelineNow via the pipeline queue so concurrent
 *    triggers don't overlap (same pattern as the outreach pipeline).
 *
 * Stage 1 (asset pick OR image gen) is delegated to
 * pickAssetOrGenerateImage.js, and the image-FS-path resolution is
 * delegated to resolveImageFsPath.js — both extracted so this file
 * stays under the 500-line file-size limit. Stages 2 (caption), 3
 * (post record), and 4 (publish) remain inline because they're tightly
 * coupled to the per-iteration state (jobId, emit, signal,
 * lifecycleExecId, updateLifecycle, checkAbort) and threading all of
 * that through helper signatures would obscure the flow.
 */

const crypto = require("crypto");
const { getDb } = require("../../db/database");
const {
  generateCaption,
  publishPost,
} = require("../../services/schedulerService");
const {
  markAssetUsed,
  markAssetGroupUsed,
} = require("../../services/assetRotationService");
const { logActivity } = require("../../services/auditService");
const { withRetry } = require("../../utils/retryHelper");
const jobRegistry = require("../../jobs/jobRegistry");
const logger = require("../../utils/logger");
const { enqueuePipelineRun } = require("../pipelineQueue");
const pipelineState = require("../../services/pipelineStateService");
const pipelineLogger = require("../../services/pipelineLogger");
const checkpointService = require("../../services/pipelineCheckpoint");

const {
  buildContentEmitter,
  acquireLock,
  releaseLock,
  isPaused,
  throwIfAborted,
} = require("./state");
const { pickAssetOrGenerateImage } = require("./pickAssetOrGenerateImage");
const { resolveImageFsPath } = require("./resolveImageFsPath");

/**
 * Run one cycle of the auto-content pipeline.
 *
 * @param {Object} config
 * @param {string[]} config.platforms   - e.g. ['instagram', 'linkedin']
 * @param {string}   config.topic       - Content topic/theme
 * @param {string}   [config.style]     - Image style
 * @param {string}   [config.trigger]   - 'cron' | 'manual'
 * @param {number}   [config.max_posts_per_run] - How many to generate (default 1)
 * @returns {Promise<{ success: boolean, postId?: number, error?: string }>}
 */
async function runContentPipelineNow(config = {}) {
  const {
    platforms: rawPlatforms = ["instagram", "linkedin"],
    topic,
    style = "photorealistic",
    trigger = "manual",
    max_posts_per_run = 1,
  } = config;
  const platforms = Array.isArray(rawPlatforms)
    ? rawPlatforms
        .map((platform) => String(platform).trim().toLowerCase())
        .filter(Boolean)
    : ["instagram", "linkedin"];
  const maxRuns = Math.max(1, Math.floor(Number(max_posts_per_run) || 1));

  if (!topic) {
    logger.warn("CONTENT-PIPELINE", "No topic configured — skipping run");
    return { success: false, error: "No topic configured" };
  }

  if (platforms.length === 0) {
    logger.warn("CONTENT-PIPELINE", "No platforms configured — skipping run");
    return { success: false, error: "No platforms configured" };
  }

  // Overlap lock — prevent concurrent content pipeline runs
  if (!acquireLock()) {
    logger.info(
      "CONTENT-PIPELINE",
      "Skipping: another content pipeline run is already in progress",
    );
    return { success: false, error: "Already running" };
  }

  const results = [];

  try {
    for (let i = 0; i < maxRuns; i++) {
      const jobId = config.executionId || crypto.randomUUID();
      const emit = buildContentEmitter(jobId);
      const db = getDb();
      const controller = config.signal
        ? { signal: config.signal }
        : jobRegistry.startJob(jobId, { pipelineId: "content", type: "content" });
      const signal = controller.signal;

      // Bridge to the new lifecycle state service (only if an executionId was passed)
      const lifecycleExecId = config.executionId || null;
      const updateLifecycle = (stage, message, progress, completedSteps) => {
        if (!lifecycleExecId) return;
        try {
          pipelineState.updateExecutionProgress(lifecycleExecId, {
            stage,
            message,
            progress,
            completedSteps,
          });
        } catch (_) {}
      };
      const checkAbort = () => {
        if (lifecycleExecId) {
          try { pipelineState.throwIfAborted(lifecycleExecId); } catch (err) { throw err; }
        }
        if (signal?.aborted) throw new Error("Content pipeline aborted");
      };

      emit({
        stage: "start",
        message: `Run started (trigger: ${trigger}, platforms: ${platforms.join(", ")})`,
      });
      logActivity({
        activityType: "pipeline_run",
        entityType: "pipeline",
        entityId: jobId,
        actor: trigger,
        status: "running",
        summary: `Content pipeline ${jobId} started`,
        details: { platforms, topic },
      });

      try {
        if (isPaused()) {
          emit({ stage: "paused", level: "warn", message: "Content pipeline is paused; run skipped" });
          results.push({ success: false, error: "Paused" });
          continue;
        }
        throwIfAborted(signal);
        // ── Preflight: Gemini session check ──────────────────────────────
        if (
          !process.env.GEMINI_CDP_ENDPOINT &&
          !process.env.CDP_ENDPOINT &&
          !process.env.LINKEDIN_CDP_ENDPOINT &&
          !process.env.INSTAGRAM_CDP_ENDPOINT &&
          !process.env.FACEBOOK_CDP_ENDPOINT &&
          !process.env.X_CDP_ENDPOINT
        ) {
          emit({
            stage: "preflight",
            message:
              "Warning: No shared Chrome session configured. Gemini image gen may fail if not logged in.",
          });
        }

        // ── Stage 1: Pick asset (library) OR generate image (AI) ────────
        const {
          mediaRelPath,
          mediaRelPaths,
          selectedAsset,
          selectedGroup,
        } = await pickAssetOrGenerateImage({
          topic,
          style,
          platforms,
          jobId,
          emit,
          signal,
          lifecycleExecId,
          updateLifecycle,
          checkAbort,
        });

        // ── Stage 2: Generate captions per platform ──────────────────────
        // Resolve the on-disk image path for image-aware captioning. The
        // asset library now stores the absolute `file_path` (set by multer
        // at upload time) in posts.media_path, so when the path is absolute
        // and exists, we use it directly. We also fall back to resolving
        // a relative "/uploads/..." URL against the public dir for
        // AI-generated images (which still use the URL form). When the
        // asset is a video or missing, we skip image-aware captioning and
        // fall back to the text-only path.
        const imageFsPath = resolveImageFsPath(mediaRelPath);

        const captions = {};
        const skipCaptions = lifecycleExecId && checkpointService.isStageComplete(lifecycleExecId, "caption_gen");
        if (!skipCaptions) {
          for (const platform of platforms) {
            checkAbort();
            emit({
              stage: "caption_gen",
              message: `Generating caption for ${platform}${imageFsPath ? " (image-aware)" : ""}...`,
            });
            updateLifecycle("caption_gen", `Generating caption for ${platform}…`, 30 + (platforms.indexOf(platform) * 10), 1);
            const captionResult = await withRetry(
              () => generateCaption(topic, platform, null, {
                imagePath: imageFsPath,
                emit: (kind, msg) => emit({ stage: "caption_gen", type: kind, message: msg }),
              }),
              {
                signal,
                label: `content:caption:${platform}`,
                entityType: "pipeline",
                entityId: jobId,
                platform,
                onRetry: (attempt, err) => {
                  emit({
                    stage: "caption_gen",
                    type: "retry",
                    level: "retry",
                    platform,
                    message: `Caption retry ${attempt} for ${platform}: ${err.message}`,
                  });
                  if (lifecycleExecId) {
                    pipelineLogger.log({
                      pipelineId: "content",
                      executionId: lifecycleExecId,
                      level: "retry",
                      stage: "caption_gen",
                      message: `Caption retry ${attempt} for ${platform}: ${err.message}`,
                      retryAttempt: attempt,
                      context: { platform },
                    });
                  }
                },
              },
            );
            // generateCaption now returns { text, source, model, ok, error }.
            // If generation failed, surface the error and abort the run
            // rather than silently posting a placeholder. The previous
            // behaviour posted the literal `${topic} — [Edit this caption
            // before posting]` string, which the user saw live on their
            // social accounts.
            if (!captionResult || !captionResult.ok || !captionResult.text) {
              const errMsg = (captionResult && captionResult.error) || 'unknown error';
              throw new Error(`Caption generation failed for ${platform}: ${errMsg}`);
            }
            captions[platform] = captionResult.text;
            emit({
              stage: "caption_gen",
              message: `Caption ready for ${platform} (${captionResult.source})`,
            });
          }
          if (lifecycleExecId) {
            checkpointService.saveCheckpoint({
              executionId: lifecycleExecId,
              pipelineId: "content",
              stage: "caption_gen",
              status: "completed",
              payload: { platforms: Object.keys(captions) },
            });
          }
        } else {
          emit({ stage: "caption_gen", message: "Captions skipped: checkpoint already complete" });
        }
        updateLifecycle("caption_gen", "Captions ready", 60, 2);

        // Persist ALL per-platform captions on the post row so the publisher
        // can pick the right one for each platform. Previously only the
        // primary platform's caption was stored in `posts.body`, and the
        // other N-1 captions were silently discarded — so an Instagram-style
        // caption (2200 chars, hashtags) would get truncated to 280 chars
        // at publish time on X, instead of using the X-tailored caption
        // that was actually generated for X.
        const primaryCaption =
          captions[platforms[0]] || Object.values(captions)[0] || "";
        const captionsJson = JSON.stringify(captions);

        // ── Stage 3: Create post record ──────────────────────────────────
        checkAbort();
        // media_paths: JSON array of all asset URLs for this post (multi-image
        // carousel, video + thumbnail, etc.). When the user picked a single
        // asset or generated via AI, this is a one-element array. The
        // publisher uses media_paths to drive Instagram carousel posts and
        // to pass the correct single asset to LinkedIn / X / Facebook.
        const mediaPathsForPost = mediaRelPaths && mediaRelPaths.length > 0
          ? JSON.stringify(mediaRelPaths)
          : JSON.stringify(mediaRelPath ? [mediaRelPath] : []);
        const insertResult = db
          .prepare(
            `
          INSERT INTO posts (platforms, body, captions_json, media_path, media_paths, status, scheduled_at)
          VALUES (?, ?, ?, ?, ?, 'draft', CURRENT_TIMESTAMP)
        `,
          )
          .run(
            JSON.stringify(platforms),
            primaryCaption,
            captionsJson,
            mediaRelPath,
            mediaPathsForPost,
          );

        const postId = insertResult.lastInsertRowid;
        emit({
          stage: "post_record",
          message: `Post draft created (id: ${postId})`,
        });
        if (lifecycleExecId) {
          checkpointService.saveCheckpoint({
            executionId: lifecycleExecId,
            pipelineId: "content",
            stage: "post_record",
            status: "completed",
            payload: { postId, mediaPath: mediaRelPath },
          });
        }
        updateLifecycle("post_record", `Post draft created (id: ${postId})`, 75, 3);

        // ── Stage 4: Publish ─────────────────────────────────────────────
        checkAbort();
        emit({
          stage: "publish",
          message: `Publishing to: ${platforms.join(", ")}...`,
        });
        updateLifecycle("publish", `Publishing to: ${platforms.join(", ")}…`, 80, 3);

        const publishResult = await publishPost(postId, emit, { trace: false });
        // Bump rotation counters for whichever asset(s) we used. Groups
        // mark every asset in the group as used; single assets just bump
        // their own row.
        if (
          Array.isArray(publishResult.success) &&
          publishResult.success.length > 0
        ) {
          if (selectedGroup) {
            markAssetGroupUsed(selectedGroup.id, postId);
          } else if (selectedAsset) {
            markAssetUsed(selectedAsset.id, postId);
          }
        }

        const publishedPlatforms = Array.isArray(publishResult.success)
          ? publishResult.success
          : [];
        const failedPlatforms = Array.isArray(publishResult.failed)
          ? publishResult.failed
          : [];

        if (publishedPlatforms.length > 0) {
          emit({
            stage: "publish",
            message: `✓ Published to: ${publishedPlatforms.join(", ")}`,
          });
          if (lifecycleExecId) {
            checkpointService.saveCheckpoint({
              executionId: lifecycleExecId,
              pipelineId: "content",
              stage: "publish",
              status: "completed",
              payload: { postId, publishedPlatforms, failedPlatforms },
            });
          }
          results.push({
            success: true,
            postId,
            platforms: publishedPlatforms,
          });
          emit({
            stage: "complete",
            message: `Run complete (post ${postId} published)`,
          });
          updateLifecycle("publish", `Published to: ${publishedPlatforms.join(", ")}`, 100, 4);
          logActivity({
            activityType: "pipeline_run",
            entityType: "pipeline",
            entityId: jobId,
            actor: trigger,
            status: "success",
            summary: `Content pipeline ${jobId} completed`,
            details: { postId, platforms: publishedPlatforms },
          });
        } else {
          emit({
            stage: "publish",
            message: `✗ All platforms failed: ${failedPlatforms.join(", ")}`,
          });
          if (lifecycleExecId) {
            checkpointService.saveCheckpoint({
              executionId: lifecycleExecId,
              pipelineId: "content",
              stage: "publish",
              status: "failed",
              payload: { postId, failedPlatforms },
            });
          }
          results.push({
            success: false,
            postId,
            error: "All platforms failed",
          });
          emit({
            stage: "complete",
            message: `Run complete (post ${postId} failed)`,
          });
          updateLifecycle("publish", `✗ All platforms failed: ${failedPlatforms.join(", ")}`, 90, 3);
        }
      } catch (err) {
        logger.error("CONTENT-PIPELINE", `Run ${i + 1} failed`, err);
        emit({ stage: "error", message: err.message });
        if (lifecycleExecId) {
          pipelineLogger.log({
            pipelineId: "content",
            executionId: lifecycleExecId,
            level: "error",
            stage: "error",
            message: err.message,
            error: err,
          });
        }
        logActivity({
          activityType: "pipeline_run",
          entityType: "pipeline",
          entityId: jobId,
          actor: trigger,
          status: "failure",
          summary: `Content pipeline ${jobId} failed`,
          details: { error: err.message },
        });
        results.push({ success: false, error: err.message });
      } finally {
        jobRegistry.finishJob(jobId);
      }
    }
  } finally {
    releaseLock();
  }

  return results.length === 1 ? results[0] : { runs: results };
}

async function runContentPipeline(config = {}) {
  return enqueuePipelineRun(
    "content",
    `content:${config.trigger || "manual"}:${Date.now()}`,
    () => runContentPipelineNow(config),
    {
      onQueued: ({ position, activeRun }) => {
        logger.info(
          "CONTENT-PIPELINE",
          `Content pipeline queued at position ${position}; waiting for active run to finish`,
          { activeRun },
        );
      },
    },
  );
}

module.exports = { runContentPipelineNow, runContentPipeline };
