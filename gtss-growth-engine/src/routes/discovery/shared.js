/**
 * Discovery Routes — Shared Helpers
 *
 * Common utilities used by multiple discovery route split files:
 *   - Lead-list helpers: `sanitizeLeadIds`, `updateLeadStatuses`.
 *   - JSON-array parser: `parseJsonArray` (defensive — always returns an array).
 *   - Keywords-config file helpers: `resolveKeywordsPath`, `readKeywordsFile`,
 *     `writeKeywordsFile`, `normalizeKeywordEntry`, `keywordIdentity`.
 *
 * The keywords-config helpers read primarily from the context store
 * (`ctx_discovery_keywords`, `ctx_discovery_max_per_keyword`,
 * `ctx_discovery_instagram`) and write back to BOTH the context store and the
 * on-disk keywords.json file (kept in sync for backwards compatibility).
 *
 * Cross-file dependencies: fs, path, ../../db/database (getDb),
 * ../../services/contextService (getContext, setContext),
 * ../../config/pipelineConfig (keywordsFilePath), ../../utils/logger.
 *
 * NOTE: this file lives at src/routes/discovery/shared.js, so __dirname is
 * src/routes/discovery — three levels below the project root. The original
 * file lived at src/routes/discovery.js (two levels below root), so every
 * `../X` becomes `../../X`.
 *
 * Extracted from the original routes/discovery.js for maintainability.
 */

const fs = require("fs");
const path = require("path");
const { getDb } = require("../../db/database");
const { getContext, setContext } = require("../../services/contextService");
const { keywordsFilePath } = require("../../config/pipelineConfig");
const logger = require("../../utils/logger");

function sanitizeLeadIds(leadIds) {
  if (!Array.isArray(leadIds)) {
    return [];
  }

  return [...new Set(leadIds.map(Number).filter(Number.isInteger))];
}

function updateLeadStatuses(leadIds, status) {
  const update = getDb().prepare(
    `UPDATE leads
     SET status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  );
  const transaction = getDb().transaction((ids) => {
    let updated = 0;
    ids.forEach((id) => {
      updated += update.run(status, id).changes;
    });
    return updated;
  });

  return transaction(leadIds);
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Keyword Management
// ---------------------------------------------------------------------------

function resolveKeywordsPath() {
  return path.resolve(keywordsFilePath());
}

function readKeywordsFile() {
  const ctx = getContext();
  if (ctx.ctx_discovery_keywords && Array.isArray(ctx.ctx_discovery_keywords)) {
    // ctx_discovery_instagram is not in contextService.JSON_FIELDS, so it may
    // come back as a JSON string — parse it defensively so callers always see
    // an object. This is what powers the Instagram hashtag persistence on the
    // Lead Discovery page.
    let instagram = {};
    if (ctx.ctx_discovery_instagram) {
      try {
        instagram =
          typeof ctx.ctx_discovery_instagram === "string"
            ? JSON.parse(ctx.ctx_discovery_instagram)
            : ctx.ctx_discovery_instagram;
      } catch {
        instagram = {};
      }
      if (!instagram || typeof instagram !== "object" || Array.isArray(instagram)) {
        instagram = {};
      }
    }
    return {
      version: 1,
      keywords: ctx.ctx_discovery_keywords,
      platforms: ctx.ctx_audience_geographies
        ? ["linkedin", "x", "instagram"]
        : ["linkedin", "x"],
      maxLeadsPerKeyword: Number(ctx.ctx_discovery_max_per_keyword) || 10,
      instagram,
    };
  }
  // Fallback: read from file
  try {
    const filePath = resolveKeywordsPath();
    if (!fs.existsSync(filePath)) {
      return {
        version: 1,
        keywords: [],
        platforms: ["linkedin", "facebook"],
        maxLeadsPerKeyword: 10,
      };
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {
      version: 1,
      keywords: [],
      platforms: ["linkedin", "facebook"],
      maxLeadsPerKeyword: 10,
    };
  }
}

function writeKeywordsFile(data) {
  // Write to context store (primary source after migration)
  setContext("ctx_discovery_keywords", data.keywords || []);
  if (data.maxLeadsPerKeyword !== undefined) {
    setContext(
      "ctx_discovery_max_per_keyword",
      String(data.maxLeadsPerKeyword),
    );
  }
  // Persist Instagram discovery keywords (hashtags, geolocations, etc.) so
  // they survive a page reload even when the context store is the primary
  // source of truth for the rest of the keywords config.
  if (data.instagram !== undefined) {
    setContext("ctx_discovery_instagram", data.instagram || {});
  }

  // Also write to file for backwards compatibility
  try {
    const filePath = resolveKeywordsPath();
    require("fs").writeFileSync(
      filePath,
      JSON.stringify(data, null, 2),
      "utf8",
    );
  } catch (err) {
    logger.warn(
      "DISCOVERY",
      "Could not write keywords.json (non-fatal):",
      err.message,
    );
  }
}

function normalizeKeywordEntry(entry) {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const keyword = String(entry.keyword || "").trim();
    if (!keyword) return null;

    const normalized = { ...entry, keyword };
    if (Array.isArray(entry.platforms)) {
      normalized.platforms = entry.platforms
        .map((p) => String(p).trim().toLowerCase())
        .filter(Boolean);
    }
    return normalized;
  }

  const keyword = String(entry || "").trim();
  return keyword ? keyword : null;
}

function keywordIdentity(entry) {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    return String(entry.keyword || "").trim().toLowerCase();
  }
  return String(entry || "").trim().toLowerCase();
}

module.exports = {
  sanitizeLeadIds,
  updateLeadStatuses,
  parseJsonArray,
  resolveKeywordsPath,
  readKeywordsFile,
  writeKeywordsFile,
  normalizeKeywordEntry,
  keywordIdentity,
};
