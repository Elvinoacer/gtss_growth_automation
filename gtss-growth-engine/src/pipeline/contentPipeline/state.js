/**
 * contentPipeline/state.js
 *
 * Module-level constants + small helpers for the auto-content pipeline:
 *
 *  - UPLOADS_DIR: the writable uploads directory (process.env.UPLOADS_DIR
 *    when set by the desktop launcher, otherwise the bundled
 *    <serverRoot>/public/uploads in dev mode). The split file lives one
 *    directory deeper than the original, so the dev-mode fallback is
 *    `path.resolve(__dirname, "../../../public/uploads")` (three ".."
 *    hops: contentPipeline/ → pipeline/ → src/ → root).
 *  - CONTENT_STAGES: the canonical stage list (used for logging + the
 *    lifecycle state service's progress bridge).
 *  - buildContentEmitter(jobId): returns an emit(event) function that
 *    logs the event to the logger + DB logger, updates the jobRegistry
 *    job stage/message, and broadcasts via Socket.IO so the Content
 *    Scheduler UI's live activity feed updates in real time.
 *  - acquireLock / releaseLock: cluster-safe DB-backed overlap lock
 *    (settings row 'content_pipeline_lock'). Prevents two content-
 *    pipeline runs from racing each other if a cron trigger fires while
 *    a manual run is mid-flight.
 *  - getSetting(key, fallback): thin wrapper around the settings table.
 *  - isPaused(): true if the per-pipeline pause flag
 *    (pipeline_content_paused) is set in the settings table.
 *  - throwIfAborted(signal): throws "Content pipeline aborted" if the
 *    AbortSignal fired (checked at the start of every stage).
 */

const path = require("path");
const { getDb } = require("../../db/database");
const jobRegistry = require("../../jobs/jobRegistry");
const logger = require("../../utils/logger");

// Resolve the writable uploads directory. The desktop launcher sets
// UPLOADS_DIR=<userData>/public/uploads (writable). In standalone dev mode
// (running `npm start` inside gtss-growth-engine/), UPLOADS_DIR is unset
// and we fall back to the bundled <serverRoot>/public/uploads (writable
// in dev). See src/routes/assets.js for the same pattern.
//
// Note: the original contentPipeline.js (in src/pipeline/) used
// `path.resolve(__dirname, "../../public/uploads")` — two ".." hops from
// src/pipeline/ to the project root. This split file lives one directory
// deeper (src/pipeline/contentPipeline/), so the equivalent fallback is
// THREE ".." hops: `path.resolve(__dirname, "../../../public/uploads")`.
const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.resolve(__dirname, "../../../public/uploads");

const CONTENT_STAGES = ["image_gen", "caption_gen", "post_record", "publish"];

/**
 * Build an emit(event) function for a content-pipeline run that fans the
 * event out to:
 *  - logger.info (always)
 *  - logger.db (with the stage label + platform if present)
 *  - jobRegistry.updateJob (so /api/jobs/:jobId polling sees the latest)
 *  - Socket.IO broadcast("content_pipeline:event") (live UI updates)
 */
function buildContentEmitter(jobId) {
  return (event) => {
    const stageLabel = event.stage || event.type || "event";
    const message = event.message || String(stageLabel);
    const level =
      event.level ||
      (String(stageLabel).toLowerCase() === "error" ? "error" : "info");

    logger.info("CONTENT-PIPELINE", `[${jobId}] ${stageLabel}: ${message}`);
    jobRegistry.updateJob(jobId, {
      stage: stageLabel,
      message,
      platform: event.platform,
    });
    logger.db(level, "content", stageLabel, message, {
      jobId,
      stage: stageLabel,
      platform: event.platform,
    });
    // Broadcast via Socket.IO for live UI updates
    try {
      const { broadcast } = require("../../services/socketService");
      broadcast("content_pipeline:event", { ...event, jobId });
    } catch (_) {}
  };
}

/**
 * Acquire the content pipeline lock. Returns true if acquired.
 *
 * Atomically UPDATE settings SET value='true' WHERE key='content_pipeline_lock'
 * AND value='false' — if changes===0, another run already holds the lock.
 * INSERT OR IGNORE first so the row exists on a fresh database.
 */
function acquireLock() {
  const db = getDb();
  const lockKey = "content_pipeline_lock";
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, 'false')",
  ).run(lockKey);
  const result = db
    .prepare(
      "UPDATE settings SET value = 'true' WHERE key = ? AND value = 'false'",
    )
    .run(lockKey);
  return result.changes > 0;
}

/**
 * Release the content pipeline lock. Best-effort — the finally block in
 * runContentPipelineNow always calls this.
 */
function releaseLock() {
  const db = getDb();
  db.prepare(
    "UPDATE settings SET value = 'false' WHERE key = 'content_pipeline_lock'",
  ).run();
}

function getSetting(key, fallback = null) {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function isPaused() {
  return String(getSetting("pipeline_content_paused", "false")) === "true";
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("Content pipeline aborted");
}

module.exports = {
  UPLOADS_DIR,
  CONTENT_STAGES,
  buildContentEmitter,
  acquireLock,
  releaseLock,
  getSetting,
  isPaused,
  throwIfAborted,
};
