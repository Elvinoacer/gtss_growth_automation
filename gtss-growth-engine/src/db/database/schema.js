/**
 * schema.js — Schema initialization orchestrator.
 *
 * This is the function that `openDatabase` (in connection.js) calls right
 * after opening the better-sqlite3 handle, and that `initializeDatabase`
 * (in postInit.js) calls again at server boot for safety. It loads the
 * canonical schema.sql and then runs every safe migration block (each as
 * an idempotent try/catch) before seeding the default settings & pipeline
 * schedules.
 *
 * The actual migration blocks live in migrations/*.js — each block runs in
 * the same order as the original database.js so existing databases upgrade
 * identically. Order matters: e.g. tableExtensions runs AFTER instagramSchema
 * so the IG tables exist before their column migrations run.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const { runEarlyMigrations } = require("./migrations/earlyMigrations");
const { runInstagramSchemaMigrations } = require("./migrations/instagramSchema");
const { runTableExtensionMigrations } = require("./migrations/tableExtensions");
const { runAssetTelemetryMigrations } = require("./migrations/assetTelemetryMigrations");
const { runCampaignMigrations } = require("./migrations/campaignMigrations");
const { runPipelineMigrations } = require("./migrations/pipelineMigrations");
const { seedDefaultSettings, seedDefaultPipelineSchedules } = require("./seeds");

function initializeSchema(database) {
  const schemaPath = path.join(__dirname, "..", "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  database.exec(schema);

  runEarlyMigrations(database);
  runInstagramSchemaMigrations(database);
  runTableExtensionMigrations(database);
  runAssetTelemetryMigrations(database);
  runCampaignMigrations(database);
  runPipelineMigrations(database);

  seedDefaultSettings(database);
  seedDefaultPipelineSchedules(database);
}

module.exports = {
  initializeSchema,
};
