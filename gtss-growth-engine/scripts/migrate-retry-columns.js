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
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'posts'",
  )
  .get();

if (!table) {
  console.error(
    "The posts table does not exist yet. Start the app once so schema.sql is applied, then rerun this migration.",
  );
  process.exit(1);
}

const columns = new Set(
  db.pragma("table_info(posts)").map((column) => column.name),
);

if (!columns.has("retry_count")) {
  db.exec(
    "ALTER TABLE posts ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
  );
  console.log("Added posts.retry_count");
}

if (!columns.has("next_retry_at")) {
  db.exec("ALTER TABLE posts ADD COLUMN next_retry_at TEXT");
  console.log("Added posts.next_retry_at");
}

if (!columns.has("last_error")) {
  db.exec("ALTER TABLE posts ADD COLUMN last_error TEXT");
  console.log("Added posts.last_error");
}

console.log("Retry-column migration complete.");
db.close();
