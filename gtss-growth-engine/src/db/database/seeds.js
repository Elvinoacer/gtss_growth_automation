/**
 * seeds.js — Default settings & pipeline schedule seeders.
 *
 * Called at the end of `initializeSchema` (in schema.js) so that every fresh
 * database starts with:
 *   - A populated `settings` table: daily_limits (mirrored from config/limits),
 *     campaign_queue_lock, content_pipeline_lock, outreach-mode prefs, and
 *     ~25 feature-flag / config defaults (retry, warmup timing, discovery
 *     thresholds, etc.).
 *   - A populated `pipeline_schedules` table: outreach / content / dm_check /
 *     mass_follow rows (all disabled by default), plus a one-time cleanup of
 *     any stale TikTok mass-follow rows from earlier schema versions.
 *
 * Both seeders are idempotent: re-running them on an existing database is a
 * no-op (INSERT OR IGNORE / ON CONFLICT DO NOTHING).
 */
"use strict";

const limits = require("../../config/limits");

function seedDefaultSettings(database) {
  const row = database
    .prepare("SELECT value FROM settings WHERE key = 'daily_limits'")
    .get();

  if (!row) {
    database
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('daily_limits', ?) ON CONFLICT(key) DO NOTHING",
      )
      .run(JSON.stringify(limits));
  }

  const queueLockRow = database
    .prepare("SELECT value FROM settings WHERE key = 'campaign_queue_lock'")
    .get();
  if (!queueLockRow) {
    database
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('campaign_queue_lock', ?) ON CONFLICT(key) DO NOTHING",
      )
      .run("false");
  }

  // Seed default outreach modes
  const xOutreachModeRow = database
    .prepare("SELECT value FROM settings WHERE key = 'x_outreach_mode'")
    .get();
  if (!xOutreachModeRow) {
    database
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('x_outreach_mode', ?) ON CONFLICT(key) DO NOTHING",
      )
      .run("follow_first");
  }

  const linkedinOutreachModeRow = database
    .prepare("SELECT value FROM settings WHERE key = 'linkedin_outreach_mode'")
    .get();
  if (!linkedinOutreachModeRow) {
    database
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('linkedin_outreach_mode', ?) ON CONFLICT(key) DO NOTHING",
      )
      .run("connect_first");
  }

  // Seed content pipeline overlap lock
  const contentPipelineLockRow = database
    .prepare("SELECT value FROM settings WHERE key = 'content_pipeline_lock'")
    .get();
  if (!contentPipelineLockRow) {
    database
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('content_pipeline_lock', ?) ON CONFLICT(key) DO NOTHING",
      )
      .run("false");
  }

  const defaults = {
    retry_max_attempts: "5",
    retry_delay_preset: "conservative",
    pipeline_outreach_paused: "false",
    pipeline_content_paused: "false",
    pipeline_dm_check_paused: "true",
    pipeline_mass_follow_paused: "false",
    pipeline_discovery_paused: "false",
    content_asset_source: "ai",
    content_library_media_type: "image",
    warmup_min_follow_to_story_hours: "24",
    warmup_max_follow_to_story_hours: "48",
    warmup_min_story_to_like_hours: "12",
    warmup_max_story_to_like_hours: "24",
    warmup_min_like_to_dm_hours: "24",
    warmup_max_like_to_dm_hours: "48",
    fast_warmup_enabled: "0",
    auto_warmup_on_qualify: "1",
    unfollow_after_days: "30",
    unfollow_pending_after_days: "14",
    max_following_ratio: "1.5",
    discovery_max_per_hashtag: "30",
    discovery_min_followers: "100",
    discovery_max_followers: "100000",
    ig_selector_version: "1",
  };

  const stmt = database.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
  );
  Object.entries(defaults).forEach(([key, value]) => stmt.run(key, value));
}

function seedDefaultPipelineSchedules(database) {
  // Outreach pipeline — disabled by default until user turns it on
  database.prepare(`
    INSERT OR IGNORE INTO pipeline_schedules
      (id, name, description, enabled, cron, limits_json)
    VALUES (
      'outreach',
      'Lead Outreach Pipeline',
      'Discovery → Qualification → Message Generation → DM Send',
      0,
      '0 8 * * *',
      '{"platforms": ["linkedin", "x"], "max_leads_per_keyword": 10, "max_dms_per_run": 20, "max_connections_per_run": 15}'
    )
  `).run();

  // Content pipeline — disabled by default until user configures topic/platforms
  database.prepare(`
    INSERT OR IGNORE INTO pipeline_schedules
      (id, name, description, enabled, cron, limits_json)
    VALUES (
      'content',
      'Auto-Content Posting Pipeline',
      'Gemini image generation → Caption generation → Multi-platform post',
      0,
      '0 9 * * *',
      '{"platforms": ["instagram", "linkedin"], "topic": "", "style": "photorealistic", "max_posts_per_run": 1}'
    )
  `).run();

  database.prepare(`
    INSERT OR IGNORE INTO pipeline_schedules
      (id, name, description, enabled, cron, limits_json)
    VALUES (
      'dm_check',
      'DM Inbox Checker',
      'Scans connected social inboxes for new replies',
      0,
      '*/30 * * * *',
      '{"active_hours_start": 8, "active_hours_end": 22, "timezone": "Africa/Nairobi", "platforms": ["instagram", "linkedin", "x", "facebook"], "prompt": ""}'
    )
  `).run();

  // Mass-Follow pipeline — disabled by default until the user adds targets
  // and configures platforms. Cron runs every 30 minutes; each run pulls a
  // batch of pending mass_follow_targets rows, follows them via the platform
  // adapter (which respects per-platform active windows, daily limits, and
  // rolling weekly limits), and writes a summary back to the pipeline logs.
  database.prepare(`
    INSERT OR IGNORE INTO pipeline_schedules
      (id, name, description, enabled, cron, limits_json)
    VALUES (
      'mass_follow',
      'Mass-Follow Pipeline',
      'Follow approved target accounts across X, LinkedIn, Facebook, and Instagram with strict rate limits',
      0,
      '*/30 * * * *',
      '{"platforms": ["instagram", "x", "linkedin", "facebook"], "max_follows_per_run": 20, "follow_interval_min_seconds": 40, "follow_interval_max_seconds": 110, "respect_active_window": true, "skip_already_following": true, "max_retries_per_target": 3}'
    )
  `).run();

  const massFollowRow = database
    .prepare("SELECT limits_json FROM pipeline_schedules WHERE id = 'mass_follow'")
    .get();
  if (massFollowRow && massFollowRow.limits_json) {
    try {
      const limitsJson = JSON.parse(massFollowRow.limits_json);
      if (Array.isArray(limitsJson.platforms)) {
        const platforms = limitsJson.platforms.filter((platform) => platform !== "tiktok");
        if (platforms.length !== limitsJson.platforms.length) {
          database
            .prepare("UPDATE pipeline_schedules SET limits_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 'mass_follow'")
            .run(JSON.stringify({ ...limitsJson, platforms }));
        }
      }
    } catch (_) {}
  }
  database.prepare("DELETE FROM mass_follow_targets WHERE platform = 'tiktok'").run();
  database.prepare("DELETE FROM pipeline_schedules WHERE id = 'tiktok_mass_follow'").run();
  database.prepare("DELETE FROM settings WHERE key = 'pipeline_tiktok_mass_follow_paused'").run();
}

module.exports = {
  seedDefaultSettings,
  seedDefaultPipelineSchedules,
};
