/**
 * Settings Routes — General Settings + Limits + Notifications
 *
 * Express handlers for the top-level settings payload (everything that
 * isn't a credential, template, pipeline, or data-destructive action):
 *   GET   /              — Read every setting row (with secrets masked) + limits + platform catalog + appVersion
 *   PATCH /limits        — Merge per-platform daily limit updates (validated 1-1000)
 *   PATCH /notifications — Update the four notification-toggle booleans
 *   PATCH /              — Update allow-listed general settings (content_asset_source, retry_*, message_generation_source, etc.)
 *
 * Cross-file dependencies: ../../db/database (getDb), ../../services/platformCatalog
 * (getPlatformCatalog, getLimitFields), ./shared (sensitiveKeys, packageJson,
 * upsertSetting, getStoredLimits, shouldMask, maskSecret, parseSettingValue,
 * mergeDailyLimitUpdates, validateLimits, clone).
 *
 * Extracted from the original routes/settings.js for maintainability.
 */

const { getDb } = require("../../db/database");
const {
  getPlatformCatalog,
  getLimitFields,
} = require("../../services/platformCatalog");
const {
  sensitiveKeys,
  packageJson,
  upsertSetting,
  getStoredLimits,
  shouldMask,
  maskSecret,
  parseSettingValue,
  mergeDailyLimitUpdates,
  validateLimits,
  clone,
} = require("./shared");

/**
 * Register the general settings + limits + notifications routes on the
 * given router (the apiRouter from index.js).
 *
 * @param {import('express').Router} router
 */
function registerGeneralRoutes(router) {
  router.get("/", (req, res) => {
    const catalog = getPlatformCatalog();
    const rows = getDb()
      .prepare("SELECT key, value FROM settings ORDER BY key")
      .all();
    const settings = {};

    rows.forEach((row) => {
      if (sensitiveKeys.has(row.key)) {
        return;
      }

      settings[row.key] = shouldMask(row.key)
        ? maskSecret(row.value)
        : parseSettingValue(row.value);
    });

    settings.limits = getStoredLimits();
    settings.loadedLimits = clone(settings.limits);
    settings.platforms = catalog.entries;
    settings.platformKeys = catalog.keys;
    settings.platformLabels = catalog.labels;
    settings.limitFields = getLimitFields();
    settings.appVersion = packageJson.version;

    res.json(settings);
  });

  router.patch("/limits", (req, res) => {
    const currentLimits = getStoredLimits();
    const nextLimits = mergeDailyLimitUpdates(currentLimits, req.body || {});
    const validationError = validateLimits(nextLimits);

    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    upsertSetting("daily_limits", JSON.stringify(nextLimits));

    return res.json({ success: true, limits: nextLimits });
  });

  router.patch("/notifications", (req, res) => {
    const notifications = {
      lead_replies: Boolean(req.body.lead_replies),
      session_expired: Boolean(req.body.session_expired),
      daily_limit_reached: Boolean(req.body.daily_limit_reached),
      automation_errors: Boolean(req.body.automation_errors),
    };

    upsertSetting("notification_settings", JSON.stringify(notifications));
    return res.json({ success: true });
  });

  router.patch("/", (req, res) => {
    const allowed = new Set([
      "content_asset_source",
      "content_library_media_type",
      "retry_max_attempts",
      "retry_delay_preset",
      // Per-user choice of AI vs template for outreach DM generation.
      // 'ai' = use Gemini (API key first, Gemini Web fallback) — default.
      // 'template' = use canonical templates from Settings (manual control).
      "message_generation_source",
    ]);
    const updates = req.body || {};
    Object.entries(updates).forEach(([key, value]) => {
      if (allowed.has(key)) {
        upsertSetting(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    });
    res.json({ success: true });
  });
}

module.exports = { registerGeneralRoutes };
