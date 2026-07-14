/**
 * Discovery Routes — Keywords Config + Keyword Groups
 *
 * Express handlers for the discovery keywords config (which platforms to
 * scan, max leads per keyword, the keyword list itself, and the Instagram
 * discovery sub-config — hashtags + geolocations) and the saved keyword
 * groups (named collections of keywords + platforms stored in the
 * `keyword_groups` table):
 *   GET    /keywords                  — Read the full keywords config (from context store, file fallback)
 *   GET    /keywords/available        — Read just the de-duplicated keyword list
 *   GET    /keywords/groups           — List all keyword_groups rows (keywords + platforms parsed)
 *   POST   /keywords/groups           — Create a new keyword group
 *   PUT    /keywords/groups/:id       — Update an existing keyword group's name/keywords/platforms
 *   DELETE /keywords/groups/:id       — Delete a keyword group
 *   POST   /keywords                  — Replace the full keywords config (or merge a partial `instagram`-only update)
 *   POST   /keywords/add              — Append a single keyword (409 if it already exists)
 *   DELETE /keywords/:idx             — Remove the keyword at the given array index
 *
 * Registration order matters: DELETE /keywords/groups/:id is registered BEFORE
 * DELETE /keywords/:idx so that /keywords/groups/5 isn't accidentally captured
 * by the /keywords/:idx pattern with idx="groups". Same registration order as
 * the original file is preserved.
 *
 * Cross-file dependencies: ../../db/database (getDb), ./shared (parseJsonArray,
 * readKeywordsFile, writeKeywordsFile, normalizeKeywordEntry, keywordIdentity).
 *
 * Extracted from the original routes/discovery.js for maintainability.
 */

const { getDb } = require("../../db/database");
const {
  parseJsonArray,
  readKeywordsFile,
  writeKeywordsFile,
  normalizeKeywordEntry,
  keywordIdentity,
} = require("./shared");

/**
 * Register the keywords + keyword-groups routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerKeywordRoutes(router) {
  // GET /api/discovery/keywords — returns keywords.json contents
  router.get("/keywords", (req, res) => {
    res.json(readKeywordsFile());
  });

  router.get("/keywords/available", (req, res) => {
    const config = readKeywordsFile();
    const keywords = (config.keywords || [])
      .map((entry) => (entry && typeof entry === "object" ? entry.keyword : entry))
      .map((keyword) => String(keyword || "").trim())
      .filter(Boolean);
    res.json({ keywords: [...new Set(keywords)] });
  });

  router.get("/keywords/groups", (_req, res) => {
    const groups = getDb()
      .prepare("SELECT * FROM keyword_groups ORDER BY name ASC")
      .all()
      .map((group) => ({
        ...group,
        keywords: parseJsonArray(group.keywords),
        platforms: parseJsonArray(group.platforms),
      }));
    res.json({ groups });
  });

  router.post("/keywords/groups", (req, res) => {
    const name = String(req.body.name || "").trim();
    const keywords = Array.isArray(req.body.keywords)
      ? req.body.keywords.map((keyword) => String(keyword).trim()).filter(Boolean)
      : [];
    const platforms = Array.isArray(req.body.platforms)
      ? req.body.platforms.map((platform) => String(platform).trim().toLowerCase()).filter(Boolean)
      : [];

    if (!name) return res.status(400).json({ error: "Group name is required" });
    if (keywords.length === 0) return res.status(400).json({ error: "Select at least one keyword" });

    const result = getDb()
      .prepare("INSERT INTO keyword_groups (name, keywords, platforms) VALUES (?, ?, ?)")
      .run(name, JSON.stringify(keywords), JSON.stringify(platforms));
    res.status(201).json({ id: result.lastInsertRowid, name, keywords, platforms });
  });

  router.put("/keywords/groups/:id", (req, res) => {
    const group = getDb().prepare("SELECT * FROM keyword_groups WHERE id = ?").get(req.params.id);
    if (!group) return res.status(404).json({ error: "Keyword group not found" });
    const name = req.body.name !== undefined ? String(req.body.name).trim() : group.name;
    const keywords = Array.isArray(req.body.keywords)
      ? req.body.keywords.map((keyword) => String(keyword).trim()).filter(Boolean)
      : parseJsonArray(group.keywords);
    const platforms = Array.isArray(req.body.platforms)
      ? req.body.platforms.map((platform) => String(platform).trim().toLowerCase()).filter(Boolean)
      : parseJsonArray(group.platforms);
    getDb()
      .prepare(
        `UPDATE keyword_groups
         SET name = ?, keywords = ?, platforms = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(name || group.name, JSON.stringify(keywords), JSON.stringify(platforms), group.id);
    res.json({ id: group.id, name: name || group.name, keywords, platforms });
  });

  // NOTE: registered BEFORE `DELETE /keywords/:idx` so that
  // `/keywords/groups/5` matches this route and not the index-based one.
  router.delete("/keywords/groups/:id", (req, res) => {
    const result = getDb().prepare("DELETE FROM keyword_groups WHERE id = ?").run(req.params.id);
    res.json({ deleted: result.changes > 0 });
  });

  // POST /api/discovery/keywords — replaces full keywords config
  // Supports a partial-update mode: when only `instagram` is provided (e.g. to
  // persist Instagram discovery hashtags from the Lead Discovery page), the
  // `keywords` requirement is relaxed and only the instagram section is merged.
  router.post("/keywords", (req, res) => {
    const { keywords, platforms, maxLeadsPerKeyword, instagram } = req.body;
    const hasKeywords = Array.isArray(keywords) && keywords.length > 0;
    const hasInstagram =
      instagram &&
      typeof instagram === "object" &&
      !Array.isArray(instagram);

    if (!hasKeywords && !hasInstagram) {
      return res.status(400).json({
        error:
          "Either a non-empty 'keywords' array or an 'instagram' object is required",
      });
    }

    let sanitizedKeywords = null;
    if (hasKeywords) {
      sanitizedKeywords = keywords.map(normalizeKeywordEntry).filter(Boolean);
      if (sanitizedKeywords.length === 0) {
        return res
          .status(400)
          .json({ error: "At least one non-empty keyword is required" });
      }
    }

    const config = readKeywordsFile();
    if (sanitizedKeywords) {
      config.keywords = sanitizedKeywords;
    }
    if (Array.isArray(platforms) && platforms.length > 0) {
      config.platforms = platforms.map((p) => String(p).trim().toLowerCase());
    }
    if (
      typeof maxLeadsPerKeyword === "number" &&
      maxLeadsPerKeyword >= 1 &&
      maxLeadsPerKeyword <= 100
    ) {
      config.maxLeadsPerKeyword = maxLeadsPerKeyword;
    }

    // Merge Instagram discovery keywords (hashtags / geolocations / etc.)
    if (hasInstagram) {
      config.instagram = config.instagram || {};
      if (Array.isArray(instagram.hashtags)) {
        config.instagram.hashtags = instagram.hashtags
          .map((tag) => String(tag || "").trim().replace(/^#/, ""))
          .filter(Boolean);
      }
      if (Array.isArray(instagram.geolocations)) {
        config.instagram.geolocations = instagram.geolocations;
      }
    }

    config.version = (config.version || 0) + 1;

    writeKeywordsFile(config);
    res.json({ success: true, config });
  });

  // POST /api/discovery/keywords/add — appends a single keyword
  router.post("/keywords/add", (req, res) => {
    const keyword = String(req.body.keyword || "").trim();
    if (!keyword) {
      return res.status(400).json({ error: "keyword is required" });
    }

    const config = readKeywordsFile();
    if (config.keywords.some((item) => keywordIdentity(item) === keyword.toLowerCase())) {
      return res.status(409).json({ error: "Keyword already exists", config });
    }

    config.keywords.push(keyword);
    config.version = (config.version || 0) + 1;
    writeKeywordsFile(config);
    res.json({ success: true, config });
  });

  // DELETE /api/discovery/keywords/:idx — removes keyword at index.
  // Registered AFTER `DELETE /keywords/groups/:id` so the index pattern
  // doesn't shadow the groups route.
  router.delete("/keywords/:idx", (req, res) => {
    const idx = Number(req.params.idx);
    const config = readKeywordsFile();

    if (!Number.isInteger(idx) || idx < 0 || idx >= config.keywords.length) {
      return res
        .status(400)
        .json({
          error: `Invalid index: ${req.params.idx}. Must be 0-${config.keywords.length - 1}`,
        });
    }

    const removed = config.keywords.splice(idx, 1)[0];
    config.version = (config.version || 0) + 1;
    writeKeywordsFile(config);
    res.json({ success: true, removed, config });
  });
}

module.exports = { registerKeywordRoutes };
