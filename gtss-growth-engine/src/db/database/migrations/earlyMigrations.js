/**
 * earlyMigrations.js — Earliest safe migrations applied right after schema.sql.
 *
 * These run BEFORE any other migration group. They extend the `messages` and
 * `posts` tables (created by schema.sql) with retry / snooze / fail-category
 * columns, and create the automation-job / image-gen-job tables that the
 * background job runners depend on.
 *
 * Every block is wrapped in `try { ... } catch (_) {}` so existing databases
 * that already have these columns / tables simply no-op — identical to the
 * original monolithic database.js behaviour.
 */
"use strict";

function runEarlyMigrations(database) {
  // ── messages column additions ──────────────────────────────────────────
  try {
    database.exec("ALTER TABLE messages ADD COLUMN snooze_until DATETIME");
  } catch (_) {
    /* column exists */
  }
  try {
    database.exec(
      "ALTER TABLE messages ADD COLUMN retry_count INTEGER DEFAULT 0",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE messages ADD COLUMN last_error TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE messages ADD COLUMN blocked_reason TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE messages ADD COLUMN fail_category TEXT");
  } catch (_) {}

  // ── posts column additions ─────────────────────────────────────────────
  try {
    database.exec(
      "ALTER TABLE posts ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE posts ADD COLUMN next_retry_at TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE posts ADD COLUMN last_error TEXT");
  } catch (_) {}

  // ── automation_jobs / automation_events / action_fingerprints ──────────
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS automation_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        started_at DATETIME,
        completed_at DATETIME,
        details_json TEXT
      );

      CREATE TABLE IF NOT EXISTS automation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT,
        platform TEXT,
        account TEXT,
        action_type TEXT,
        target TEXT,
        message_id INTEGER REFERENCES messages(id),
        lead_id INTEGER REFERENCES leads(id),
        status TEXT NOT NULL,
        warning_detected INTEGER DEFAULT 0,
        details_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS action_fingerprints (
        fingerprint TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        action_type TEXT NOT NULL,
        target TEXT NOT NULL,
        message_id INTEGER REFERENCES messages(id),
        lead_id INTEGER REFERENCES leads(id),
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch (_) {
    /* tables exist */
  }

  // ── image_gen_jobs ─────────────────────────────────────────────────────
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS image_gen_jobs (
        id           TEXT PRIMARY KEY,
        meta_prompt  TEXT NOT NULL,
        gen_prompt   TEXT,
        status       TEXT DEFAULT 'pending',
        file_path    TEXT,
        file_name    TEXT,
        error        TEXT,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );
    `);
  } catch (_) {
    /* table exists */
  }
}

module.exports = {
  runEarlyMigrations,
};
