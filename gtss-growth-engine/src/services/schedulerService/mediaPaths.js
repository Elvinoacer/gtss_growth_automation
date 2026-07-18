/**
 * Scheduler Service — Media Path Resolution & Cleanup
 * resolveMediaFilePath, getPostMediaPaths, getPrimaryPostMediaPath,
 * getPostLocationTag, isLibraryMediaPath, deleteMediaFiles,
 * deleteMediaFile — turn the `posts.media_path` / `posts.media_paths`
 * columns into absolute, existence-checked filesystem paths (handling
 * the desktop launcher's UPLOADS_DIR override and legacy "/uploads/..."
 * URL values), and delete *ephemeral* media files after a successful
 * publish.
 *
 * IMPORTANT: Asset-library files under uploads/library/ (and any path
 * still referenced by asset_library) are NEVER deleted by publish
 * cleanup. The library is a reusable rotation source for reposts —
 * only one-off AI / composer uploads under the top-level uploads/
 * directory should be removed after publish.
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

function getLibraryDir() {
  return path.resolve(UPLOADS_DIR, "library");
}

/**
 * True when this media path belongs to the permanent asset library and
 * must survive publish / permanent-failure cleanup so rotation can
 * reuse it on the next cycle.
 *
 * Detection (any match is enough):
 *   1. Path contains `/uploads/library/` or ends under the resolved
 *      library directory on disk.
 *   2. Path (or its basename) is still referenced by asset_library
 *      (covers absolute file_path rows stored at upload time).
 */
function isLibraryMediaPath(mediaPath) {
  if (!mediaPath) return false;

  const raw = String(mediaPath).trim();
  if (!raw) return false;

  const normalized = raw.replace(/\\/g, "/").toLowerCase();
  if (
    normalized.includes("/uploads/library/") ||
    normalized.includes("/library/") ||
    normalized.startsWith("library/")
  ) {
    return true;
  }

  const libraryDir = getLibraryDir();
  const libraryPrefix = `${libraryDir}${path.sep}`.toLowerCase();
  const resolvedCandidates = [];

  if (path.isAbsolute(raw)) {
    resolvedCandidates.push(path.resolve(raw));
  }
  // Also try resolving URL-style paths against UPLOADS_DIR.
  if (raw.startsWith("/uploads/") || raw.startsWith("uploads/")) {
    const relative = raw.replace(/^\/?uploads\//, "");
    resolvedCandidates.push(path.resolve(UPLOADS_DIR, relative));
  }

  for (const candidate of resolvedCandidates) {
    const lower = candidate.toLowerCase();
    if (lower === libraryDir.toLowerCase() || lower.startsWith(libraryPrefix)) {
      return true;
    }
  }

  // DB fallback: path still registered as a library asset.
  try {
    const { getDb } = require("../../db/database");
    const db = getDb();
    const basename = path.basename(raw);
    const hit = db
      .prepare(
        `SELECT 1 FROM asset_library
         WHERE file_path = ? OR file_url = ? OR file_path LIKE ?
         LIMIT 1`,
      )
      .get(raw, raw, `%${basename}`);
    if (hit) return true;
  } catch (_) {
    // DB may be unavailable in some unit-test / early-boot paths.
  }

  return false;
}

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

/**
 * Delete ephemeral post media after publish (or permanent failure).
 * Library assets are intentionally skipped so the rotation queue can
 * repost them later. Paths are resolved to real filesystem locations
 * first (raw "/uploads/..." values are not valid unlink targets).
 */
async function deleteMediaFiles(mediaPaths) {
  await Promise.all(
    (mediaPaths || []).map(async (mediaPath) => {
      await deleteMediaFile(mediaPath);
    }),
  );
}

async function deleteMediaFile(mediaPath) {
  if (!mediaPath) return;

  if (isLibraryMediaPath(mediaPath)) {
    logger.debug("Keeping library media after publish (reusable asset)", {
      path: mediaPath,
    });
    return;
  }

  // Prefer the resolved on-disk path; fall back to the raw value for
  // callers that already pass absolute filesystem paths.
  const resolved = resolveMediaFilePath(mediaPath) || mediaPath;

  // Double-check after resolution (absolute library file_path).
  if (isLibraryMediaPath(resolved)) {
    logger.debug("Keeping library media after publish (reusable asset)", {
      path: resolved,
    });
    return;
  }

  try {
    await fs.promises.unlink(resolved);
    logger.info("Deleted ephemeral media file after publish", { path: resolved });
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn("Could not delete media file after publish", {
        path: resolved,
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
  isLibraryMediaPath,
  deleteMediaFiles,
  deleteMediaFile,
};
