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
const { broadcast } = require("../services/socketService");

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
const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
  "video/x-m4v",
]);

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`), false);
    }
  },
});

function normalizeScheduledAt(value) {
  const scheduledDate = new Date(value);
  if (Number.isNaN(scheduledDate.getTime())) {
    throw new Error(`Invalid scheduledAt value: ${value}`);
  }

  return scheduledDate.toISOString();
}

function parseLocalDateString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const parts = value.split("-");
  if (parts.length !== 3) {
    return null;
  }

  const [year, month, day] = parts.map((part) => Number(part));
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }

  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function normalizeSingleMediaPath(trimmed) {
  const candidates = [];

  if (path.isAbsolute(trimmed)) {
    candidates.push(path.resolve(trimmed));
  } else if (trimmed.startsWith("/uploads/")) {
    candidates.push(
      path.resolve(__dirname, "..", "..", "public", `.${trimmed}`),
    );
  } else if (trimmed.startsWith("uploads/")) {
    candidates.push(path.resolve(__dirname, "..", "..", "public", trimmed));
  } else {
    candidates.push(path.resolve(trimmed));
    candidates.push(path.resolve(UPLOADS_DIR, path.basename(trimmed)));
  }

  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) {
    throw new Error(`Media file not found on disk: ${trimmed}`);
  }

  if (
    !resolved.startsWith(`${UPLOADS_DIR}${path.sep}`) &&
    resolved !== UPLOADS_DIR
  ) {
    throw new Error("Media file must live inside the uploads directory");
  }

  return resolved;
}

function normalizeMediaPath(mediaPath) {
  if (mediaPath == null || mediaPath === "") {
    return null;
  }

  if (typeof mediaPath !== "string") {
    throw new Error("mediaPath must be a string when provided");
  }

  const trimmed = mediaPath.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const resolved = parsed.map((p) => normalizeSingleMediaPath(p.trim()));
        return JSON.stringify(resolved);
      }
    } catch (e) {
      // Fallback to single path
    }
  }

  return normalizeSingleMediaPath(trimmed);
}

function normalizeMediaAttachment(mediaInput) {
  if (mediaInput == null || mediaInput === "") {
    return {
      mediaPaths: null,
      primaryMediaPath: null,
    };
  }

  let rawPaths = [];
  if (Array.isArray(mediaInput)) {
    rawPaths = mediaInput;
  } else if (typeof mediaInput === "string") {
    const trimmed = mediaInput.trim();
    if (!trimmed) {
      return {
        mediaPaths: null,
        primaryMediaPath: null,
      };
    }

    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          rawPaths = parsed;
        }
      } catch (_) {
        rawPaths = [trimmed];
      }
    } else {
      rawPaths = [trimmed];
    }
  } else {
    throw new Error("mediaPath must be a string or array when provided");
  }

  const normalizedPaths = rawPaths
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .map((entry) => normalizeSingleMediaPath(entry));

  if (normalizedPaths.length === 0) {
    return {
      mediaPaths: null,
      primaryMediaPath: null,
    };
  }

  return {
    mediaPaths: JSON.stringify(normalizedPaths),
    primaryMediaPath: normalizedPaths[0],
  };
}

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

  if (hasMedia && !hasInstagram) {
    return res.status(400).json({
      error:
        "Media attachments are only allowed when Instagram is selected as a target platform.",
    });
  }
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

    if (hasMedia && !hasInstagram) {
      return res.status(400).json({
        error:
          "Media attachments are only allowed when Instagram is selected as a target platform.",
      });
    }
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

router.post("/api/scheduler/upload-media", (req, res) => {
  upload.single("media")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    res.json({
      filename: req.file.filename,
      path: `/uploads/${req.file.filename}`, // web-accessible preview URL
      filePath: req.file.path, // absolute FS path for Playwright
      size: req.file.size,
      mimetype: req.file.mimetype,
    });
  });
});

module.exports = router;
