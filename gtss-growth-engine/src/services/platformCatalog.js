const { getDb, getDailyLimits } = require("../db/database");

const PLATFORM_TABLES = [
  "leads",
  "messages",
  "daily_actions",
  "platform_sessions",
  "automation_events",
  "action_fingerprints",
];
const PLATFORM_JSON_TABLES = ["posts", "discovery_runs"];

function normalizePlatformKey(platform) {
  return String(platform || "")
    .trim()
    .toLowerCase();
}

function formatPlatformLabel(platform) {
  const key = normalizePlatformKey(platform);
  if (!key) return "";
  if (key === "x") return "X";
  if (key === "linkedin") return "LinkedIn";
  if (key === "instagram") return "Instagram";
  if (key === "facebook") return "Facebook";

  return key
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getPlatformCatalog() {
  const db = getDb();
  const discovered = new Set();
  const orderedKeys = [];

  const addKey = (value) => {
    const key = normalizePlatformKey(value);
    if (!key || discovered.has(key)) return;
    discovered.add(key);
    orderedKeys.push(key);
  };

  const storedLimits = getDailyLimits();
  Object.keys(storedLimits).forEach(addKey);

  PLATFORM_TABLES.forEach((table) => {
    try {
      const rows = db
        .prepare(
          `SELECT DISTINCT platform AS value
           FROM ${table}
           WHERE platform IS NOT NULL AND TRIM(platform) != ''`,
        )
        .all();
      rows.forEach((row) => addKey(row.value));
    } catch (_) {
      // Table may not be present in older databases; ignore and continue.
    }
  });

  PLATFORM_JSON_TABLES.forEach((table) => {
    try {
      const rows = db
        .prepare(
          `SELECT platforms
           FROM ${table}
           WHERE platforms IS NOT NULL AND TRIM(platforms) != ''`,
        )
        .all();

      rows.forEach((row) => {
        if (!row || !row.platforms) return;
        try {
          const parsed = JSON.parse(row.platforms);
          if (Array.isArray(parsed)) {
            parsed.forEach((platform) => addKey(platform));
          }
        } catch (_) {
          // Ignore malformed JSON and keep the rest of the catalog intact.
        }
      });
    } catch (_) {
      // Ignore missing tables in older databases.
    }
  });

  const catalogKeys = orderedKeys.slice();
  if (catalogKeys.length === 0) {
    Object.keys(storedLimits).forEach(addKey);
  }

  const entries = orderedKeys.map((key) => ({
    key,
    label: formatPlatformLabel(key),
  }));
  const labels = Object.fromEntries(
    entries.map((entry) => [entry.key, entry.label]),
  );

  return {
    keys: orderedKeys,
    entries,
    labels,
    limits: storedLimits,
  };
}

function getPlatformKeys() {
  return getPlatformCatalog().keys;
}

function getPlatformEntries() {
  return getPlatformCatalog().entries;
}

function getPlatformLabels() {
  return getPlatformCatalog().labels;
}

function getPrimaryPlatform() {
  return getPlatformKeys()[0] || "linkedin";
}

function isKnownPlatform(platform) {
  return getPlatformKeys().includes(normalizePlatformKey(platform));
}

function getLimitFields() {
  const catalog = getPlatformCatalog();
  const fields = [];
  const seen = new Set();

  catalog.keys.forEach((platform) => {
    const platformLimits = catalog.limits[platform] || {};
    Object.entries(platformLimits).forEach(([field, value]) => {
      if (seen.has(field) || typeof value !== "number") return;
      seen.add(field);
      fields.push(field);
    });
  });

  return fields;
}

module.exports = {
  formatPlatformLabel,
  getLimitFields,
  getPlatformCatalog,
  getPlatformEntries,
  getPlatformKeys,
  getPlatformLabels,
  getPrimaryPlatform,
  isKnownPlatform,
  normalizePlatformKey,
};
