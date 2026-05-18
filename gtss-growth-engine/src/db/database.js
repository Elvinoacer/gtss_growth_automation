const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const limits = require("../config/limits");

function resolveDbPath() {
  return path.resolve(process.env.DB_PATH || "./data/gtss.db");
}

function openDatabase() {
  const dbPath = resolveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, {
    verbose: process.env.NODE_ENV === "development" ? console.log : undefined,
  });

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initializeSchema(db);

  return db;
}

function initializeSchema(database) {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  database.exec(schema);

  // Safe migrations for existing databases
  try {
    database.exec("ALTER TABLE messages ADD COLUMN snooze_until DATETIME");
  } catch (_) {
    /* column exists */
  }
  try {
    database.exec(
      "ALTER TABLE messages ADD COLUMN retry_count INTEGER DEFAULT 0",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE messages ADD COLUMN last_error TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE messages ADD COLUMN blocked_reason TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE messages ADD COLUMN fail_category TEXT");
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE posts ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE posts ADD COLUMN next_retry_at TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE posts ADD COLUMN last_error TEXT");
  } catch (_) {}
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS automation_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        started_at DATETIME,
        completed_at DATETIME,
        details_json TEXT
      );

      CREATE TABLE IF NOT EXISTS automation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT,
        platform TEXT,
        account TEXT,
        action_type TEXT,
        target TEXT,
        message_id INTEGER REFERENCES messages(id),
        lead_id INTEGER REFERENCES leads(id),
        status TEXT NOT NULL,
        warning_detected INTEGER DEFAULT 0,
        details_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS action_fingerprints (
        fingerprint TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        action_type TEXT NOT NULL,
        target TEXT NOT NULL,
        message_id INTEGER REFERENCES messages(id),
        lead_id INTEGER REFERENCES leads(id),
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch (_) {
    /* tables exist */
  }

  // Pipeline migrations
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
  } catch (_) { /* table exists */ }
  try {
    database.exec('ALTER TABLE leads ADD COLUMN pipeline_run_id INTEGER REFERENCES pipeline_runs(id)');
  } catch (_) {}
  try {
    database.exec('ALTER TABLE leads ADD COLUMN x_handle TEXT');
  } catch (_) {}
  try {
    database.exec('ALTER TABLE leads ADD COLUMN ig_username TEXT');
  } catch (_) {}
  try {
    database.exec('ALTER TABLE discovery_runs ADD COLUMN pipeline_run_id INTEGER REFERENCES pipeline_runs(id)');
  } catch (_) {}
  try {
    database.exec("ALTER TABLE messages ADD COLUMN generated_by TEXT DEFAULT 'ai'");
  } catch (_) {}

  // Instagram warmup safe migrations
  try {
    database.exec("ALTER TABLE ig_warmup_sequences ADD COLUMN next_step TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE ig_warmup_sequences ADD COLUMN next_step_after DATETIME");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE ig_warmup_sequences ADD COLUMN attempt_count INTEGER DEFAULT 0");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE ig_warmup_sequences ADD COLUMN completed_at DATETIME");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN ig_follow_back_at DATETIME");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE ig_follow_tracker ADD COLUMN eligible_for_unfollow INTEGER DEFAULT 1");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE ig_follow_tracker ADD COLUMN follow_status TEXT GENERATED ALWAYS AS (status)");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE messages ADD COLUMN action_type TEXT");
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
    database.exec("ALTER TABLE ig_follow_tracker ADD COLUMN follow_back_at DATETIME");
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
    database.exec("ALTER TABLE ig_follow_tracker ADD COLUMN follow_source TEXT");
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

  // Campaign schema initialization
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

  try {
    const cols = database.prepare("PRAGMA table_info(campaigns)").all().map(c => c.name);
    if (!cols.includes("platform")) {
      database.exec("ALTER TABLE campaigns ADD COLUMN platform TEXT");
    }
  } catch (_) {}

  try {
    const cols = database.prepare("PRAGMA table_info(daily_actions)").all().map(c => c.name);
    if (!cols.includes("campaign_id")) {
      database.exec("ALTER TABLE daily_actions ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id)");
    }
  } catch (_) {}

  try {
    database.exec("CREATE INDEX IF NOT EXISTS idx_daily_actions_campaign_id ON daily_actions(campaign_id)");
  } catch (_) {}

  seedDefaultSettings(database);
}

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
      .prepare("INSERT INTO settings (key, value) VALUES ('campaign_queue_lock', ?) ON CONFLICT(key) DO NOTHING")
      .run("false");
  }

  // Seed default outreach modes
  const xOutreachModeRow = database
    .prepare("SELECT value FROM settings WHERE key = 'x_outreach_mode'")
    .get();
  if (!xOutreachModeRow) {
    database
      .prepare("INSERT INTO settings (key, value) VALUES ('x_outreach_mode', ?) ON CONFLICT(key) DO NOTHING")
      .run("follow_first");
  }

  const linkedinOutreachModeRow = database
    .prepare("SELECT value FROM settings WHERE key = 'linkedin_outreach_mode'")
    .get();
  if (!linkedinOutreachModeRow) {
    database
      .prepare("INSERT INTO settings (key, value) VALUES ('linkedin_outreach_mode', ?) ON CONFLICT(key) DO NOTHING")
      .run("connect_first");
  }
}

const db = openDatabase();

function getDailyActionCount(platform, actionType) {
  const normalizedActionType = normalizeActionType(actionType);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM daily_actions
       WHERE platform = ?
         AND action_type = ?
         AND DATE(performed_at) = DATE('now', 'localtime')`,
    )
    .get(platform, normalizedActionType);

  return row.count;
}

function isWithinLimit(platform, actionType) {
  const normalizedActionType = normalizeActionType(actionType);
  
  let limit;
  // First, check limits.js config (especially for Instagram as requested)
  if (limits[platform] && typeof limits[platform][normalizedActionType] === "number") {
    limit = limits[platform][normalizedActionType];
  } else {
    // Fall back to database settings limits
    const platformLimits = getDailyLimits()[platform] || {};
    limit = platformLimits[normalizedActionType];
  }

  if (typeof limit !== "number") {
    // Emit a visible warning; use a conservative default of 5 instead of blocking
    console.warn(
      `[LIMITS] No limit configured for ${platform}.${normalizedActionType} — defaulting to 5`,
    );
    return getDailyActionCount(platform, normalizedActionType) < 5;
  }

  return getDailyActionCount(platform, normalizedActionType) < limit;
}

function getDailyLimits() {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'daily_limits'")
    .get();

  if (!row || !row.value) {
    return {};
  }

  try {
    return JSON.parse(row.value);
  } catch (_) {
    return {};
  }
}

function normalizeActionType(actionType) {
  const aliases = {
    connect: "connections",
    connection: "connections",
    dm: "dms",
    direct_message: "dms",
    follow: "follows",
    like: "likes",
    instagram_dm: "dms",
    instagram_follow: "follows",
    instagram_like: "likes",
  };

  return aliases[actionType] || actionType;
}

function increment_action_count(platform, actionType, leadId = null, outcome = "sent") {
  const normalizedActionType = normalizeActionType(actionType);
  const insert = db.prepare(
    `INSERT INTO daily_actions (platform, action_type, lead_id, outcome, performed_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
  );
  insert.run(platform, normalizedActionType, leadId, outcome);
}

function getDb() {
  return db;
}

function initializeDatabase() {
  initializeSchema(db);
}

module.exports = {
  db,
  getDb,
  initializeDatabase,
  getDailyActionCount,
  getDailyLimits,
  isWithinLimit,
  normalizeActionType,
  increment_action_count,
};
