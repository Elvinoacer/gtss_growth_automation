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

// ─── Built-in platforms ──────────────────────────────────────────────────
//
// These are ALWAYS recognized by isKnownPlatform() / getPlatformKeys() even
// before any DB row or daily-limit entry exists for them. This matters for
// the very first login: when the user clicks "Login / Re-authenticate" on
// the dashboard's sign-in modal for Google / Gemini, the API route
// /api/sessions/authenticate/:platform validates the platform key against
// getPlatformKeys(). Before any session has ever been saved, the catalog
// only contained platforms discovered from the DB — so `google` and
// `gemini` were rejected with "Unknown platform", blocking the very first
// Gemini login. The built-in list below guarantees every platform the
// automation layer can drive is accepted from day one.
const BUILT_IN_PLATFORMS = [
  "linkedin",
  "x",
  "facebook",
  "instagram",
  "tiktok",
  "google",
  "gemini",
];

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
  if (key === "tiktok") return "TikTok";
  if (key === "google") return "Google / Gemini";
  if (key === "gemini") return "Gemini";

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

  // Seed with the built-in platforms FIRST so the catalog always contains
  // every platform the automation layer can drive — even on a fresh
  // database with zero rows. DB-discovered and limit-configured platforms
  // are appended afterwards (and deduplicated by the Set). This ordering
  // also keeps the sign-in modal's platform grid stable across runs
  // instead of reordering itself as DB rows accumulate.
  BUILT_IN_PLATFORMS.forEach(addKey);

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
  // BUILT_IN_PLATFORMS guarantees orderedKeys is never empty, so the
  // legacy "fall back to storedLimits" branch below is now dead code.
  // Kept as a defensive safety net in case BUILT_IN_PLATFORMS is ever
  // emptied by a future edit.
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
