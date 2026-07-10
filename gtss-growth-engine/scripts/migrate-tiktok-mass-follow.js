/**
 * migrate-tiktok-mass-follow.js
 *
 * One-shot migration that adds the `tiktok_mass_follow` pipeline schedule
 * row (and its `pipeline_tiktok_mass_follow_paused` setting) to existing
 * databases. Fresh databases get these for free via seedDefaultPipelineSchedules
 * in src/db/database.js — this script is for databases created before the
 * TikTok mass-follow pipeline existed.
 *
 * Usage:
 *   node scripts/migrate-tiktok-mass-follow.js
 *
 * Safe to run multiple times (uses INSERT OR IGNORE).
 */

const path = require('path');
const { getDb } = require('../src/db/database');

const db = getDb();

console.log('[migrate-tiktok-mass-follow] Starting migration…');

// 1. Insert the pipeline schedule row (idempotent).
const scheduleResult = db.prepare(`
  INSERT OR IGNORE INTO pipeline_schedules
    (id, name, description, enabled, cron, limits_json)
  VALUES (
    'tiktok_mass_follow',
    'TikTok Mass-Follow Pipeline',
    'Search TikTok for users by query and follow them directly from the search results page',
    0,
    '*/30 * * * *',
    '{"search_query": "restaurant owners", "max_follows_per_run": 20, "follow_interval_min_seconds": 40, "follow_interval_max_seconds": 110, "max_scrolls": 3, "respect_active_window": true}'
  )
`).run();

if (scheduleResult.changes > 0) {
  console.log('[migrate-tiktok-mass-follow] ✓ Inserted tiktok_mass_follow pipeline schedule');
} else {
  console.log('[migrate-tiktok-mass-follow] • tiktok_mass_follow pipeline schedule already exists (no-op)');
}

// 2. Insert the paused-flag setting (idempotent).
const settingResult = db.prepare(`
  INSERT OR IGNORE INTO settings (key, value) VALUES ('pipeline_tiktok_mass_follow_paused', 'false')
`).run();

if (settingResult.changes > 0) {
  console.log('[migrate-tiktok-mass-follow] ✓ Inserted pipeline_tiktok_mass_follow_paused setting');
} else {
  console.log('[migrate-tiktok-mass-follow] • pipeline_tiktok_mass_follow_paused setting already exists (no-op)');
}

// 3. Verify.
const row = db.prepare('SELECT id, name, enabled, cron, limits_json FROM pipeline_schedules WHERE id = ?').get('tiktok_mass_follow');
if (row) {
  console.log('[migrate-tiktok-mass-follow] Verification:', {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    cron: row.cron,
    limits: row.limits_json,
  });
} else {
  console.error('[migrate-tiktok-mass-follow] ✗ FAILED: row not found after insert');
  process.exit(1);
}

console.log('[migrate-tiktok-mass-follow] Migration complete.');
