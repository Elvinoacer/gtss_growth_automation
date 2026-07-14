/**
 * Settings Routes — Pipeline Settings
 *
 * Express handlers for reading and updating the outreach pipeline's
 * runtime configuration (per-stage mode, qualification threshold, cron,
 * outreach platforms, per-run DM/connection caps, per-platform outreach
 * mode):
 *   GET   /pipeline  — Read every pipeline setting (settings table + pipeline_schedules.limits_json + process.env fallbacks)
 *   PATCH /pipeline  — Update one or more pipeline settings (writes both .env via upsertEnvValue and the settings table; updates pipeline_schedules row for outreach-platform + per-run caps + cron)
 *
 * Cross-file dependencies: ../../db/database (getDb), ../../utils/envWriter
 * (upsertEnvValue), ../../services/platformCatalog (getPlatformCatalog),
 * ../../config/pipelineConfig (qualificationThreshold, manualQualificationScore,
 * autoApproveVariant, pipelineCron), ./shared (upsertSetting).
 *
 * Extracted from the original routes/settings.js for maintainability.
 */

const { getDb } = require("../../db/database");
const { upsertEnvValue } = require("../../utils/envWriter");
const { getPlatformCatalog } = require("../../services/platformCatalog");
const pipelineConfig = require("../../config/pipelineConfig");
const { upsertSetting } = require("./shared");

/**
 * Register the pipeline settings routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerPipelineRoutes(router) {
  // ---------------------------------------------------------------------------
  // Pipeline settings
  // ---------------------------------------------------------------------------

  router.get("/pipeline", (req, res) => {
    const db = getDb();
    const getSettingValue = (key) =>
      db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
    const getPipelineLimit = (key, fallback) => {
      const row = db
        .prepare("SELECT limits_json FROM pipeline_schedules WHERE id = 'outreach'")
        .get();
      try {
        const limits = JSON.parse(row?.limits_json || "{}");
        return limits[key] !== undefined ? limits[key] : fallback;
      } catch (_) {
        return fallback;
      }
    };
    res.json({
      pipelineMode: getSettingValue("pipeline_mode") || process.env.PIPELINE_MODE || "ai",
      discoveryMode: getSettingValue("discovery_mode") || process.env.DISCOVERY_MODE || "",
      qualificationMode: getSettingValue("qualification_mode") || process.env.QUALIFICATION_MODE || "",
      messageMode: getSettingValue("message_mode") || process.env.MESSAGE_MODE || "",
      sendMode: getSettingValue("send_mode") || process.env.SEND_MODE || "",
      qualificationThreshold: pipelineConfig.qualificationThreshold(),
      qualificationManualScore: pipelineConfig.manualQualificationScore(),
      autoApproveVariant: pipelineConfig.autoApproveVariant(),
      pipelineCron: pipelineConfig.pipelineCron(),
      outreachPlatforms: getPipelineLimit("platforms", ["linkedin", "x"]),
      maxDmsPerRun: getPipelineLimit("max_dms_per_run", 20),
      maxConnectionsPerRun: getPipelineLimit("max_connections_per_run", 15),
      xOutreachMode:
        getSettingValue("x_outreach_mode") ||
        process.env.X_OUTREACH_MODE ||
        "follow_first",
      linkedinOutreachMode:
        getSettingValue("linkedin_outreach_mode") ||
        process.env.LINKEDIN_OUTREACH_MODE ||
        "connect_first",
    });
  });

  router.patch("/pipeline", (req, res) => {
    const fields = {
      pipelineMode: ["PIPELINE_MODE", "pipeline_mode"],
      discoveryMode: ["DISCOVERY_MODE", "discovery_mode"],
      qualificationMode: ["QUALIFICATION_MODE", "qualification_mode"],
      messageMode: ["MESSAGE_MODE", "message_mode"],
      sendMode: ["SEND_MODE", "send_mode"],
      qualificationThreshold: ["QUALIFICATION_THRESHOLD", "qualification_threshold"],
      qualificationManualScore: ["QUALIFICATION_MANUAL_SCORE", "qualification_manual_score"],
      autoApproveVariant: ["MESSAGE_AUTO_APPROVE_VARIANT", "message_auto_approve_variant"],
      pipelineCron: ["PIPELINE_CRON", "pipeline_cron"],
      xOutreachMode: ["X_OUTREACH_MODE", "x_outreach_mode"],
      linkedinOutreachMode: ["LINKEDIN_OUTREACH_MODE", "linkedin_outreach_mode"],
    };

    const updated = [];
    const db = getDb();

    for (const [bodyKey, [envKey, settingKey]] of Object.entries(fields)) {
      if (req.body[bodyKey] !== undefined) {
        const value = String(req.body[bodyKey]).trim();
        upsertEnvValue(envKey, value);
        process.env[envKey] = value;
        upsertSetting(settingKey, value);

        updated.push(bodyKey);
      }
    }

    const row = db
      .prepare("SELECT limits_json FROM pipeline_schedules WHERE id = 'outreach'")
      .get();
    let limits = {};
    try {
      limits = JSON.parse(row?.limits_json || "{}");
    } catch (_) {}

    if (Array.isArray(req.body.outreachPlatforms)) {
      const valid = new Set(getPlatformCatalog().keys);
      limits.platforms = req.body.outreachPlatforms
        .map((platform) => String(platform).trim().toLowerCase())
        .filter((platform) => valid.has(platform));
      if (limits.platforms.length === 0) {
        return res.status(400).json({ error: "Select at least one outreach platform" });
      }
      updated.push("outreachPlatforms");
    }
    if (req.body.maxDmsPerRun !== undefined) {
      limits.max_dms_per_run = Math.max(1, Math.floor(Number(req.body.maxDmsPerRun) || 1));
      updated.push("maxDmsPerRun");
    }
    if (req.body.maxConnectionsPerRun !== undefined) {
      limits.max_connections_per_run = Math.max(1, Math.floor(Number(req.body.maxConnectionsPerRun) || 1));
      updated.push("maxConnectionsPerRun");
    }
    if (updated.some((key) => ["outreachPlatforms", "maxDmsPerRun", "maxConnectionsPerRun"].includes(key))) {
      db.prepare(
        `UPDATE pipeline_schedules
         SET limits_json = ?, cron = COALESCE(NULLIF(?, ''), cron), updated_at = CURRENT_TIMESTAMP
         WHERE id = 'outreach'`,
      ).run(JSON.stringify(limits), req.body.pipelineCron ? String(req.body.pipelineCron).trim() : "");
    }

    if (updated.length === 0) {
      return res.status(400).json({ error: "No pipeline settings provided" });
    }

    return res.json({ success: true, updated });
  });
}

module.exports = { registerPipelineRoutes };
