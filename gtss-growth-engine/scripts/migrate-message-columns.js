const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.resolve(process.env.DB_PATH || "./data/gtss.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const table = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
  )
  .get();

if (!table) {
  console.error(
    "The messages table does not exist yet. Start the app once so schema.sql is applied, then rerun this migration.",
  );
  process.exit(1);
}

const columns = new Set(
  db.pragma("table_info(messages)").map((column) => column.name),
);

if (!columns.has("snooze_until")) {
  db.exec("ALTER TABLE messages ADD COLUMN snooze_until DATETIME");
  console.log("Added messages.snooze_until");
}

if (!columns.has("retry_count")) {
  db.exec("ALTER TABLE messages ADD COLUMN retry_count INTEGER DEFAULT 0");
  console.log("Added messages.retry_count");
}

if (!columns.has("last_error")) {
  db.exec("ALTER TABLE messages ADD COLUMN last_error TEXT");
  console.log("Added messages.last_error");
}

if (!columns.has("blocked_reason")) {
  db.exec("ALTER TABLE messages ADD COLUMN blocked_reason TEXT");
  console.log("Added messages.blocked_reason");
}

if (!columns.has("fail_category")) {
  db.exec("ALTER TABLE messages ADD COLUMN fail_category TEXT");
  console.log("Added messages.fail_category");
}

console.log("Message-column migration complete.");
db.close();
