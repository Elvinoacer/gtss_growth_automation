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
const { pickNextAsset, markAssetUsed } = require("../services/assetRotationService");
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
        let selectedAsset = null;
        const assetSource = getSetting("content_asset_source", "ai");
        if (assetSource === "library") {
          const mediaType = getSetting("content_library_media_type", "image");
          selectedAsset = pickNextAsset({ mediaType });
          if (!selectedAsset) throw new Error("Asset library is empty");
          mediaRelPath = selectedAsset.file_url;
          emit({
            stage: "asset_library",
            message: `Selected library asset: ${selectedAsset.name}`,
          });
          updateLifecycle("asset_library", `Selected library asset: ${selectedAsset.name}`, 25, 1);
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
        const captions = {};
        const skipCaptions = lifecycleExecId && checkpointService.isStageComplete(lifecycleExecId, "caption_gen");
        if (!skipCaptions) {
          for (const platform of platforms) {
            checkAbort();
            emit({
              stage: "caption_gen",
              message: `Generating caption for ${platform}...`,
            });
            updateLifecycle("caption_gen", `Generating caption for ${platform}…`, 30 + (platforms.indexOf(platform) * 10), 1);
            const caption = await withRetry(
              () => generateCaption(topic, platform, null),
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
            captions[platform] = caption;
            emit({
              stage: "caption_gen",
              message: `Caption ready for ${platform}`,
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

        // Use the primary platform's caption as the post body
        const primaryCaption =
          captions[platforms[0]] || Object.values(captions)[0] || "";

        // ── Stage 3: Create post record ──────────────────────────────────
        checkAbort();
        const insertResult = db
          .prepare(
            `
          INSERT INTO posts (platforms, body, media_path, status, scheduled_at)
          VALUES (?, ?, ?, 'draft', CURRENT_TIMESTAMP)
        `,
          )
          .run(JSON.stringify(platforms), primaryCaption, mediaRelPath);

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
        if (selectedAsset && Array.isArray(publishResult.success) && publishResult.success.length > 0) {
          markAssetUsed(selectedAsset.id, postId);
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
