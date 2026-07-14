/**
 * Scheduler Routes — Publish-Now + Retry + SSE Stream
 *
 * Express handlers for triggering an immediate publish of an existing post,
 * inspecting/retrying a failed post, and subscribing to a job's SSE event
 * stream:
 *   POST /api/scheduler/posts/:id/publish-now  — Fire-and-forget publish of an existing post
 *   GET  /api/scheduler/posts/:id/retry-info   — Read retry metadata (retry_count, last_error, etc.)
 *   POST /api/scheduler/posts/:id/retry        — Reset a failed post back to 'scheduled' for immediate retry
 *   GET  /api/scheduler/stream/:jobId          — SSE stream for a publish job's progress events
 *
 * Cross-file dependencies: ../../db/database, ../../services/schedulerService
 * (publishPost, emitJobEvent, closeJobStream, registerJobStream), crypto.
 *
 * Extracted from the original routes/scheduler.js for maintainability.
 */

const crypto = require("crypto");
const { getDb } = require("../../db/database");
const {
  publishPost,
  emitJobEvent,
  closeJobStream,
  registerJobStream,
} = require("../../services/schedulerService");

/**
 * Register publish-now, retry, and SSE stream routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerPublishRoutes(router) {
  // ---------------------------------------------------------------------------
  // API: Publish Now (for existing post)
  // ---------------------------------------------------------------------------

  router.post("/api/scheduler/posts/:id/publish-now", (req, res) => {
    const { id } = req.params;
    const jobId = crypto.randomUUID();

    res.json({ jobId });

    setTimeout(async () => {
      const emit = (event) => emitJobEvent(jobId, { ...event, jobId });
      try {
        emit({ type: "info", message: "Starting publish..." });
        const result = await publishPost(id, emit);
        emit({
          type: "done",
          message: `Published to ${result.success.length} platform(s).`,
          result,
        });
      } catch (err) {
        emit({ type: "error", message: `Publish failed: ${err.message}` });
      } finally {
        closeJobStream(jobId);
      }
    }, 500);
  });

  router.get("/api/scheduler/posts/:id/retry-info", (req, res) => {
    const { id } = req.params;

    try {
      const db = getDb();
      const post = db
        .prepare(
          `SELECT id, status, retry_count, next_retry_at, last_error, scheduled_at, published_at, media_paths, media_path, location_tag
           FROM posts
           WHERE id = ?`,
        )
        .get(id);

      if (!post) {
        return res.status(404).json({ error: "Post not found" });
      }

      res.json({ retryInfo: post });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/api/scheduler/posts/:id/retry", (req, res) => {
    const { id } = req.params;

    try {
      const db = getDb();
      const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(id);

      if (!post) {
        return res.status(404).json({ error: "Post not found" });
      }

      if (post.status !== "failed") {
        return res.status(400).json({
          error: `Post is not in failed state (current: ${post.status})`,
        });
      }

      const scheduledAt = new Date().toISOString();
      db.prepare(
        `UPDATE posts
         SET status = 'scheduled',
             retry_count = 0,
             next_retry_at = NULL,
             last_error = NULL,
             scheduled_at = ?
         WHERE id = ?`,
      ).run(scheduledAt, id);

      res.json({ success: true, message: "Post queued for immediate retry." });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // SSE stream
  router.get("/api/scheduler/stream/:jobId", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    registerJobStream(req.params.jobId, res);
  });
}

module.exports = { registerPublishRoutes };
