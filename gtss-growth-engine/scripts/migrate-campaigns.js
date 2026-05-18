#!/usr/bin/env node

/**
 * Campaign Database Migration System
 *
 * Safe, transactional, idempotent database migration establishing:
 *   - campaigns
 *   - connection_jobs
 *   - dm_jobs
 *   - campaign_events
 *   - Safe daily_actions table schema update
 *   - Comprehensive foreign keys & indexes
 */

require('dotenv').config();
const { getDb } = require('../src/db/database');

function migrateCampaigns() {
  const db = getDb();

  console.log('[MIGRATE-CAMPAIGNS] Initiating campaign database migration...');

  // Wrap inside a single atomic transaction for database safety and rollback guarantees
  const runMigration = db.transaction(() => {
    // 1. Enable Foreign Key Constraints
    db.pragma("foreign_keys = ON");
    console.log('[MIGRATE-CAMPAIGNS] Enabled foreign_keys PRAGMA context.');

    // 2. Create campaigns Table
    db.exec(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        status TEXT DEFAULT 'draft',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[MIGRATE-CAMPAIGNS] ✓ Table "campaigns" is ready.');

    // 3. Create connection_jobs Table
    db.exec(`
      CREATE TABLE IF NOT EXISTS connection_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        status TEXT DEFAULT 'pending',
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(campaign_id, lead_id)
      );
    `);
    console.log('[MIGRATE-CAMPAIGNS] ✓ Table "connection_jobs" is ready.');

    // 4. Create dm_jobs Table
    db.exec(`
      CREATE TABLE IF NOT EXISTS dm_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        status TEXT DEFAULT 'pending',
        scheduled_at DATETIME,
        sent_at DATETIME,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(campaign_id, lead_id, message_id)
      );
    `);
    console.log('[MIGRATE-CAMPAIGNS] ✓ Table "dm_jobs" is ready.');

    // 5. Create campaign_events Table
    db.exec(`
      CREATE TABLE IF NOT EXISTS campaign_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        details_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[MIGRATE-CAMPAIGNS] ✓ Table "campaign_events" is ready.');

    // 6. Create Indexes
    console.log('[MIGRATE-CAMPAIGNS] Provisioning high-performance indexes...');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_connection_jobs_campaign_id ON connection_jobs(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_connection_jobs_lead_id ON connection_jobs(lead_id);
      CREATE INDEX IF NOT EXISTS idx_dm_jobs_campaign_id ON dm_jobs(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_dm_jobs_lead_id ON dm_jobs(lead_id);
      CREATE INDEX IF NOT EXISTS idx_dm_jobs_message_id ON dm_jobs(message_id);
      CREATE INDEX IF NOT EXISTS idx_campaign_events_campaign_id ON campaign_events(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_campaign_events_lead_id ON campaign_events(lead_id);
    `);
    console.log('[MIGRATE-CAMPAIGNS] ✓ All indexes created successfully.');

    // 7. Safely Augment daily_actions Table
    const columns = db.prepare("PRAGMA table_info(daily_actions)").all().map(c => c.name);
    if (!columns.includes("campaign_id")) {
      db.exec("ALTER TABLE daily_actions ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id)");
      console.log('[MIGRATE-CAMPAIGNS] ✓ Column "campaign_id" successfully added to "daily_actions".');
    } else {
      console.log('[MIGRATE-CAMPAIGNS] · Column "campaign_id" already exists in "daily_actions". Skipping alter.');
    }

    // 8. Create index on daily_actions(campaign_id)
    db.exec("CREATE INDEX IF NOT EXISTS idx_daily_actions_campaign_id ON daily_actions(campaign_id)");
    console.log('[MIGRATE-CAMPAIGNS] ✓ Index on "daily_actions(campaign_id)" is ready.');
  });

  try {
    runMigration();
    console.log('[MIGRATE-CAMPAIGNS] Campaign migration successfully committed.');
  } catch (err) {
    console.error('[MIGRATE-CAMPAIGNS] ❌ Critical: Migration failed and has been rolled back safely.', err);
    throw err;
  }
}

if (require.main === module) {
  migrateCampaigns();
}

module.exports = { migrateCampaigns };
