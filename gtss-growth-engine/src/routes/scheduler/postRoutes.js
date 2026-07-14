/**
 * Scheduler Routes — Page + Post CRUD Endpoints
 *
 * Express handlers for the scheduler's page render and the posts table:
 *   GET    /scheduler                       — Render the scheduler page
 *   POST   /api/scheduler/posts             — Create a scheduled or publish-now post
 *   GET    /api/scheduler/posts             — List posts (filter by status/platform/week, paginate)
 *   PATCH  /api/scheduler/posts/:id         — Update a post (body, media, platforms, scheduledAt, etc.)
 *   DELETE /api/scheduler/posts/:id         — Delete a post
 *   PATCH  /api/scheduler/posts/:id/stats   — Update engagement stats (likes/comments/reach)
 *
 * Cross-file dependencies: ./shared (normalizeScheduledAt, parseLocalDateString,
 * normalizeMediaAttachment), ../../db/database, ../../services/schedulerService
 * (publishPost, emitJobEvent, closeJobStream, POST_CHAR_LIMITS),
 * ../../services/platformCatalog (getPrimaryPlatform), ../../services/socketService
 * (broadcast), ../../utils/logger, ./pageRenderer, crypto.
 *
 * Extracted from the original routes/scheduler.js for maintainability.
 */

const crypto = require("crypto");
const { renderPage } = require("../pageRenderer");
const { getDb } = require("../../db/database");
const { getPrimaryPlatform } = require("../../services/platformCatalog");
const {
  publishPost,
  emitJobEvent,
  closeJobStream,
  POST_CHAR_LIMITS,
} = require("../../services/schedulerService");
const logger = require("../../utils/logger");
const { broadcast } = require("../../services/socketService");

const {
  normalizeScheduledAt,
  parseLocalDateString,
  normalizeMediaAttachment,
} = require("./shared");

/**
 * Register scheduler page + post CRUD routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerPostRoutes(router) {
  // ---------------------------------------------------------------------------
  // Page Route
  // ---------------------------------------------------------------------------

  router.get("/scheduler", (req, res) => {
    renderPage(res, {
      title: "Scheduler",
      primaryHeading: "Plan posts and tasks",
      primaryCopy:
        "Schedule content, reminders, and automation windows for each platform.",
    });
  });

  // ---------------------------------------------------------------------------
  // API: Posts CRUD
  // ---------------------------------------------------------------------------

  // Create post
  router.post("/api/scheduler/posts", async (req, res) => {
    const {
      platforms,
      body,
      mediaPath,
      mediaPaths,
      locationTag,
      scheduledAt,
      publishNow,
      ig_post_type,
    } = req.body;

    if (!platforms || !Array.isArray(platforms) || platforms.length === 0) {
      return res.status(400).json({ error: "At least one platform is required" });
    }
    if (!body || !body.trim()) {
      return res.status(400).json({ error: "Post body is required" });
    }

    const hasInstagram = platforms.includes("instagram");
    const mediaInput = mediaPaths !== undefined ? mediaPaths : mediaPath;
    const hasMedia = mediaInput && String(mediaInput).trim() !== "";

    if (hasInstagram && !hasMedia) {
      return res.status(400).json({
        error: "Instagram posts require a media attachment (image or video).",
      });
    }

    // Validate body length per platform
    for (const p of platforms) {
      const limit = POST_CHAR_LIMITS[p];
      if (limit && body.length > limit) {
        return res.status(400).json({
          error: `Post body exceeds ${p} character limit (${body.length}/${limit})`,
        });
      }
    }

    try {
      const db = getDb();

      if (publishNow) {
        const normalizedAttachment = normalizeMediaAttachment(mediaInput);

        // Insert as draft, then publish immediately
        const result = db
          .prepare(
            `
          INSERT INTO posts (platforms, body, media_paths, media_path, location_tag, scheduled_at, status, ig_post_type)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'draft', ?)
        `,
          )
          .run(
            JSON.stringify(platforms),
            body,
            normalizedAttachment.mediaPaths,
            normalizedAttachment.primaryMediaPath,
            locationTag ? String(locationTag).trim() || null : null,
            ig_post_type || "feed",
          );

        const postId = result.lastInsertRowid;
        const jobId = crypto.randomUUID();

        res.json({ jobId, postId });

        // Fire-and-forget publish
        setTimeout(async () => {
          const emit = (event) => emitJobEvent(jobId, { ...event, jobId });
          try {
            emit({ type: "info", message: "Starting immediate publish..." });
            const result = await publishPost(postId, emit);
            emit({
              type: "done",
              message: `Published to ${result.success.length} platform(s). Failed: ${result.failed.length}`,
              result,
            });
          } catch (err) {
            emit({ type: "error", message: `Publish failed: ${err.message}` });
          } finally {
            closeJobStream(jobId);
          }
        }, 500);
      } else {
        // Schedule for later
        if (!scheduledAt) {
          return res
            .status(400)
            .json({ error: "scheduledAt is required for scheduled posts" });
        }

        const normalizedScheduledAt = normalizeScheduledAt(scheduledAt);
        const normalizedAttachment = normalizeMediaAttachment(mediaInput);

        const result = db
          .prepare(
            `
          INSERT INTO posts (platforms, body, media_paths, media_path, location_tag, scheduled_at, status, ig_post_type)
          VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?)
        `,
          )
          .run(
            JSON.stringify(platforms),
            body,
            normalizedAttachment.mediaPaths,
            normalizedAttachment.primaryMediaPath,
            locationTag ? String(locationTag).trim() || null : null,
            normalizedScheduledAt,
            ig_post_type || "feed",
          );

        const post = db
          .prepare("SELECT * FROM posts WHERE id = ?")
          .get(result.lastInsertRowid);
        broadcast("scheduler:mutation", {
          type: "post_scheduled",
          postId: post.id,
        });
        res.json({ post });
      }
    } catch (error) {
      logger.error("Error creating post", { error: error.message });
      const isValidationError =
        error.message.includes("Invalid scheduledAt value") ||
        error.message.includes("Media file not found on disk") ||
        error.message.includes(
          "Media file must live inside the uploads directory",
        ) ||
        error.message.includes("mediaPath must be a string");
      res.status(isValidationError ? 400 : 500).json({ error: error.message });
    }
  });

  // List posts (with filters for calendar/log views)
  router.get("/api/scheduler/posts", (req, res) => {
    const { status, platform, week, page: pageNum } = req.query;

    try {
      const db = getDb();
      let sql = "SELECT * FROM posts WHERE 1=1";
      const params = [];

      if (status) {
        sql += " AND status = ?";
        params.push(status);
      }

      if (platform) {
        sql += " AND platforms LIKE ?";
        params.push(`%"${platform}"%`);
      }

      if (week) {
        // week is a date string; we compute Mon-Sun range
        const weekDate = parseLocalDateString(week);
        if (!weekDate) {
          return res.status(400).json({ error: "Invalid week value" });
        }
        const dayOfWeek = weekDate.getDay();
        const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
        const monday = new Date(weekDate);
        monday.setDate(weekDate.getDate() + mondayOffset);
        monday.setHours(0, 0, 0, 0);

        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        sunday.setHours(23, 59, 59, 999);

        sql +=
          " AND datetime(scheduled_at) >= datetime(?) AND datetime(scheduled_at) <= datetime(?)";
        params.push(monday.toISOString(), sunday.toISOString());
      }

      sql += " ORDER BY datetime(COALESCE(scheduled_at, published_at)) ASC";

      // Pagination for log view
      if (pageNum && !week) {
        const limit = 20;
        const offset = (parseInt(pageNum, 10) - 1) * limit;
        sql += ` LIMIT ${limit} OFFSET ${offset}`;
      }

      const posts = db.prepare(sql).all(...params);

      // Parse platforms JSON for each post
      posts.forEach((p) => {
        try {
          p.platforms = JSON.parse(p.platforms);
        } catch {
          /* keep as string */
        }
      });

      res.json(posts);
    } catch (error) {
      const isValidationError =
        error.message.includes("Invalid scheduledAt value") ||
        error.message.includes("Media file not found on disk") ||
        error.message.includes(
          "Media file must live inside the uploads directory",
        ) ||
        error.message.includes("mediaPath must be a string");
      res.status(isValidationError ? 400 : 500).json({ error: error.message });
    }
  });

  // Update post
  router.patch("/api/scheduler/posts/:id", (req, res) => {
    const { id } = req.params;
    const {
      platforms,
      body,
      mediaPath,
      mediaPaths,
      locationTag,
      scheduledAt,
      ig_post_type,
    } = req.body;

    try {
      const db = getDb();
      const existing = db.prepare("SELECT * FROM posts WHERE id = ?").get(id);
      if (!existing) return res.status(404).json({ error: "Post not found" });

      // Validate Instagram and media constraints
      let finalPlatforms = existing.platforms;
      if (platforms) {
        finalPlatforms = JSON.stringify(platforms);
      }
      let parsedPlatforms = [];
      try {
        parsedPlatforms = JSON.parse(finalPlatforms);
      } catch {
        parsedPlatforms = [];
      }

      let finalMedia = existing.media_paths || existing.media_path;
      if (mediaPath !== undefined || mediaPaths !== undefined) {
        finalMedia = mediaPaths !== undefined ? mediaPaths : mediaPath;
      }

      const hasInstagram = parsedPlatforms.includes("instagram");
      const hasMedia = finalMedia && String(finalMedia).trim() !== "";

      if (hasInstagram && !hasMedia) {
        return res.status(400).json({
          error: "Instagram posts require a media attachment (image or video).",
        });
      }

      const updates = [];
      const params = [];

      if (platforms) {
        // Validate length per platform
        const postBody = body || existing.body;
        for (const p of platforms) {
          const limit = POST_CHAR_LIMITS[p];
          if (limit && postBody.length > limit) {
            return res.status(400).json({
              error: `Post body exceeds ${p} character limit (${postBody.length}/${limit})`,
            });
          }
        }
        updates.push("platforms = ?");
        params.push(JSON.stringify(platforms));
      }
      if (body !== undefined) {
        updates.push("body = ?");
        params.push(body);
      }
      if (mediaPath !== undefined) {
        const normalizedAttachment = normalizeMediaAttachment(mediaPath);
        updates.push("media_paths = ?");
        updates.push("media_path = ?");
        params.push(normalizedAttachment.mediaPaths);
        params.push(normalizedAttachment.primaryMediaPath);
      }
      if (mediaPaths !== undefined) {
        const normalizedAttachment = normalizeMediaAttachment(mediaPaths);
        updates.push("media_paths = ?");
        updates.push("media_path = ?");
        params.push(normalizedAttachment.mediaPaths);
        params.push(normalizedAttachment.primaryMediaPath);
      }
      if (scheduledAt) {
        updates.push("scheduled_at = ?");
        params.push(normalizeScheduledAt(scheduledAt));
      }
      if (locationTag !== undefined) {
        updates.push("location_tag = ?");
        params.push(
          locationTag == null ? null : String(locationTag).trim() || null,
        );
      }
      if (ig_post_type !== undefined) {
        updates.push("ig_post_type = ?");
        params.push(ig_post_type);
      }

      if (updates.length === 0) return res.json({ success: true });

      params.push(id);
      db.prepare(`UPDATE posts SET ${updates.join(", ")} WHERE id = ?`).run(
        ...params,
      );

      const updated = db.prepare("SELECT * FROM posts WHERE id = ?").get(id);
      try {
        updated.platforms = JSON.parse(updated.platforms);
      } catch {
        /* keep */
      }
      broadcast("scheduler:mutation", {
        type: "post_updated",
        postId: Number(id),
      });
      res.json({ post: updated });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Delete post
  router.delete("/api/scheduler/posts/:id", (req, res) => {
    const { id } = req.params;
    try {
      const db = getDb();
      db.prepare("DELETE FROM posts WHERE id = ?").run(id);
      broadcast("scheduler:mutation", {
        type: "post_deleted",
        postId: Number(id),
      });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Update post engagement stats (likes, comments, reach)
  router.patch("/api/scheduler/posts/:id/stats", (req, res) => {
    const { id } = req.params;
    const { likes, comments, reach } = req.body;

    try {
      const db = getDb();
      db.prepare(
        `
        UPDATE posts SET likes = ?, comments = ?, reach = ? WHERE id = ?
      `,
      ).run(likes || 0, comments || 0, reach || 0, id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = { registerPostRoutes };
