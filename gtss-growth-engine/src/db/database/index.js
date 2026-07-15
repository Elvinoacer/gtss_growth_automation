/**
 * index.js — re-exports the database module surface.
 *
 * This file preserves the exact same module.exports shape as the original
 * database.js monolith so that every caller (which uses require("../db/database")
 * or require("./db/database")) continues to work without any changes.
 *
 * Exports (the original 8-key surface):
 *   db                       - the shared better-sqlite3 Database singleton
 *   getDb()                  - accessor that returns the same singleton
 *   initializeDatabase()     - server-boot re-init (re-runs schema + post-init)
 *   getDailyActionCount(platform, actionType)
 *   getDailyLimits()
 *   isWithinLimit(platform, actionType)
 *   normalizeActionType(actionType)
 *   increment_action_count(platform, actionType, leadId, outcome, reason)
 *   outcomeCountsTowardLimit(outcome)
 *   LIMIT_COUNTING_OUTCOMES
 */
"use strict";

const { db, getDb } = require("./connection");
const { initializeDatabase } = require("./postInit");
const {
  getDailyActionCount,
  getDailyLimits,
  isWithinLimit,
  normalizeActionType,
  increment_action_count,
  outcomeCountsTowardLimit,
  LIMIT_COUNTING_OUTCOMES,
} = require("./queries");

module.exports = {
  db,
  getDb,
  initializeDatabase,
  getDailyActionCount,
  getDailyLimits,
  isWithinLimit,
  normalizeActionType,
  increment_action_count,
  outcomeCountsTowardLimit,
  LIMIT_COUNTING_OUTCOMES,
};
