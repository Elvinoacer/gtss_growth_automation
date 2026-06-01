#!/usr/bin/env node

/**
 * Monitoring Database Migration
 *
 * Creates:
 *   - pipeline_events table
 *   - pipeline_events indexes
 *
 * Idempotent - safe to run multiple times.
 * Usage: node scripts/migrate-monitoring.js
 */

require("dotenv").config();
const { getDb } = require("../src/db/database");

function migrate() {
  const db = getDb();

  console.log("[MIGRATE] Starting monitoring migration...");

  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      job_type     TEXT NOT NULL,
      job_id       TEXT,
      stage        TEXT,
      level        TEXT NOT NULL,
      message      TEXT NOT NULL,
      context_json TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log("[MIGRATE] pipeline_events table ready");

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_pipeline_events_job_id ON pipeline_events(job_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_pipeline_events_level ON pipeline_events(level)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_pipeline_events_created ON pipeline_events(created_at DESC)",
  );

  console.log("[MIGRATE] Monitoring migration complete.");
}

migrate();
