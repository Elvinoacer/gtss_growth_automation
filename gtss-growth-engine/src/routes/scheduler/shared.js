/**
 * Scheduler Routes — Shared Helpers & Media Upload Setup
 *
 * Contains:
 *   - The multer `upload` middleware factory (disk storage into UPLOADS_DIR
 *     with a 25MB limit and an ALLOWED_MIMES whitelist).
 *   - UPLOADS_DIR resolution (env-driven; falls back to the bundled
 *     <serverRoot>/public/uploads in dev mode).
 *   - Date helpers (normalizeScheduledAt, parseLocalDateString).
 *   - Media-path normalization helpers used by the post CRUD routes
 *     (normalizeSingleMediaPath, normalizeMediaPath, normalizeMediaAttachment).
 *
 * Cross-file dependencies: none (only standard Node + npm modules + the
 * `../services/...` requires). Consumed by `./postRoutes`, `./uploadRoutes`.
 *
 * Extracted from the original routes/scheduler.js for maintainability.
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

// ---------------------------------------------------------------------------
// Media upload setup
// ---------------------------------------------------------------------------

// Resolve the writable uploads directory. The desktop launcher sets
// UPLOADS_DIR=<userData>/public/uploads (writable); in standalone dev mode
// (running `npm start` inside gtss-growth-engine/), UPLOADS_DIR is unset
// and we fall back to the bundled <serverRoot>/public/uploads (writable
// in dev). See src/routes/assets.js for the same pattern.
//
// NOTE: this file lives at src/routes/scheduler/shared.js, so __dirname is
// src/routes/scheduler — three levels below the project root. The original
// file lived at src/routes/scheduler.js (two levels below root), so the
// "__dirname, .., .." path becomes "__dirname, .., .., .." here.
const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, "..", "..", "..", "public", "uploads");
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

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Media-path normalization
// ---------------------------------------------------------------------------

function normalizeSingleMediaPath(trimmed) {
  const candidates = [];

  if (path.isAbsolute(trimmed)) {
    candidates.push(path.resolve(trimmed));
  } else if (trimmed.startsWith("/uploads/")) {
    // Try the WRITABLE UPLOADS_DIR first (desktop app), then the bundled
    // public/ dir (dev mode fallback).
    candidates.push(path.resolve(UPLOADS_DIR, `.${trimmed}`));
    candidates.push(path.resolve(UPLOADS_DIR, trimmed));
    candidates.push(
      path.resolve(__dirname, "..", "..", "..", "public", `.${trimmed}`),
    );
  } else if (trimmed.startsWith("uploads/")) {
    candidates.push(path.resolve(UPLOADS_DIR, trimmed));
    candidates.push(path.resolve(__dirname, "..", "..", "..", "public", trimmed));
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

module.exports = {
  UPLOADS_DIR,
  ALLOWED_MIMES,
  upload,
  normalizeScheduledAt,
  parseLocalDateString,
  normalizeSingleMediaPath,
  normalizeMediaPath,
  normalizeMediaAttachment,
};
