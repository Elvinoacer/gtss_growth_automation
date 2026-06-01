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
const logger = require("../utils/logger");

const UPLOADS_DIR = path.resolve(__dirname, "../../public/uploads");

function buildContentEmitter(jobId) {
  return (event) => {
    const stageLabel = event.stage || event.type || "event";
    const message = event.message || String(stageLabel);
    const level =
      event.level ||
      (String(stageLabel).toLowerCase() === "error" ? "error" : "info");

    logger.info("CONTENT-PIPELINE", `[${jobId}] ${stageLabel}: ${message}`);
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
async function runContentPipeline(config = {}) {
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
      const jobId = crypto.randomUUID();
      const emit = buildContentEmitter(jobId);
      const db = getDb();

      emit({
        stage: "start",
        message: `Run started (trigger: ${trigger}, platforms: ${platforms.join(", ")})`,
      });

      try {
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

        // ── Stage 1: Generate image ──────────────────────────────────────
        emit({
          stage: "image_gen",
          message: `Generating image for topic: "${topic}"...`,
        });

        const {
          jobId: igJobId,
          filePath,
          fileName,
        } = await runImageGenJob({
          jobId,
          topic,
          style,
          platform: platforms[0] || "instagram",
        });

        emit({ stage: "image_gen", message: `Image saved: ${fileName}` });

        // Copy image to uploads directory so publishPost can find it
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        const destName = `auto-${Date.now()}-${fileName}`;
        const destPath = path.join(UPLOADS_DIR, destName);
        await fs.promises.copyFile(filePath, destPath);
        const mediaRelPath = `/uploads/${destName}`;

        emit({
          stage: "image_gen",
          message: `Image copied to uploads: ${destName}`,
        });

        // ── Stage 2: Generate captions per platform ──────────────────────
        const captions = {};
        for (const platform of platforms) {
          emit({
            stage: "caption_gen",
            message: `Generating caption for ${platform}...`,
          });
          const caption = await generateCaption(topic, platform, null);
          captions[platform] = caption;
          emit({
            stage: "caption_gen",
            message: `Caption ready for ${platform}`,
          });
        }

        // Use the primary platform's caption as the post body
        const primaryCaption =
          captions[platforms[0]] || Object.values(captions)[0] || "";

        // ── Stage 3: Create post record ──────────────────────────────────
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

        // ── Stage 4: Publish ─────────────────────────────────────────────
        emit({
          stage: "publish",
          message: `Publishing to: ${platforms.join(", ")}...`,
        });

        const publishResult = await publishPost(postId, emit, { trace: false });

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
          results.push({
            success: true,
            postId,
            platforms: publishedPlatforms,
          });
          emit({
            stage: "complete",
            message: `Run complete (post ${postId} published)`,
          });
        } else {
          emit({
            stage: "publish",
            message: `✗ All platforms failed: ${failedPlatforms.join(", ")}`,
          });
          results.push({
            success: false,
            postId,
            error: "All platforms failed",
          });
          emit({
            stage: "complete",
            message: `Run complete (post ${postId} failed)`,
          });
        }
      } catch (err) {
        logger.error("CONTENT-PIPELINE", `Run ${i + 1} failed`, err);
        emit({ stage: "error", message: err.message });
        results.push({ success: false, error: err.message });
      }
    }
  } finally {
    releaseLock();
  }

  return results.length === 1 ? results[0] : { runs: results };
}

module.exports = { runContentPipeline };
