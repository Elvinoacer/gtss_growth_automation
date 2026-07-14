/**
 * postInit.js — Post-schema initialization steps run at server boot.
 *
 * `initializeDatabase` is the entry point that `server.js` calls during
 * startup (in addition to the schema initialization that already ran when
 * the `db` singleton was opened). It re-runs `initializeSchema` (idempotent),
 * then performs two one-shot maintenance tasks:
 *
 *   1. `migrateKeywordsToContextStore` — one-time migration of the legacy
 *      src/config/keywords.json file into the `settings` table. Runs at most
 *      once per database (gated on the `ctx_discovery_keywords` settings row
 *      already existing).
 *
 *   2. `cleanupStaleJobs` — sweeps any `qualification_jobs`, `message_generation_jobs`,
 *      and `automation_jobs` rows left in a non-terminal state by a previous
 *      server crash, marking them FAILED so the UI doesn't show them as
 *      perpetually "running".
 *
 * Both helpers are private to this module — they are not re-exported by
 * index.js (matching the original database.js module.exports surface).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { db, getDb } = require("./connection");
const { initializeSchema } = require("./schema");

function initializeDatabase() {
  initializeSchema(db);
  // Migrate keywords.json -> context store (runs once, skipped if already migrated)
  migrateKeywordsToContextStore();
  cleanupStaleJobs();
}

function migrateKeywordsToContextStore() {
  try {
    const db = getDb();
    // Check if already migrated
    const existing = db
      .prepare(
        "SELECT value FROM settings WHERE key = 'ctx_discovery_keywords'",
      )
      .get();
    if (existing) return; // Already done

    const fs = require("fs");
    const path = require("path");
    const filePath = path.resolve("./src/config/keywords.json");
    if (!fs.existsSync(filePath)) return;

    const fileContent = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const keywords = fileContent.keywords || [];
    const maxPerKeyword = fileContent.maxLeadsPerKeyword || 10;

    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('ctx_discovery_keywords', ?) ON CONFLICT(key) DO NOTHING",
    ).run(JSON.stringify(keywords));

    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('ctx_discovery_max_per_keyword', ?) ON CONFLICT(key) DO NOTHING",
    ).run(String(maxPerKeyword));

    const logger = require("../../utils/logger");
    logger.info(
      "DB",
      `Migrated ${keywords.length} keywords from keywords.json to context store`,
    );
  } catch (err) {
    // Non-fatal - log and continue
    console.warn("[DB] keywords.json migration skipped:", err.message);
  }
}

function cleanupStaleJobs() {
  try {
    const db = getDb();

    // Mark qualification jobs that were running when the server crashed as FAILED
    const qualResult = db.prepare(`
      UPDATE qualification_jobs
      SET status = 'FAILED', completed_at = CURRENT_TIMESTAMP
      WHERE completed_at IS NULL
    `).run();

    if (qualResult.changes > 0) {
      const logger = require("../../utils/logger");
      logger.info("DB", `Cleaned up ${qualResult.changes} stale qualification jobs from previous run.`);
    }

    // Similarly clean up message generation jobs
    const msgResult = db.prepare(`
      UPDATE message_generation_jobs
      SET status = 'FAILED', completed_at = CURRENT_TIMESTAMP
      WHERE completed_at IS NULL
    `).run();

    if (msgResult.changes > 0) {
      const logger = require("../../utils/logger");
      logger.info("DB", `Cleaned up ${msgResult.changes} stale message generation jobs from previous run.`);
    }

    // Similarly clean up automation jobs
    const autoResult = db.prepare(`
      UPDATE automation_jobs
      SET status = 'FAILED', completed_at = CURRENT_TIMESTAMP
      WHERE completed_at IS NULL
    `).run();

    if (autoResult.changes > 0) {
      const logger = require("../../utils/logger");
      logger.info("DB", `Cleaned up ${autoResult.changes} stale automation jobs from previous run.`);
    }
  } catch (err) {
    console.warn("[DB] Stale job cleanup skipped:", err.message);
  }
}

module.exports = {
  initializeDatabase,
  migrateKeywordsToContextStore,
  cleanupStaleJobs,
};
