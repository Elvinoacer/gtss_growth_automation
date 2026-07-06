#!/usr/bin/env node

/**
 * Pipeline Operations Overhaul Migration
 *
 * Adds production-grade tables and columns for:
 *   - Per-execution lifecycle tracking (pipeline_executions)
 *   - Per-stage checkpoints (pipeline_checkpoints)
 *   - Structured searchable logs (pipeline_logs)
 *   - Health & state columns on pipeline_schedules
 *
 * Idempotent — safe to run multiple times.
 *
 * Usage: node scripts/migrate-pipeline-operations.js
 *
 * This migration is also applied automatically on server boot via
 * src/db/database.js's initializeSchema(). This script exists so you can
 * run it explicitly against an existing database before deploying the
 * new code (e.g. in a CI/CD pipeline).
 */

require('dotenv').config();
const { getDb } = require('../src/db/database');

function migrate() {
  const db = getDb();
  console.log('[MIGRATE] Starting pipeline-operations migration...');

  // ── 1. Add new columns to pipeline_schedules ─────────────────────────────
  const scheduleCols = db
    .prepare("PRAGMA table_info(pipeline_schedules)")
    .all()
    .map((c) => c.name);
  const addCol = (col, def) => {
    if (!scheduleCols.includes(col)) {
      db.exec(`ALTER TABLE pipeline_schedules ADD COLUMN ${col} ${def}`);
      console.log(`[MIGRATE] ✓ pipeline_schedules.${col} added`);
    } else {
      console.log(`[MIGRATE] · pipeline_schedules.${col} already exists`);
    }
  };
  addCol('current_state', "TEXT DEFAULT 'idle'");
  addCol('current_execution_id', 'TEXT');
  addCol('last_error', 'TEXT');
  addCol('last_success_at', 'DATETIME');
  addCol('last_failure_at', 'DATETIME');
  addCol('total_runs', 'INTEGER NOT NULL DEFAULT 0');
  addCol('total_failures', 'INTEGER NOT NULL DEFAULT 0');
  addCol('total_retries', 'INTEGER NOT NULL DEFAULT 0');
  addCol('consecutive_failures', 'INTEGER NOT NULL DEFAULT 0');
  addCol('avg_duration_ms', 'INTEGER');

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_pipeline_schedules_state ON pipeline_schedules(current_state)",
  );
  console.log('[MIGRATE] ✓ idx_pipeline_schedules_state ready');

  // ── 2. Create pipeline_executions table ──────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_executions (
      id              TEXT PRIMARY KEY,
      pipeline_id     TEXT NOT NULL,
      trigger         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      state           TEXT NOT NULL DEFAULT 'idle',
      current_stage   TEXT,
      current_message TEXT,
      progress        INTEGER DEFAULT 0,
      total_steps     INTEGER DEFAULT 0,
      completed_steps INTEGER DEFAULT 0,
      failed_stage    TEXT,
      error_message   TEXT,
      stack_trace     TEXT,
      retry_count     INTEGER NOT NULL DEFAULT 0,
      max_retries     INTEGER NOT NULL DEFAULT 3,
      started_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at     DATETIME,
      paused_at       DATETIME,
      resumed_at      DATETIME,
      stopped_at      DATETIME,
      duration_ms     INTEGER,
      metadata_json   TEXT,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_executions_pipeline ON pipeline_executions(pipeline_id);
    CREATE INDEX IF NOT EXISTS idx_pipeline_executions_status ON pipeline_executions(status);
    CREATE INDEX IF NOT EXISTS idx_pipeline_executions_started ON pipeline_executions(started_at DESC);
  `);
  console.log('[MIGRATE] ✓ pipeline_executions table ready');

  // ── 3. Create pipeline_checkpoints table ─────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_checkpoints (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id    TEXT NOT NULL,
      pipeline_id     TEXT NOT NULL,
      stage           TEXT NOT NULL,
      status          TEXT NOT NULL,
      attempt         INTEGER DEFAULT 1,
      payload_json    TEXT,
      error_message   TEXT,
      duration_ms     INTEGER,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_checkpoints_exec ON pipeline_checkpoints(execution_id);
    CREATE INDEX IF NOT EXISTS idx_pipeline_checkpoints_pipeline ON pipeline_checkpoints(pipeline_id);
    CREATE INDEX IF NOT EXISTS idx_pipeline_checkpoints_stage ON pipeline_checkpoints(stage);
  `);
  console.log('[MIGRATE] ✓ pipeline_checkpoints table ready');

  // ── 4. Create pipeline_logs table ────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_logs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_id     TEXT NOT NULL,
      execution_id    TEXT,
      stage           TEXT,
      level           TEXT NOT NULL DEFAULT 'info',
      message         TEXT NOT NULL,
      stack_trace     TEXT,
      context_json    TEXT,
      browser_event   TEXT,
      retry_attempt   INTEGER,
      source          TEXT DEFAULT 'system',
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_logs_pipeline ON pipeline_logs(pipeline_id);
    CREATE INDEX IF NOT EXISTS idx_pipeline_logs_execution ON pipeline_logs(execution_id);
    CREATE INDEX IF NOT EXISTS idx_pipeline_logs_level ON pipeline_logs(level);
    CREATE INDEX IF NOT EXISTS idx_pipeline_logs_stage ON pipeline_logs(stage);
    CREATE INDEX IF NOT EXISTS idx_pipeline_logs_created ON pipeline_logs(created_at DESC);
  `);
  console.log('[MIGRATE] ✓ pipeline_logs table ready');

  // ── 5. Sweep any stale 'running' rows from previous runs ─────────────────
  const stale = db
    .prepare(
      `SELECT COUNT(*) as c FROM pipeline_executions
       WHERE status IN ('running', 'paused', 'resuming', 'stopping', 'retrying', 'pending')`,
    )
    .get();
  if (stale.c > 0) {
    db.prepare(
      `UPDATE pipeline_executions
       SET status = 'failed',
           state = 'failed',
           error_message = COALESCE(error_message, 'Marked failed by migration script (pre-existing stale state)'),
           finished_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE status IN ('running', 'paused', 'resuming', 'stopping', 'retrying', 'pending')`,
    ).run();
    console.log(`[MIGRATE] ✓ Swept ${stale.c} stale execution(s) → 'failed'`);
  } else {
    console.log('[MIGRATE] · No stale executions to sweep');
  }

  // ── 6. Reset schedule-level current_state for any pipeline stuck in a
  //         transient state, so the UI doesn't show a phantom 'running' state
  db.prepare(
    `UPDATE pipeline_schedules
     SET current_state = 'idle',
         current_execution_id = NULL,
         last_status = CASE
           WHEN last_status IN ('running', 'paused', 'resuming', 'stopping', 'retrying') THEN 'failed'
           ELSE last_status
         END,
         updated_at = CURRENT_TIMESTAMP
     WHERE current_state IN ('running', 'paused', 'resuming', 'stopping', 'retrying')`,
  ).run();
  console.log('[MIGRATE] ✓ Reset stale pipeline_schedules.current_state values');

  console.log('[MIGRATE] Pipeline-operations migration complete.');
}

try {
  migrate();
  process.exit(0);
} catch (err) {
  console.error('[MIGRATE] Migration failed:', err.message);
  console.error(err.stack);
  process.exit(1);
}
