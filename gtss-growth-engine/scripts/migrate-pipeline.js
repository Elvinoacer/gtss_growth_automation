#!/usr/bin/env node

/**
 * Pipeline Database Migration
 *
 * Creates:
 *   - pipeline_runs table
 *   - leads.pipeline_run_id column
 *   - discovery_runs.pipeline_run_id column
 *   - messages.generated_by column
 *
 * Idempotent — safe to run multiple times.
 * Usage: node scripts/migrate-pipeline.js
 */

require('dotenv').config();
const { getDb } = require('../src/db/database');

function migrate() {
  const db = getDb();

  console.log('[MIGRATE] Starting pipeline migration...');

  // ── 1. Create pipeline_runs table ──────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger     TEXT NOT NULL,
      mode        TEXT NOT NULL,
      status      TEXT DEFAULT 'running',
      stages_json TEXT,
      started_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME
    );
  `);
  console.log('[MIGRATE] ✓ pipeline_runs table ready');

  // ── 2. Add pipeline_run_id to leads ────────────────────────────────────────
  try {
    db.exec('ALTER TABLE leads ADD COLUMN pipeline_run_id INTEGER REFERENCES pipeline_runs(id)');
    console.log('[MIGRATE] ✓ leads.pipeline_run_id column added');
  } catch (_) {
    console.log('[MIGRATE] · leads.pipeline_run_id column already exists');
  }

  // ── 3. Add pipeline_run_id to discovery_runs ───────────────────────────────
  try {
    db.exec('ALTER TABLE discovery_runs ADD COLUMN pipeline_run_id INTEGER REFERENCES pipeline_runs(id)');
    console.log('[MIGRATE] ✓ discovery_runs.pipeline_run_id column added');
  } catch (_) {
    console.log('[MIGRATE] · discovery_runs.pipeline_run_id column already exists');
  }

  // ── 4. Add generated_by to messages ────────────────────────────────────────
  try {
    db.exec("ALTER TABLE messages ADD COLUMN generated_by TEXT DEFAULT 'ai'");
    console.log('[MIGRATE] ✓ messages.generated_by column added');
  } catch (_) {
    console.log('[MIGRATE] · messages.generated_by column already exists');
  }

  console.log('[MIGRATE] Pipeline migration complete.');
}

migrate();
