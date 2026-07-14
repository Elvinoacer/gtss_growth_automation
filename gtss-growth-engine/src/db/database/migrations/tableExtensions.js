/**
 * tableExtensions.js — ALTER TABLE column additions on existing tables.
 *
 * Runs after earlyMigrations + instagramSchema (so the IG tables exist) and
 * before assetTelemetry / campaign / pipeline migrations. Adds:
 *   - pipeline_runs table (referenced by leads.pipeline_run_id)
 *   - leads.* columns (pipeline_run_id, x_handle, ig_username, ig_follower_count,
 *     ig_following_count, ig_post_count, ig_is_business, ig_business_category,
 *     ig_has_email, ig_has_phone, ig_bio, ig_follow_back_at, ig_warmup_status,
 *     replied_at)
 *   - discovery_runs.pipeline_run_id
 *   - messages.generated_by, messages.action_type, messages.ig_is_message_request
 *   - touchpoints.source, touchpoints.created_at
 *   - ig_warmup_sequences.* columns (next_step, next_step_after, attempt_count, completed_at)
 *   - ig_follow_tracker.* columns (eligible_for_unfollow, follow_status, follow_back_at, follow_source)
 *   - posts.* columns (ig_post_url, ig_post_type, ig_story_expires_at, media_paths,
 *     location_tag, captions_json)
 *
 * Every block is wrapped in `try { ... } catch (_) {}` so existing databases
 * that already have these columns simply no-op — identical to the original
 * monolithic database.js behaviour.
 */
"use strict";

function runTableExtensionMigrations(database) {
  // ── pipeline_runs table ────────────────────────────────────────────────
  try {
    database.exec(`
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
  } catch (_) {
    /* table exists */
  }

  // ── leads column additions ─────────────────────────────────────────────
  try {
    database.exec(
      "ALTER TABLE leads ADD COLUMN pipeline_run_id INTEGER REFERENCES pipeline_runs(id)",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN x_handle TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN ig_username TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN ig_follower_count INTEGER");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN ig_following_count INTEGER");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN ig_post_count INTEGER");
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE leads ADD COLUMN ig_is_business INTEGER DEFAULT 0",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN ig_business_category TEXT");
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE leads ADD COLUMN ig_has_email INTEGER DEFAULT 0",
    );
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE leads ADD COLUMN ig_has_phone INTEGER DEFAULT 0",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN ig_bio TEXT");
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE discovery_runs ADD COLUMN pipeline_run_id INTEGER REFERENCES pipeline_runs(id)",
    );
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE messages ADD COLUMN generated_by TEXT DEFAULT 'ai'",
    );
  } catch (_) {}

  // ── Instagram warmup safe migrations ───────────────────────────────────
  try {
    database.exec("ALTER TABLE ig_warmup_sequences ADD COLUMN next_step TEXT");
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE ig_warmup_sequences ADD COLUMN next_step_after DATETIME",
    );
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE ig_warmup_sequences ADD COLUMN attempt_count INTEGER DEFAULT 0",
    );
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE ig_warmup_sequences ADD COLUMN completed_at DATETIME",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN ig_follow_back_at DATETIME");
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE leads ADD COLUMN ig_warmup_status TEXT DEFAULT 'pending'",
    );
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE ig_follow_tracker ADD COLUMN eligible_for_unfollow INTEGER DEFAULT 1",
    );
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE ig_follow_tracker ADD COLUMN follow_status TEXT GENERATED ALWAYS AS (status)",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE messages ADD COLUMN action_type TEXT");
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE messages ADD COLUMN ig_is_message_request INTEGER DEFAULT 0",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE touchpoints ADD COLUMN source TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE touchpoints ADD COLUMN created_at DATETIME");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN replied_at DATETIME");
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE ig_follow_tracker ADD COLUMN follow_back_at DATETIME",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE posts ADD COLUMN ig_post_url TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE posts ADD COLUMN ig_post_type TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE posts ADD COLUMN ig_story_expires_at DATETIME");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE posts ADD COLUMN media_paths TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE posts ADD COLUMN location_tag TEXT");
  } catch (_) {}
  try {
    // Per-platform captions: JSON map of { platform: captionString }.
    // The content pipeline writes one caption per platform here, and the
    // publisher reads the platform-specific caption instead of re-using
    // the primary platform's caption (and truncating it for shorter-limit
    // platforms like X).
    database.exec("ALTER TABLE posts ADD COLUMN captions_json TEXT");
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE ig_follow_tracker ADD COLUMN follow_source TEXT",
    );
  } catch (_) {}
}

module.exports = {
  runTableExtensionMigrations,
};
