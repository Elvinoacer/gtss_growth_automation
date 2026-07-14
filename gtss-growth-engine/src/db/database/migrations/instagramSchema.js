/**
 * instagramSchema.js — Instagram-specific table creation migrations.
 *
 * Creates the IG warmup / follow-tracker / discovery-queue tables. The column
 * additions for these tables happen later (in tableExtensions.js) so the
 * table-creation step stays focused and easy to audit.
 *
 * Every block is wrapped in `try { ... } catch (_) {}` so existing databases
 * that already have these tables simply no-op — identical to the original
 * monolithic database.js behaviour.
 */
"use strict";

function runInstagramSchemaMigrations(database) {
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS ig_warmup_sequences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        status TEXT DEFAULT 'pending',
        current_step INTEGER DEFAULT 0,
        story_views_count INTEGER DEFAULT 0,
        post_likes_count INTEGER DEFAULT 0,
        comments_count INTEGER DEFAULT 0,
        last_action_at DATETIME,
        next_action_at DATETIME,
        next_step TEXT,
        next_step_after DATETIME,
        attempt_count INTEGER DEFAULT 0,
        completed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ig_warmup_sequences_lead ON ig_warmup_sequences(lead_id);

      CREATE TABLE IF NOT EXISTS ig_follow_tracker (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        username TEXT,
        status TEXT DEFAULT 'following',
        followed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        unfollowed_at DATETIME,
        eligible_for_unfollow INTEGER DEFAULT 1,
        follow_back_at DATETIME,
        follow_source TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ig_follow_tracker_lead ON ig_follow_tracker(lead_id);
      CREATE INDEX IF NOT EXISTS idx_ig_follow_tracker_username ON ig_follow_tracker(username);

      CREATE TABLE IF NOT EXISTS ig_discovery_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ig_username TEXT NOT NULL,
        source TEXT NOT NULL,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_ig_discovery_queue_username ON ig_discovery_queue(ig_username);
    `);
  } catch (_) {
    /* tables exist */
  }
}

module.exports = {
  runInstagramSchemaMigrations,
};
