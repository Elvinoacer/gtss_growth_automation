/**
 * DM Queue — Defensive Schema Auto-Upgrade
 * On module load, ensure the `dm_jobs` table has the `retry_count` and
 * `next_retry_at` columns that the retry / backoff logic depends on. Older
 * databases created before these columns existed would otherwise crash the
 * first processDmQueue run with a "no such column" error.
 *
 * Errors are caught and logged to stderr: a schema migration failure must
 * never crash the messaging pipeline on startup.
 *
 * Extracted from the original dmQueue.js for maintainability.
 */

/**
 * Idempotent schema migration for the `dm_jobs` table. Adds `retry_count`
 * (INTEGER DEFAULT 0) and `next_retry_at` (TEXT) columns if missing. Safe to
 * call multiple times — uses PRAGMA table_info to introspect before ALTERing.
 *
 * @param {import("better-sqlite3").Database} db
 */
function ensureDmJobsSchema(db) {
  try {
    const dmCols = db
      .prepare("PRAGMA table_info(dm_jobs)")
      .all()
      .map((c) => c.name);
    if (!dmCols.includes("retry_count")) {
      db.exec("ALTER TABLE dm_jobs ADD COLUMN retry_count INTEGER DEFAULT 0");
    }
    if (!dmCols.includes("next_retry_at")) {
      db.exec("ALTER TABLE dm_jobs ADD COLUMN next_retry_at TEXT");
    }
  } catch (err) {
    console.error(
      "[DM-QUEUE] Defensively handled schema migration error on startup:",
      err.message,
    );
  }
}

module.exports = {
  ensureDmJobsSchema,
};
