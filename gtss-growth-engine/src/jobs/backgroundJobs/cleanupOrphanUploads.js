/**
 * backgroundJobs/cleanupOrphanUploads.js
 *
 * Cron-triggered orphan-upload cleanup. Runs daily at 3 AM (registered
 * by startBackgroundJobs). Scans the uploads directory for files older
 * than 7 days and deletes them — UNLESS they're still referenced by a
 * scheduled/draft/failed-retryable post (so we never delete a media
 * file the user is about to publish).
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

/**
 * Scan the uploads dir and delete orphan files older than 7 days.
 * Skips files still referenced by any pending post (scheduled/draft/
 * failed-retryable). Best-effort — per-file errors are swallowed so
 * one stuck file doesn't abort the whole sweep.
 */
function cleanupOrphanUploads() {
  // Use the writable UPLOADS_DIR (set by the desktop launcher) so we
  // don't try to readdir the read-only <resources>/server/public/uploads.
  const dir = process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.join(__dirname, "../../../public/uploads");
  if (!fs.existsSync(dir)) return;
  const db = getDb();
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  fs.readdirSync(dir).forEach((f) => {
    const fp = path.join(dir, f);
    try {
      const stats = fs.statSync(fp);
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
        .get(`%${fp}%`, fp, `/uploads/${f}`, `uploads/${f}`);

      if (!pendingRow && stats.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        logger.info("SERVER", `Cleaned up orphan upload: ${f}`);
      } else if (pendingRow) {
        logger.debug(
          "SERVER",
          `Keeping upload referenced by pending post: ${f}`,
        );
      }
    } catch (e) {
      /* ignore */
    }
  });
}

module.exports = { cleanupOrphanUploads };
