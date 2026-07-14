/**
 * campaignMigrations.js — Campaign / connection-job / DM-job / event schema.
 *
 * Creates the campaigns, connection_jobs, dm_jobs, campaign_events tables and
 * their indexes. Then performs column-backfill migrations on each of those
 * tables (created_at / updated_at / scheduled_at) using PRAGMA table_info so
 * missing columns are added without failing when they already exist. Finally
 * extends daily_actions with `campaign_id` + `reason` columns and creates the
 * campaign_id index.
 *
 * Every block is wrapped in `try { ... } catch (_) {}` so existing databases
 * that already have these tables / columns simply no-op — identical to the
 * original monolithic database.js behaviour.
 */
"use strict";

function runCampaignMigrations(database) {
  // ── Campaign schema initialization ────────────────────────────────────
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        status TEXT DEFAULT 'draft',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

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

      CREATE TABLE IF NOT EXISTS campaign_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        details_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_connection_jobs_campaign_id ON connection_jobs(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_connection_jobs_lead_id ON connection_jobs(lead_id);
      CREATE INDEX IF NOT EXISTS idx_dm_jobs_campaign_id ON dm_jobs(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_dm_jobs_lead_id ON dm_jobs(lead_id);
      CREATE INDEX IF NOT EXISTS idx_dm_jobs_message_id ON dm_jobs(message_id);
      CREATE INDEX IF NOT EXISTS idx_campaign_events_campaign_id ON campaign_events(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_campaign_events_lead_id ON campaign_events(lead_id);
    `);
  } catch (_) {}

  // ── campaigns column backfill ─────────────────────────────────────────
  try {
    const cols = database
      .prepare("PRAGMA table_info(campaigns)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("name")) {
      database.exec("ALTER TABLE campaigns ADD COLUMN name TEXT");
    }
    if (!cols.includes("platform")) {
      database.exec("ALTER TABLE campaigns ADD COLUMN platform TEXT");
    }
    if (!cols.includes("created_at")) {
      database.exec("ALTER TABLE campaigns ADD COLUMN created_at DATETIME");
    }
    if (!cols.includes("updated_at")) {
      database.exec("ALTER TABLE campaigns ADD COLUMN updated_at DATETIME");
    }
    database.exec(`
      UPDATE campaigns
      SET name = COALESCE(NULLIF(name, ''), 'Untitled Campaign ' || id),
          platform = COALESCE(NULLIF(platform, ''), 'linkedin'),
          created_at = COALESCE(created_at, CURRENT_TIMESTAMP),
          updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)
    `);
  } catch (_) {}

  // ── connection_jobs column backfill ───────────────────────────────────
  try {
    const cols = database
      .prepare("PRAGMA table_info(connection_jobs)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("created_at")) {
      database.exec("ALTER TABLE connection_jobs ADD COLUMN created_at DATETIME");
    }
    if (!cols.includes("updated_at")) {
      database.exec("ALTER TABLE connection_jobs ADD COLUMN updated_at DATETIME");
    }
    database.exec(`
      UPDATE connection_jobs
      SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP),
          updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)
    `);
  } catch (_) {}

  // ── dm_jobs column backfill ───────────────────────────────────────────
  try {
    const cols = database
      .prepare("PRAGMA table_info(dm_jobs)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("scheduled_at")) {
      database.exec("ALTER TABLE dm_jobs ADD COLUMN scheduled_at DATETIME");
    }
    if (!cols.includes("created_at")) {
      database.exec("ALTER TABLE dm_jobs ADD COLUMN created_at DATETIME");
    }
    if (!cols.includes("updated_at")) {
      database.exec("ALTER TABLE dm_jobs ADD COLUMN updated_at DATETIME");
    }
    database.exec(`
      UPDATE dm_jobs
      SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP),
          updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)
    `);
  } catch (_) {}

  // ── campaign_events column backfill ───────────────────────────────────
  try {
    const cols = database
      .prepare("PRAGMA table_info(campaign_events)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("created_at")) {
      database.exec("ALTER TABLE campaign_events ADD COLUMN created_at DATETIME");
    }
    database.exec(`
      UPDATE campaign_events
      SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP)
    `);
  } catch (_) {}

  // ── daily_actions column additions + index ───────────────────────────
  try {
    const cols = database
      .prepare("PRAGMA table_info(daily_actions)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("campaign_id")) {
      database.exec(
        "ALTER TABLE daily_actions ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id)",
      );
    }
    if (!cols.includes("reason")) {
      database.exec("ALTER TABLE daily_actions ADD COLUMN reason TEXT");
    }
  } catch (_) {}

  try {
    database.exec(
      "CREATE INDEX IF NOT EXISTS idx_daily_actions_campaign_id ON daily_actions(campaign_id)",
    );
  } catch (_) {}
}

module.exports = {
  runCampaignMigrations,
};
