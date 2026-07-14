/**
 * Connection Queue — Defensive Schema Auto-Upgrade
 *
 * On module load, ensure the `connection_jobs` table has the `retry_count`
 * and `next_retry_at` columns that the retry / backoff logic depends on.
 * Older databases created before these columns existed would otherwise
 * crash the first processConnectionQueue run with a "no such column" error.
 *
 * Errors are caught and logged to stderr: a schema migration failure must
 * never crash the connection-queue pipeline on startup.
 *
 * Mirrors the dmQueue/schemaInit.js pattern from Task 6.
 *
 * Extracted from the original connectionQueue.js for maintainability.
 */

/**
 * Idempotent schema migration for the `connection_jobs` table. Adds
 * `retry_count` (INTEGER DEFAULT 0) and `next_retry_at` (TEXT) columns if
 * missing. Safe to call multiple times — uses PRAGMA table_info to
 * introspect before ALTERing.
 *
 * @param {import("better-sqlite3").Database} db
 */
function ensureConnectionJobsSchema(db) {
  try {
    const connCols = db
      .prepare("PRAGMA table_info(connection_jobs)")
      .all()
      .map((c) => c.name);
    if (!connCols.includes("retry_count")) {
      db.exec(
        "ALTER TABLE connection_jobs ADD COLUMN retry_count INTEGER DEFAULT 0",
      );
    }
    if (!connCols.includes("next_retry_at")) {
      db.exec("ALTER TABLE connection_jobs ADD COLUMN next_retry_at TEXT");
    }
  } catch (err) {
    console.error(
      "[CONNECTION-QUEUE] Defensively handled schema migration error on startup:",
      err.message,
    );
  }
}

module.exports = {
  ensureConnectionJobsSchema,
};
