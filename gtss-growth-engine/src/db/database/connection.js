/**
 * connection.js — Database connection management.
 *
 * Owns:
 *   - Resolving the DB file path (env DB_PATH or ./data/gtss.db)
 *   - Opening the better-sqlite3 connection with WAL + foreign_keys pragmas
 *   - Initializing the schema on first open
 *   - The module-level `db` singleton (one connection per process)
 *   - getDb() accessor used by every other split file in this directory
 *
 * Every other file in database/ imports `db` / `getDb` from this module — that
 * way there is exactly one better-sqlite3 instance per process, just like the
 * original monolithic database.js guaranteed.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { initializeSchema } = require("./schema");

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

const db = openDatabase();

function getDb() {
  return db;
}

module.exports = {
  db,
  getDb,
  openDatabase,
  resolveDbPath,
};
