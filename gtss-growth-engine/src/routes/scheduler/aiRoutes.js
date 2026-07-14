/**
 * Scheduler Routes — AI Caption & Image Generation
 *
 * Express handlers for the AI-assist endpoints:
 *   POST /api/scheduler/generate-caption      — Generate a caption for a topic/platform/tone (with 30s timeout)
 *   POST /api/scheduler/generate-image        — Kick off a Gemini-Web image generation job (returns jobId immediately)
 *   GET  /api/scheduler/generate-image/:jobId — Read an image-gen job's status + result row
 *
 * Cross-file dependencies: ../../db/database, ../../services/schedulerService
 * (generateCaption), ../../services/imageGenService (runImageGenJob),
 * ../../services/platformCatalog (getPrimaryPlatform), ../../utils/logger, crypto.
 *
 * Extracted from the original routes/scheduler.js for maintainability.
 */

const crypto = require("crypto");
const { getDb } = require("../../db/database");
const { getPrimaryPlatform } = require("../../services/platformCatalog");
const { generateCaption } = require("../../services/schedulerService");
const { runImageGenJob } = require("../../services/imageGenService");
const logger = require("../../utils/logger");

/**
 * Register AI caption + image generation routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerAiRoutes(router) {
  // ---------------------------------------------------------------------------
  // API: AI Caption Generation
  // ---------------------------------------------------------------------------

  router.post("/api/scheduler/generate-caption", async (req, res) => {
    const routeTimer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(504).json({
          error: "Caption generation timed out — try again or write manually.",
        });
      }
    }, 30_000);

    try {
      const { topic, platform, tone } = req.body;
      if (!topic?.trim()) {
        clearTimeout(routeTimer);
        return res.status(400).json({ error: "Topic is required" });
      }

      const captionResult = await generateCaption(
        topic.trim(),
        platform || getPrimaryPlatform(),
        tone || "engaging",
      );
      clearTimeout(routeTimer);
      if (!res.headersSent) {
        // generateCaption returns { text, source, model, ok, error }. Surface
        // the structured result so the client can show a meaningful error
        // when AI generation actually failed (instead of silently posting
        // a placeholder like the old `${topic} — [Edit this caption]` stub).
        if (!captionResult || !captionResult.ok) {
          return res.status(503).json({
            error: (captionResult && captionResult.error) || "Caption generation failed",
            generatedBy: "failed",
          });
        }
        res.json({
          caption: captionResult.text,
          generatedBy: captionResult.source || "gemini",
          model: captionResult.model || null,
        });
      }
    } catch (error) {
      clearTimeout(routeTimer);
      logger.error("SCHEDULER", "generate-caption route error", { error: error.message });
      if (!res.headersSent) res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------------------------------------------------------
  // API: AI Image Generation (Gemini Web)
  // ---------------------------------------------------------------------------

  router.post("/api/scheduler/generate-image", async (req, res) => {
    const { topic, style, platform } = req.body;
    if (!topic) return res.status(400).json({ error: "topic is required" });

    // Return the jobId immediately; client subscribes to SSE stream for progress
    const jobId = crypto.randomUUID();
    res.json({ jobId });

    // Run async - do NOT await here
    runImageGenJob({ jobId, topic, style, platform }).catch((err) =>
      logger.error("IMAGE_GEN_ROUTE", err.message),
    );
  });

  // Query job status + result
  router.get("/api/scheduler/generate-image/:jobId", (req, res) => {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM image_gen_jobs WHERE id=?")
      .get(req.params.jobId);
    if (!row) return res.status(404).json({ error: "Job not found" });
    res.json(row);
  });
}

module.exports = { registerAiRoutes };
