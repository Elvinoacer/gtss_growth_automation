/**
 * Automation Routes — Daily Limits
 *
 * Express handlers for reading and updating per-platform daily automation
 * limits (stored in the `settings` table under key `daily_limits`):
 *   GET   /api/automation/limits  — Read today's used count + configured limit per platform
 *   PATCH /api/automation/limits  — Update one or more per-platform action limits (validated 1-1000)
 *
 * Cross-file dependencies: ../../db/database (getDb, getDailyLimits),
 * ../../services/platformCatalog (getPlatformKeys), ../../services/socketService
 * (broadcast).
 *
 * Extracted from the original routes/automation.js for maintainability.
 */

const { getDb, getDailyLimits } = require("../../db/database");
const { getPlatformKeys } = require("../../services/platformCatalog");
const { broadcast } = require("../../services/socketService");

/**
 * Register the daily-limits routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerLimitsRoutes(router) {
  // Get limits and current usage
  router.get("/api/automation/limits", (req, res) => {
    const db = getDb();
    // Only count successful actions toward "used" — same filter as
    // getDailyActionCount / isWithinLimit (premium_required etc. do not burn budget).
    const rows = db
      .prepare(
        `
      SELECT platform, action_type, COUNT(*) AS used
      FROM daily_actions
      WHERE DATE(performed_at) = DATE('now', 'localtime')
        AND lower(coalesce(outcome, '')) = 'sent'
      GROUP BY platform, action_type
    `,
      )
      .all();

    const dailyLimits = getDailyLimits();
    const data = {};

    getPlatformKeys().forEach((platform) => {
      let totalUsed = 0;
      let totalLimit = 0;

      Object.entries(dailyLimits[platform] || {}).forEach(([action, limit]) => {
        const row = rows.find(
          (r) => r.platform === platform && r.action_type === action,
        );
        totalUsed += row ? row.used : 0;
        totalLimit += Number(limit || 0);
      });

      data[platform] = {
        used: totalUsed,
        limit: totalLimit,
        dmsLimit: Number(dailyLimits[platform]?.dms || 0),
        limits: dailyLimits[platform] || {},
      };
    });

    res.json(data);
  });

  // Update daily automation limits in the shared settings.daily_limits store.
  router.patch("/api/automation/limits", (req, res) => {
    try {
      const db = getDb();
      const currentLimits = getDailyLimits();
      const updates = req.body || {};

      Object.entries(updates).forEach(([platform, fields]) => {
        const normalizedPlatform = String(platform || "").trim().toLowerCase();
        if (!normalizedPlatform || !fields || typeof fields !== "object" || Array.isArray(fields)) return;

        if (!currentLimits[normalizedPlatform] || typeof currentLimits[normalizedPlatform] !== "object") {
          currentLimits[normalizedPlatform] = {};
        }

        Object.entries(fields).forEach(([actionType, rawValue]) => {
          if (rawValue && typeof rawValue === "object") return;
          const value = Math.floor(Number(rawValue));
          if (!Number.isInteger(value) || value < 1 || value > 1000) {
            throw new Error(`${normalizedPlatform}.${actionType} must be an integer between 1 and 1000`);
          }
          currentLimits[normalizedPlatform][actionType] = value;
        });
      });

      db.prepare(
        `INSERT INTO settings (key, value)
         VALUES ('daily_limits', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(JSON.stringify(currentLimits));

      broadcast('automation:refresh', { type: 'limits-updated' });
      res.json({ success: true, limits: currentLimits });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
}

module.exports = { registerLimitsRoutes };
