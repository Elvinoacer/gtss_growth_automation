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
    return false;
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
