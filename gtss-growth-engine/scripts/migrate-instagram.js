#!/usr/bin/env node

/**
 * Instagram Database Migration Script
 * 
 * Extends leads, posts, and messages tables with Instagram-specific columns.
 * Creates new tables: ig_warmup_sequences and ig_follow_tracker.
 * 
 * Runs in a single database transaction. Idempotent.
 */

require('dotenv').config();
const { getDb } = require('../src/db/database');

function migrateInstagram() {
  const db = getDb();
  console.log('[MIGRATE] Starting Instagram database migration...');

  const migration = db.transaction(() => {
    // ── 1. Extend leads Table ───────────────────────────────────────────────
    const leadsColumns = new Set(db.pragma("table_info(leads)").map(c => c.name));
    
    const leadsMigrations = [
      { col: 'ig_username', type: 'TEXT' },
      { col: 'ig_follower_count', type: 'INTEGER' },
      { col: 'ig_following_count', type: 'INTEGER' },
      { col: 'ig_post_count', type: 'INTEGER' },
      { col: 'ig_is_business', type: 'INTEGER DEFAULT 0' },
      { col: 'ig_business_category', type: 'TEXT' },
      { col: 'ig_has_email', type: 'INTEGER DEFAULT 0' },
      { col: 'ig_has_phone', type: 'INTEGER DEFAULT 0' },
      { col: 'ig_bio', type: 'TEXT' },
      { 
        col: 'ig_warmup_status', 
        type: "TEXT DEFAULT 'pending' CHECK(ig_warmup_status IN ('pending','following','story_viewed','liked','warmup_complete','skipped'))" 
      }
    ];

    for (const m of leadsMigrations) {
      if (leadsColumns.has(m.col)) {
        console.log(`↷ leads.${m.col} already exists`);
      } else {
        try {
          db.exec(`ALTER TABLE leads ADD COLUMN ${m.col} ${m.type}`);
          console.log(`✓ leads.${m.col} added`);
        } catch (err) {
          if (err.message.includes('duplicate column name')) {
            console.log(`↷ leads.${m.col} already exists`);
          } else {
            throw err;
          }
        }
      }
    }

    // Retrieve current tables and indexes list
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name));
    const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(i => i.name));

    // ── 2. New Table: ig_warmup_sequences ────────────────────────────────────
    if (tables.has('ig_warmup_sequences')) {
      console.log('↷ ig_warmup_sequences table already exists');
    } else {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ig_warmup_sequences (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending','following','story_viewed','liked','warmup_complete','skipped')),
          current_step INTEGER DEFAULT 0 CHECK(current_step >= 0),
          story_views_count INTEGER DEFAULT 0 CHECK(story_views_count >= 0),
          post_likes_count INTEGER DEFAULT 0 CHECK(post_likes_count >= 0),
          comments_count INTEGER DEFAULT 0 CHECK(comments_count >= 0),
          last_action_at DATETIME,
          next_action_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('✓ ig_warmup_sequences table created');
    }

    // Indexes for ig_warmup_sequences
    if (indexes.has('idx_ig_warmup_sequences_lead')) {
      console.log('↷ idx_ig_warmup_sequences_lead index already exists');
    } else {
      db.exec('CREATE INDEX IF NOT EXISTS idx_ig_warmup_sequences_lead ON ig_warmup_sequences(lead_id);');
      console.log('✓ idx_ig_warmup_sequences_lead index created');
    }

    // ── 3. New Table: ig_follow_tracker ─────────────────────────────────────
    if (tables.has('ig_follow_tracker')) {
      console.log('↷ ig_follow_tracker table already exists');
    } else {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ig_follow_tracker (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
          username TEXT,
          status TEXT DEFAULT 'following' CHECK(status IN ('following','unfollowed','requested','failed')),
          followed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          unfollowed_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('✓ ig_follow_tracker table created');
    }

    // Indexes for ig_follow_tracker
    if (indexes.has('idx_ig_follow_tracker_lead')) {
      console.log('↷ idx_ig_follow_tracker_lead index already exists');
    } else {
      db.exec('CREATE INDEX IF NOT EXISTS idx_ig_follow_tracker_lead ON ig_follow_tracker(lead_id);');
      console.log('✓ idx_ig_follow_tracker_lead index created');
    }

    if (indexes.has('idx_ig_follow_tracker_username')) {
      console.log('↷ idx_ig_follow_tracker_username index already exists');
    } else {
      db.exec('CREATE INDEX IF NOT EXISTS idx_ig_follow_tracker_username ON ig_follow_tracker(username);');
      console.log('✓ idx_ig_follow_tracker_username index created');
    }

    // ── 4. Extend posts Table ────────────────────────────────────────────────
    const postsColumns = new Set(db.pragma("table_info(posts)").map(c => c.name));
    
    const postsMigrations = [
      { col: 'ig_post_type', type: 'TEXT' },
      { col: 'ig_media_paths', type: 'TEXT' },
      { col: 'ig_hashtags', type: 'TEXT' },
      { col: 'ig_location_tag', type: 'TEXT' },
      { col: 'ig_post_url', type: 'TEXT' },
      { col: 'ig_story_expires_at', type: 'DATETIME' }
    ];

    for (const m of postsMigrations) {
      if (postsColumns.has(m.col)) {
        console.log(`↷ posts.${m.col} already exists`);
      } else {
        try {
          db.exec(`ALTER TABLE posts ADD COLUMN ${m.col} ${m.type}`);
          console.log(`✓ posts.${m.col} added`);
        } catch (err) {
          if (err.message.includes('duplicate column name')) {
            console.log(`↷ posts.${m.col} already exists`);
          } else {
            throw err;
          }
        }
      }
    }

    // ── 5. Extend messages Table ─────────────────────────────────────────────
    const messagesColumns = new Set(db.pragma("table_info(messages)").map(c => c.name));
    
    if (messagesColumns.has('ig_is_message_request')) {
      console.log('↷ messages.ig_is_message_request already exists');
    } else {
      try {
        db.exec("ALTER TABLE messages ADD COLUMN ig_is_message_request INTEGER DEFAULT 0");
        console.log('✓ messages.ig_is_message_request added');
      } catch (err) {
        if (err.message.includes('duplicate column name')) {
          console.log('↷ messages.ig_is_message_request already exists');
        } else {
          throw err;
        }
      }
    }

    // ── 6. New Table: ig_discovery_queue ────────────────────────────────────
    if (tables.has('ig_discovery_queue')) {
      console.log('↷ ig_discovery_queue table already exists');
    } else {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ig_discovery_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ig_username TEXT NOT NULL,
          source TEXT NOT NULL,
          added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          processed INTEGER DEFAULT 0 CHECK(processed IN (0, 1))
        );
      `);
      console.log('✓ ig_discovery_queue table created');
    }

    if (indexes.has('idx_ig_discovery_queue_username')) {
      console.log('↷ idx_ig_discovery_queue_username index already exists');
    } else {
      db.exec('CREATE INDEX IF NOT EXISTS idx_ig_discovery_queue_username ON ig_discovery_queue(ig_username);');
      console.log('✓ idx_ig_discovery_queue_username index created');
    }

    // ── 7. Default Settings ──────────────────────────────────────────────────
    const defaultSettings = [
      { key: 'warmup_min_follow_to_story_hours', value: '24' },
      { key: 'warmup_max_follow_to_story_hours', value: '48' },
      { key: 'warmup_min_story_to_like_hours', value: '12' },
      { key: 'warmup_max_story_to_like_hours', value: '24' },
      { key: 'warmup_min_like_to_dm_hours', value: '24' },
      { key: 'warmup_max_like_to_dm_hours', value: '48' },
      { key: 'fast_warmup_enabled', value: '0' },
      { key: 'auto_warmup_on_qualify', value: '1' },
      { key: 'unfollow_after_days', value: '30' },
      { key: 'unfollow_pending_after_days', value: '14' },
      { key: 'max_following_ratio', value: '1.5' },
      { key: 'discovery_max_per_hashtag', value: '30' },
      { key: 'discovery_min_followers', value: '100' },
      { key: 'discovery_max_followers', value: '100000' },
      { key: 'ig_blocked_until', value: null },
      { key: 'ig_selector_version', value: '1' }
    ];

    const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const setting of defaultSettings) {
      insertSetting.run(setting.key, setting.value);
    }
    console.log('✓ Default Instagram settings populated');
  });

  try {
    migration();
    console.log('[MIGRATE] Instagram database migration successfully completed!');
  } catch (err) {
    console.error('[MIGRATE] Instagram database migration failed:', err);
    process.exit(1);
  }
}

migrateInstagram();
