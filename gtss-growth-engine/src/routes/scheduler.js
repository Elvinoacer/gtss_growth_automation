const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { renderPage } = require("./pageRenderer");
const { getDb } = require("../db/database");
const { getPrimaryPlatform } = require("../services/platformCatalog");
const {
  publishPost,
  generateCaption,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
  POST_CHAR_LIMITS,
} = require("../services/schedulerService");
const logger = require("../utils/logger");

const router = express.Router();

// ---------------------------------------------------------------------------
// Media upload setup
// ---------------------------------------------------------------------------

const UPLOADS_DIR = path.join(__dirname, "..", "..", "public", "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB max

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
  const { platforms, body, mediaPath, scheduledAt, publishNow } = req.body;

  if (!platforms || !Array.isArray(platforms) || platforms.length === 0) {
    return res.status(400).json({ error: "At least one platform is required" });
  }
  if (!body || !body.trim()) {
    return res.status(400).json({ error: "Post body is required" });
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
      // Insert as draft, then publish immediately
      const result = db
        .prepare(
          `
        INSERT INTO posts (platforms, body, media_path, scheduled_at, status)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, 'draft')
      `,
        )
        .run(JSON.stringify(platforms), body, mediaPath || null);

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

      const result = db
        .prepare(
          `
        INSERT INTO posts (platforms, body, media_path, scheduled_at, status)
        VALUES (?, ?, ?, ?, 'scheduled')
      `,
        )
        .run(JSON.stringify(platforms), body, mediaPath || null, scheduledAt);

      const post = db
        .prepare("SELECT * FROM posts WHERE id = ?")
        .get(result.lastInsertRowid);
      res.json({ post });
    }
  } catch (error) {
    logger.error("Error creating post", { error: error.message });
    res.status(500).json({ error: error.message });
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
      const weekDate = new Date(week);
      const dayOfWeek = weekDate.getDay();
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const monday = new Date(weekDate);
      monday.setDate(weekDate.getDate() + mondayOffset);
      monday.setHours(0, 0, 0, 0);

      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      sunday.setHours(23, 59, 59, 999);

      sql += " AND scheduled_at >= ? AND scheduled_at <= ?";
      params.push(monday.toISOString(), sunday.toISOString());
    }

    sql += " ORDER BY scheduled_at ASC";

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
    res.status(500).json({ error: error.message });
  }
});

// Update post
router.patch("/api/scheduler/posts/:id", (req, res) => {
  const { id } = req.params;
  const { platforms, body, mediaPath, scheduledAt } = req.body;

  try {
    const db = getDb();
    const existing = db.prepare("SELECT * FROM posts WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "Post not found" });

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
      updates.push("media_path = ?");
      params.push(mediaPath);
    }
    if (scheduledAt) {
      updates.push("scheduled_at = ?");
      params.push(scheduledAt);
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

// SSE stream
router.get("/api/scheduler/stream/:jobId", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  registerJobStream(req.params.jobId, res);
});

// ---------------------------------------------------------------------------
// API: AI Caption Generation
// ---------------------------------------------------------------------------

router.post("/api/scheduler/generate-caption", async (req, res) => {
  const { topic, platform, tone } = req.body;
  if (!topic) return res.status(400).json({ error: "Topic is required" });

  try {
    const caption = await generateCaption(
      topic,
      platform || getPrimaryPlatform(),
      tone || "engaging",
    );
    res.json({ caption });
  } catch (error) {
    logger.error("Caption generation failed", { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// API: Pause / Resume Scheduler
// ---------------------------------------------------------------------------

router.patch("/api/scheduler/pause", (req, res) => {
  const { paused } = req.body;

  try {
    const db = getDb();
    db.prepare(
      `
      INSERT INTO settings (key, value) VALUES ('scheduler_paused', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
    ).run(paused ? "true" : "false");

    res.json({ paused: Boolean(paused) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/api/scheduler/pause", (req, res) => {
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'scheduler_paused'")
      .get();
    res.json({ paused: row ? row.value === "true" : false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// API: Media Upload
// ---------------------------------------------------------------------------

router.post(
  "/api/scheduler/upload-media",
  upload.single("media"),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    res.json({
      filename: req.file.filename,
      path: `/uploads/${req.file.filename}`,
      filePath: req.file.path,
      size: req.file.size,
    });
  },
);

module.exports = router;
