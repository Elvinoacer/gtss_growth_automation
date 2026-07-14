/**
 * Settings Routes — Shared Helpers & Constants
 *
 * Common utilities used by every settings route split file:
 *   - `sensitiveKeys` Set and `apiKeyPatterns` regex list — drive the
 *     secret-masking logic for GET /.
 *   - `packageJson` reference (used to surface appVersion on GET /).
 *   - Settings-table CRUD helpers: `upsertSetting`, `getRawSetting`.
 *   - Domain readers: `getStoredLimits`, `getTemplates`.
 *   - Secret helpers: `shouldMask`, `maskSecret`, `parseSettingValue`.
 *   - Limit-merge helpers: `mergeDailyLimitUpdates`, `validateLimits`.
 *   - `clone` (deep-clone via JSON round-trip).
 *
 * Cross-file dependencies: ../../db/database (getDb, initializeDatabase —
 * initializeDatabase is only consumed by dataRoutes.js, not here),
 * ../../config/templates.json (defaultTemplates), ../../config/limits
 * (defaultLimits), ../../services/platformCatalog (getPlatformCatalog),
 * ../../../package.json (appVersion).
 *
 * NOTE: this file lives at src/routes/settings/shared.js, so __dirname is
 * src/routes/settings — three levels below the project root. The original
 * file lived at src/routes/settings.js (two levels below root), so every
 * `../X` becomes `../../X` and `../../package.json` becomes
 * `../../../package.json`.
 *
 * Extracted from the original routes/settings.js for maintainability.
 */

const { getDb } = require("../../db/database");
const defaultTemplates = require("../../config/templates.json");
const defaultLimits = require("../../config/limits");
const { getPlatformCatalog } = require("../../services/platformCatalog");
const packageJson = require("../../../package.json");

const sensitiveKeys = new Set(["PASSPHRASE_HASH", "passphrase_hash"]);
const apiKeyPatterns = [/api_key/i, /app_password/i, /password/i];

function upsertSetting(key, value) {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

function getRawSetting(key) {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key);
  return row ? row.value : null;
}

function getStoredLimits() {
  const value = getRawSetting("daily_limits");
  if (!value) {
    return clone(defaultLimits);
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return clone(defaultLimits);
  }
}

function getTemplates() {
  const templates = { ...defaultTemplates };
  const rows = getDb()
    .prepare("SELECT key, value FROM settings WHERE key LIKE 'template_%'")
    .all();

  rows.forEach((row) => {
    templates[row.key.replace("template_", "")] = row.value;
  });

  return templates;
}

function shouldMask(key) {
  return apiKeyPatterns.some((pattern) => pattern.test(key));
}

function maskSecret(value) {
  if (!value) {
    return "";
  }

  if (value.length <= 6) {
    return `${value.slice(0, 1)}...${value.slice(-1)}`;
  }

  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

function parseSettingValue(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return value;
  }
}

function mergeDailyLimitUpdates(currentLimits, updates) {
  const merged = clone(currentLimits || {});

  Object.entries(updates || {}).forEach(([platform, fields]) => {
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) return;
    if (!merged[platform] || typeof merged[platform] !== "object") {
      merged[platform] = {};
    }

    Object.entries(fields).forEach(([field, value]) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (!merged[platform][field] || typeof merged[platform][field] !== "object") {
          merged[platform][field] = {};
        }
        Object.entries(value).forEach(([nestedField, nestedValue]) => {
          if (nestedValue && typeof nestedValue === "object") return;
          merged[platform][field][nestedField] = nestedValue;
        });
        return;
      }
      if (String(field).includes(".")) {
        const [group, nestedField] = String(field).split(".", 2);
        if (!group || !nestedField) return;
        if (!merged[platform][group] || typeof merged[platform][group] !== "object") {
          merged[platform][group] = {};
        }
        merged[platform][group][nestedField] = value;
        return;
      }
      if (value && typeof value === "object") return;
      merged[platform][field] = value;
    });
  });

  return merged;
}

function validateLimits(nextLimits) {
  const expectedPlatforms = getPlatformCatalog().keys;

  for (const platform of expectedPlatforms) {
    if (!nextLimits[platform]) {
      return `Missing limits for ${platform}`;
    }
  }

  for (const [platform, fields] of Object.entries(nextLimits)) {
    if (!expectedPlatforms.includes(platform)) {
      return `Unexpected limits for ${platform}`;
    }

    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      return `Missing limits for ${platform}`;
    }

    for (const [field, rawValue] of Object.entries(fields)) {
      if (rawValue && typeof rawValue === "object") {
        if (Array.isArray(rawValue)) {
          return `${platform}.${field} must be an object`;
        }
        for (const [nestedField, nestedRawValue] of Object.entries(rawValue)) {
          const nestedValue = Number(nestedRawValue);
          if (!Number.isInteger(nestedValue) || nestedValue < 1 || nestedValue > 1000) {
            return `${platform}.${field}.${nestedField} must be an integer between 1 and 1000`;
          }
          nextLimits[platform][field][nestedField] = nestedValue;
        }
        continue;
      }
      const value = Number(rawValue);
      if (!Number.isInteger(value) || value < 1 || value > 1000) {
        return `${platform}.${field} must be an integer between 1 and 1000`;
      }
      nextLimits[platform][field] = value;
    }
  }

  return null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  sensitiveKeys,
  apiKeyPatterns,
  packageJson,
  upsertSetting,
  getRawSetting,
  getStoredLimits,
  getTemplates,
  shouldMask,
  maskSecret,
  parseSettingValue,
  mergeDailyLimitUpdates,
  validateLimits,
  clone,
};
