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
    database.exec('ALTER TABLE discovery_runs ADD COLUMN pipeline_run_id INTEGER REFERENCES pipeline_runs(id)');
  } catch (_) {}
  try {
    database.exec("ALTER TABLE messages ADD COLUMN generated_by TEXT DEFAULT 'ai'");
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
  const platformLimits = getDailyLimits()[platform] || {};
  const limit = platformLimits[normalizedActionType];

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
  };

  return aliases[actionType] || actionType;
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
};
