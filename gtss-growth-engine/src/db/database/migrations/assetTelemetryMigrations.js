/**
 * assetTelemetryMigrations.js — Asset-library grouping + telemetry table.
 *
 * Adds the `group_id` / `position` columns to asset_library rows (so the user
 * can group uploaded images into multi-image posts / carousels) and creates
 * the `asset_groups` table + its index. Also creates the `telemetry_logs`
 * table used by platform-action timing instrumentation.
 *
 * Every block is wrapped in `try { ... } catch (_) {}` so existing databases
 * that already have these columns / tables simply no-op — identical to the
 * original monolithic database.js behaviour.
 */
"use strict";

function runAssetTelemetryMigrations(database) {
  // ── Asset grouping migrations ─────────────────────────────────────────
  // Add group_id + position columns to existing asset_library rows so the
  // user can group uploaded images into multi-image posts / carousels.
  try {
    database.exec("ALTER TABLE asset_library ADD COLUMN group_id INTEGER");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE asset_library ADD COLUMN position INTEGER DEFAULT 0");
  } catch (_) {}
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS asset_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        label TEXT,
        post_type TEXT DEFAULT 'carousel',
        times_used INTEGER DEFAULT 0,
        last_used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (_) {}
  try {
    database.exec("CREATE INDEX IF NOT EXISTS idx_asset_library_group_id ON asset_library(group_id)");
  } catch (_) {}

  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        action_type TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER,
        processed_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        details_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch (_) {}
}

module.exports = {
  runAssetTelemetryMigrations,
};
