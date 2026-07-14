/**
 * Scheduler Service — Media Path Resolution & Cleanup
 * resolveMediaFilePath, getPostMediaPaths, getPrimaryPostMediaPath,
 * getPostLocationTag, deleteMediaFiles, deleteMediaFile — turn the
 * `posts.media_path` / `posts.media_paths` columns into absolute,
 * existence-checked filesystem paths (handling the desktop launcher's
 * UPLOADS_DIR override and legacy "/uploads/..." URL values), and
 * delete media files after a successful publish.
 *
 * NOTE: __dirname in this split file resolves one level deeper than the
 * original (src/services/schedulerService/ vs src/services/), so the
 * public/ fallback paths inside resolveMediaFilePath each get one extra
 * ".." segment to land at the same absolute path as before.
 */

const fs = require("fs");
const path = require("path");
const logger = require("../../utils/logger");
const { UPLOADS_DIR } = require("./constants");

function resolveMediaFilePath(mediaPath) {
  if (!mediaPath) return null;

  const candidates = [];

  // ── Absolute filesystem path (e.g., from the asset library's file_path) ──
  // The asset library now stores the absolute `file_path` (set by multer at
  // upload time) directly in posts.media_path, so this is the common case
  // for "use my library assets" posts. We just verify it exists.
  if (path.isAbsolute(mediaPath)) {
    candidates.push(path.resolve(mediaPath));
    // Some legacy posts may have stored an absolute-looking "/uploads/..."
    // URL (which on Linux is path.isAbsolute()===true). For those, also
    // try resolving against the WRITABLE UPLOADS_DIR (set by the desktop
    // launcher) — falling back to the bundled public/ dir for dev mode.
    if (mediaPath.startsWith("/uploads/") || mediaPath.startsWith("/uploads")) {
      candidates.push(path.resolve(UPLOADS_DIR, `.${mediaPath}`));
      candidates.push(path.resolve(UPLOADS_DIR, mediaPath));
      candidates.push(
        path.resolve(__dirname, "..", "..", "..", "public", `.${mediaPath}`),
      );
      candidates.push(
        path.resolve(__dirname, "..", "..", "..", "public", mediaPath),
      );
    }
  } else if (mediaPath.startsWith("/uploads/")) {
    // Relative URL like "/uploads/library/foo.jpg" — resolve against
    // the WRITABLE UPLOADS_DIR first (desktop app), then the bundled
    // public/ dir (dev mode).
    candidates.push(path.resolve(UPLOADS_DIR, `.${mediaPath}`));
    candidates.push(path.resolve(UPLOADS_DIR, mediaPath));
    candidates.push(
      path.resolve(__dirname, "..", "..", "..", "public", `.${mediaPath}`),
    );
    candidates.push(
      path.resolve(__dirname, "..", "..", "..", "public", mediaPath),
    );
  } else if (mediaPath.startsWith("uploads/")) {
    candidates.push(path.resolve(UPLOADS_DIR, mediaPath));
    candidates.push(path.resolve(__dirname, "..", "..", "..", "public", mediaPath));
  } else {
    // Bare filename or unknown shape — try a few reasonable spots.
    candidates.push(path.resolve(mediaPath));
    candidates.push(path.resolve(UPLOADS_DIR, path.basename(mediaPath)));
    candidates.push(
      path.resolve(__dirname, "..", "..", "..", "public", "uploads", path.basename(mediaPath)),
    );
  }

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function getPostMediaPaths(post) {
  const raw = post?.media_paths ?? post?.media_path;
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw.map((item) => String(item || "").trim()).filter(Boolean);
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item || "").trim()).filter(Boolean);
      }
    } catch (_) {
      // Keep legacy singular media_path values.
    }

    return [trimmed];
  }

  return [];
}

function getPrimaryPostMediaPath(post) {
  return getPostMediaPaths(post)[0] || null;
}

function getPostLocationTag(post) {
  return post?.location_tag || null;
}

async function deleteMediaFiles(mediaPaths) {
  await Promise.all(
    mediaPaths.map(async (mediaPath) => {
      try {
        await fs.promises.unlink(mediaPath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          logger.warn("Could not delete media file after publish", {
            path: mediaPath,
            error: error.message,
          });
        }
      }
    }),
  );
}

async function deleteMediaFile(mediaPath) {
  if (!mediaPath) return;

  try {
    await fs.promises.unlink(mediaPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn("Could not delete media file after publish", {
        path: mediaPath,
        error: error.message,
      });
    }
  }
}

module.exports = {
  resolveMediaFilePath,
  getPostMediaPaths,
  getPrimaryPostMediaPath,
  getPostLocationTag,
  deleteMediaFiles,
  deleteMediaFile,
};
