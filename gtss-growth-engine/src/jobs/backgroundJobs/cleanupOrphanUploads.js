/**
 * backgroundJobs/cleanupOrphanUploads.js
 *
 * Cron-triggered orphan-upload cleanup. Runs daily at 3 AM (registered
 * by startBackgroundJobs). Scans the uploads directory for files older
 * than 7 days and deletes them — UNLESS they're:
 *   - still referenced by a scheduled/draft/failed-retryable post, OR
 *   - part of the permanent asset library (uploads/library/** and any
 *     path referenced by asset_library).
 *
 * Library files must never be auto-deleted: the content pipeline
 * rotates through them for reposts, so they are intentionally long-lived
 * until the user removes them from the Asset Library UI.
 *
 * Extracted from startBackgroundJobs as a standalone function so the
 * cron registration in startBackgroundJobs.js stays a one-liner.
 *
 * Path note: the original backgroundJobs.js used `path.join(__dirname,
 * "../../public/uploads")` as the dev-mode fallback. Since this split
 * file lives one directory deeper (src/jobs/backgroundJobs/), the
 * fallback is `path.join(__dirname, "../../../public/uploads")` to
 * resolve to the same <root>/public/uploads directory.
 */

const fs = require("fs");
const path = require("path");
const { getDb } = require("../../db/database");
const logger = require("../../utils/logger");

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function getUploadsDir() {
  return process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.join(__dirname, "../../../public/uploads");
}

/**
 * Build a set of basenames + absolute paths that belong to the asset
 * library so the orphan sweeper never touches them.
 */
function loadLibraryProtectedPaths(db, uploadsDir) {
  const protectedPaths = new Set();
  const libraryDir = path.join(uploadsDir, "library");
  protectedPaths.add(libraryDir.toLowerCase());

  try {
    const rows = db
      .prepare("SELECT file_path, file_url FROM asset_library")
      .all();
    for (const row of rows) {
      if (row.file_path) {
        protectedPaths.add(String(row.file_path).toLowerCase());
        protectedPaths.add(path.basename(row.file_path).toLowerCase());
      }
      if (row.file_url) {
        protectedPaths.add(String(row.file_url).toLowerCase());
        protectedPaths.add(path.basename(row.file_url).toLowerCase());
      }
    }
  } catch (err) {
    logger.warn("SERVER", `Could not load asset_library for orphan protect: ${err.message}`);
  }

  return { protectedPaths, libraryDir };
}

function isProtected(fp, basename, { protectedPaths, libraryDir }) {
  const lowerFp = fp.toLowerCase();
  const lowerBase = basename.toLowerCase();
  if (lowerFp === libraryDir.toLowerCase()) return true;
  if (lowerFp.startsWith(`${libraryDir.toLowerCase()}${path.sep}`)) return true;
  if (protectedPaths.has(lowerFp) || protectedPaths.has(lowerBase)) return true;
  return false;
}

/**
 * Scan the top-level uploads dir and delete orphan files older than
 * 7 days (or all orphans when force=true). Never descends into (or
 * deletes) uploads/library/. Skips files still referenced by any
 * pending post.
 *
 * @param {{ force?: boolean }} [opts]
 * @returns {{ deleted: number, kept: number, force: boolean }}
 */
function cleanupOrphanUploads(opts = {}) {
  const force = Boolean(opts.force);
  const stats = { deleted: 0, kept: 0, force };
  const dir = getUploadsDir();
  if (!fs.existsSync(dir)) return stats;

  const db = getDb();
  const cutoff = force ? Date.now() + 1 : Date.now() - RETENTION_MS;
  const protect = loadLibraryProtectedPaths(db, dir);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    logger.warn("SERVER", `Orphan upload cleanup could not read ${dir}: ${err.message}`);
    return stats;
  }

  for (const entry of entries) {
    // Never touch the permanent asset library directory.
    if (entry.name === "library") {
      stats.kept += 1;
      continue;
    }

    const fp = path.join(dir, entry.name);
    try {
      // Only clean top-level files (not nested dirs like library/).
      if (entry.isDirectory()) continue;

      if (isProtected(fp, entry.name, protect)) {
        stats.kept += 1;
        logger.debug("SERVER", `Keeping library-protected upload: ${entry.name}`);
        continue;
      }

      const fileStats = fs.statSync(fp);
      const pendingRow = db
        .prepare(
          `SELECT 1
           FROM posts
           WHERE (media_paths LIKE ? OR media_path IN (?, ?, ?))
             AND (
               status IN ('scheduled', 'draft')
               OR (status = 'failed' AND (retry_count > 0 OR next_retry_at IS NOT NULL))
             )
           LIMIT 1`,
        )
        .get(`%${fp}%`, fp, `/uploads/${entry.name}`, `uploads/${entry.name}`);

      if (!pendingRow && fileStats.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        stats.deleted += 1;
        logger.info("SERVER", `Cleaned up orphan upload: ${entry.name}`);
      } else if (pendingRow) {
        stats.kept += 1;
        logger.debug(
          "SERVER",
          `Keeping upload referenced by pending post: ${entry.name}`,
        );
      } else {
        stats.kept += 1;
      }
    } catch (e) {
      /* ignore per-file errors so one stuck file doesn't abort the sweep */
    }
  }

  logger.info(
    "SERVER",
    `Orphan upload cleanup finished${force ? " (force)" : ""}: deleted=${stats.deleted}, kept=${stats.kept}`,
  );

  return stats;
}

module.exports = { cleanupOrphanUploads };
