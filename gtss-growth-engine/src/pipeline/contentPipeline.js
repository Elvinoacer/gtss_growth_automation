/**
 * contentPipeline.js
 * Auto-Content Posting Pipeline
 *
 * Stage 1: Generate image via Gemini web (geminiWeb.js)
 * Stage 2: Generate caption via Gemini API (schedulerService.generateCaption)
 * Stage 3: Publish to all configured platforms (schedulerService.publishPost)
 *
 * This pipeline inserts a row into the `posts` table with status='draft',
 * then publishes immediately, then marks it 'published'. This gives a full
 * audit trail visible in the Content Scheduler page.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { getDb } = require("../db/database");
const {
  generateCaption,
  publishPost,
} = require("../services/schedulerService");
const { runImageGenJob } = require("../services/imageGenService");
const { pickNextAsset, pickNextAssetGroup, pickNextAssetOrGroup, markAssetUsed, markAssetGroupUsed } = require("../services/assetRotationService");
const { logActivity } = require("../services/auditService");
const { withRetry } = require("../utils/retryHelper");
const jobRegistry = require("../jobs/jobRegistry");
const logger = require("../utils/logger");
const { enqueuePipelineRun } = require("./pipelineQueue");
const pipelineState = require("../services/pipelineStateService");
const pipelineLogger = require("../services/pipelineLogger");
const checkpointService = require("../services/pipelineCheckpoint");

const UPLOADS_DIR = path.resolve(__dirname, "../../public/uploads");

const CONTENT_STAGES = ["image_gen", "caption_gen", "post_record", "publish"];

function buildContentEmitter(jobId) {
  return (event) => {
    const stageLabel = event.stage || event.type || "event";
    const message = event.message || String(stageLabel);
    const level =
      event.level ||
      (String(stageLabel).toLowerCase() === "error" ? "error" : "info");

    logger.info("CONTENT-PIPELINE", `[${jobId}] ${stageLabel}: ${message}`);
    jobRegistry.updateJob(jobId, {
      stage: stageLabel,
      message,
      platform: event.platform,
    });
    logger.db(level, "content", stageLabel, message, {
      jobId,
      stage: stageLabel,
      platform: event.platform,
    });
    // Broadcast via Socket.IO for live UI updates
    try {
      const { broadcast } = require("../services/socketService");
      broadcast("content_pipeline:event", { ...event, jobId });
    } catch (_) {}
  };
}

/**
 * Acquire the content pipeline lock. Returns true if acquired.
 */
function acquireLock() {
  const db = getDb();
  const lockKey = "content_pipeline_lock";
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, 'false')",
  ).run(lockKey);
  const result = db
    .prepare(
      "UPDATE settings SET value = 'true' WHERE key = ? AND value = 'false'",
    )
    .run(lockKey);
  return result.changes > 0;
}

/**
 * Release the content pipeline lock.
 */
function releaseLock() {
  const db = getDb();
  db.prepare(
    "UPDATE settings SET value = 'false' WHERE key = 'content_pipeline_lock'",
  ).run();
}

function getSetting(key, fallback = null) {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function isPaused() {
  return String(getSetting("pipeline_content_paused", "false")) === "true";
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("Content pipeline aborted");
}

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

        let mediaRelPath;
        let mediaRelPaths = null; // array when group / multi-image, null otherwise
        let selectedAsset = null;
        let selectedGroup = null;
        const assetSource = getSetting("content_asset_source", "ai");
        if (assetSource === "library") {
          const mediaType = getSetting("content_library_media_type", "image");
          // ── Unified rotation queue (groups AND ungrouped assets) ─────────
          // Previously this called pickNextAssetGroup() FIRST and only fell
          // back to pickNextAsset() when NO groups existed. That starved
          // every ungrouped asset — they were never picked as long as any
          // group existed. The user explicitly asked for both kinds to be
          // used: "those [ungrouped] ones that have not been grouped
          // together, I need you to be using them as they are whenever
          // it's necessary." pickNextAssetOrGroup() treats both kinds as
          // equal citizens in a single queue, ordered by times_used ASC
          // then last_used_at ASC, so every asset eventually gets posted.
          const unit = pickNextAssetOrGroup({ mediaType });
          if (!unit || !unit.assets || unit.assets.length === 0) {
            throw new Error("Asset library is empty");
          }
          if (unit.kind === "group") {
            selectedGroup = unit.group;
            // ── Use file_path (absolute) NOT file_url (relative) ─────────
            // The asset_library row stores BOTH:
            //   file_url  = "/uploads/library/foo.jpg"  (HTTP path)
            //   file_path = "<serverRoot>/public/uploads/library/foo.jpg"
            //                (absolute filesystem path, set by multer)
            // Previously we stored file_url in posts.media_path, then
            // resolveMediaFilePath() had to guess the absolute path. On
            // Linux, "/uploads/..." is path.isAbsolute()===true, so the
            // first candidate (the literal /uploads/... at filesystem
            // root) was tried first and silently failed. If the second
            // candidate (<serverRoot>/public/...) also missed (e.g.,
            // server cwd mismatch, profile/dir layout change), the
            // resolution returned null and the post went out as
            // TEXT-ONLY — exactly the regression the user reported:
            // "the media is not being attached ... it goes ahead and
            //  just posts the caption and [ignores] my library of
            //  assets." Storing file_path (absolute) directly
            // eliminates the resolution ambiguity entirely.
            mediaRelPaths = unit.assets.map((a) => a.file_path || a.file_url);
            mediaRelPath = mediaRelPaths[0];
            emit({
              stage: "asset_library",
              message: `Selected asset group: ${selectedGroup.name} (${unit.assets.length} asset(s), type: ${selectedGroup.post_type})`,
            });
            updateLifecycle(
              "asset_library",
              `Selected asset group: ${selectedGroup.name} (${unit.assets.length} asset(s))`,
              25,
              1,
            );
          } else {
            selectedAsset = unit.asset;
            mediaRelPath = selectedAsset.file_path || selectedAsset.file_url;
            mediaRelPaths = null;
            emit({
              stage: "asset_library",
              message: `Selected library asset: ${selectedAsset.name}`,
            });
            updateLifecycle("asset_library", `Selected library asset: ${selectedAsset.name}`, 25, 1);
          }
        } else {
          // ── Stage 1: Generate image ──────────────────────────────────────
          checkAbort();
          updateLifecycle("image_gen", `Generating image for topic: "${topic}"…`, 5, 0);
          emit({
            stage: "image_gen",
            message: `Generating image for topic: "${topic}"...`,
          });

          // Skip if checkpoint already exists for image_gen
          if (lifecycleExecId && checkpointService.isStageComplete(lifecycleExecId, "image_gen")) {
            emit({ stage: "image_gen", message: "Image generation skipped: checkpoint already complete" });
            updateLifecycle("image_gen", "Image generation skipped (checkpoint)", 25, 1);
          } else {
            const { filePath, fileName } = await withRetry(
              () =>
                runImageGenJob({
                  jobId,
                  topic,
                  style,
                  platform: platforms[0] || "instagram",
                }),
              {
                signal,
                label: "content:image_gen",
                entityType: "pipeline",
                entityId: jobId,
                onRetry: (attempt, err) => {
                  emit({
                    stage: "image_gen",
                    type: "retry",
                    level: "retry",
                    message: `Image generation retry ${attempt}: ${err.message}`,
                  });
                  if (lifecycleExecId) {
                    pipelineLogger.log({
                      pipelineId: "content",
                      executionId: lifecycleExecId,
                      level: "retry",
                      stage: "image_gen",
                      message: `Image generation retry ${attempt}: ${err.message}`,
                      retryAttempt: attempt,
                    });
                  }
                },
              },
            );

            emit({ stage: "image_gen", message: `Image saved: ${fileName}` });

            fs.mkdirSync(UPLOADS_DIR, { recursive: true });
            const destName = `auto-${Date.now()}-${fileName}`;
            const destPath = path.join(UPLOADS_DIR, destName);
            await fs.promises.copyFile(filePath, destPath);
            mediaRelPath = `/uploads/${destName}`;

            emit({
              stage: "image_gen",
              message: `Image copied to uploads: ${destName}`,
            });

            if (lifecycleExecId) {
              checkpointService.saveCheckpoint({
                executionId: lifecycleExecId,
                pipelineId: "content",
                stage: "image_gen",
                status: "completed",
                payload: { filePath: mediaRelPath, fileName: destName },
              });
            }
            updateLifecycle("image_gen", `Image generated: ${destName}`, 25, 1);
          }
        }

        // ── Stage 2: Generate captions per platform ──────────────────────
        // Resolve the on-disk image path for image-aware captioning. The
        // asset library now stores the absolute `file_path` (set by multer
        // at upload time) in posts.media_path, so when the path is absolute
        // and exists, we use it directly. We also fall back to resolving
        // a relative "/uploads/..." URL against the public dir for
        // AI-generated images (which still use the URL form). When the
        // asset is a video or missing, we skip image-aware captioning and
        // fall back to the text-only path.
        let imageFsPath = null;
        try {
          if (mediaRelPath && /\.(jpe?g|png|gif|webp)$/i.test(mediaRelPath)) {
            if (path.isAbsolute(mediaRelPath) && fs.existsSync(mediaRelPath)) {
              imageFsPath = mediaRelPath;
            } else {
              const candidate = mediaRelPath.startsWith("/")
                ? path.resolve(__dirname, "../../public", mediaRelPath.replace(/^\//, ""))
                : path.resolve(__dirname, "../../public", mediaRelPath);
              if (fs.existsSync(candidate)) imageFsPath = candidate;
            }
          }
        } catch (_) { /* fall back to text-only */ }

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

module.exports = { runContentPipeline };
