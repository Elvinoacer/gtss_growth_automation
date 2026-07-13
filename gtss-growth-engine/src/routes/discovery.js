const express = require("express");
const fs = require("fs");
const path = require("path");
const { renderPage } = require("./pageRenderer");
const { getDb } = require("../db/database");
const { getContext, setContext } = require("../services/contextService");
const { keywordsFilePath } = require("../config/pipelineConfig");
const logger = require("../utils/logger");
const {
  discoverLeads,
  listDiscoverySources,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
  stopDiscovery,
} = require("../services/discoveryService");

const router = express.Router();

router.get("/", (req, res) => {
  renderPage(res, {
    title: "Discovery",
    primaryHeading: "Find prospects",
    primaryCopy:
      "Collect and normalize leads from LinkedIn, X, Instagram, and Facebook.",
  });
});

router.get("/config", (req, res) => {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = 'discovery_max_leads'")
    .get();
  res.json({ maxLeads: row ? Number(row.value) : 20 });
});

router.post("/config", (req, res) => {
  const maxLeads = Number(req.body.maxLeads);
  if (!Number.isInteger(maxLeads) || maxLeads < 1 || maxLeads > 100) {
    return res
      .status(400)
      .json({ error: "maxLeads must be between 1 and 100" });
  }
  getDb()
    .prepare(
      `
    INSERT INTO settings (key, value) VALUES ('discovery_max_leads', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `,
    )
    .run(String(maxLeads));
  res.json({ success: true });
});

router.post("/start", (req, res) => {
  const { keyword, platforms, maxLeads, ig_auto_warmup } = req.body;
  const selectedPlatforms = Array.isArray(platforms) ? platforms : [];

  if (ig_auto_warmup !== undefined) {
    const db = getDb();
    const val = ig_auto_warmup ? "1" : "0";
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_warmup_on_qualify', ?)",
    ).run(val);
  }
  const parsedMaxLeads = Number(maxLeads);
  const validPlatforms = listDiscoverySources();

  if (!keyword || !String(keyword).trim()) {
    return res.status(400).json({ error: "Keyword is required" });
  }

  if (selectedPlatforms.length === 0) {
    return res.status(400).json({ error: "At least one platform is required" });
  }

  if (
    selectedPlatforms.some((platform) => !validPlatforms.includes(platform))
  ) {
    return res.status(400).json({ error: "Unsupported platform selected" });
  }

  if (
    !Number.isInteger(parsedMaxLeads) ||
    parsedMaxLeads < 1 ||
    parsedMaxLeads > 100
  ) {
    return res
      .status(400)
      .json({ error: "maxLeads must be between 1 and 100" });
  }

  const run = getDb()
    .prepare(
      `INSERT INTO discovery_runs (keyword, platforms, leads_found, status)
       VALUES (?, ?, 0, 'running')`,
    )
    .run(String(keyword).trim(), JSON.stringify(selectedPlatforms));

  const jobId = run.lastInsertRowid;

  setImmediate(() => {
    discoverLeads(
      String(keyword).trim(),
      selectedPlatforms,
      parsedMaxLeads,
      jobId,
    ).catch((error) => {
      getDb()
        .prepare("UPDATE discovery_runs SET status = ? WHERE id = ?")
        .run("failed", jobId);
      emitJobEvent(jobId, { type: "error", jobId, message: error.message });
      closeJobStream(jobId);
    });
  });

  return res.status(202).json({ jobId });
});

router.get("/stream/:jobId", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  registerJobStream(req.params.jobId, res);
});

router.post("/stop/:jobId", (req, res) => {
  const result = getDb()
    .prepare(
      "UPDATE discovery_runs SET status = 'stopping' WHERE id = ? AND status = 'running'",
    )
    .run(req.params.jobId);

  stopDiscovery(req.params.jobId);
  return res.json({ stopped: result.changes > 0 });
});

router.get("/results", (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = (page - 1) * limit;
  const where = ["status = 'discovered'"];
  const params = {};

  if (req.query.platform) {
    where.push("platform = @platform");
    params.platform = req.query.platform;
  }

  if (req.query.keyword) {
    where.push("source_keyword LIKE @keyword");
    params.keyword = `%${req.query.keyword}%`;
  }

  if (req.query.dateFrom) {
    where.push("DATE(created_at) >= DATE(@dateFrom)");
    params.dateFrom = req.query.dateFrom;
  }

  if (req.query.dateTo) {
    where.push("DATE(created_at) <= DATE(@dateTo)");
    params.dateTo = req.query.dateTo;
  }

  const whereSql = where.join(" AND ");
  const total = getDb()
    .prepare(`SELECT COUNT(*) AS total FROM leads WHERE ${whereSql}`)
    .get(params).total;
  const leads = getDb()
    .prepare(
      `SELECT *
       FROM leads
       WHERE ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset });

  res.json({
    page,
    limit,
    total,
    leads,
  });
});

router.post("/add-to-queue", (req, res) => {
  const leadIds = sanitizeLeadIds(req.body.leadIds);
  if (leadIds.length === 0) {
    return res.status(400).json({ error: "leadIds is required" });
  }

  const updated = updateLeadStatuses(leadIds, "pending_qualification");
  return res.json({ updated });
});

router.post("/dismiss", (req, res) => {
  const leadIds = sanitizeLeadIds(req.body.leadIds);
  if (leadIds.length === 0) {
    return res.status(400).json({ error: "leadIds is required" });
  }

  const updated = updateLeadStatuses(leadIds, "dismissed");
  return res.json({ updated });
});

// GET /api/discovery/active — returns the currently-running discovery job,
// if any, so the frontend can rehydrate the "running" UI on page load or
// refresh instead of always starting from the idle form.
router.get("/active", (req, res) => {
  const run = getDb()
    .prepare(
      "SELECT * FROM discovery_runs WHERE status = 'running' ORDER BY run_at DESC, id DESC LIMIT 1",
    )
    .get();

  if (!run) {
    return res.json({ active: false });
  }

  return res.json({
    active: true,
    jobId: run.id,
    keyword: run.keyword,
    platforms: parseJsonArray(run.platforms),
  });
});

router.get("/history", (req, res) => {
  const runs = getDb()
    .prepare("SELECT * FROM discovery_runs ORDER BY run_at DESC, id DESC")
    .all()
    .map((run) => ({
      ...run,
      platforms: parseJsonArray(run.platforms),
    }));

  res.json({ runs });
});

router.post("/history/:id/rerun", (req, res) => {
  const run = getDb()
    .prepare("SELECT * FROM discovery_runs WHERE id = ?")
    .get(req.params.id);

  if (!run) {
    return res.status(404).json({ error: "Discovery run not found" });
  }

  const platforms = parseJsonArray(run.platforms);
  const created = getDb()
    .prepare(
      `INSERT INTO discovery_runs (keyword, platforms, leads_found, status)
       VALUES (?, ?, 0, 'running')`,
    )
    .run(run.keyword, JSON.stringify(platforms));
  const jobId = created.lastInsertRowid;
  const maxLeads = Number(req.body.maxLeads) || 50;

  setImmediate(() => {
    discoverLeads(
      run.keyword,
      platforms,
      Math.min(Math.max(maxLeads, 1), 100),
      jobId,
    ).catch((error) => {
      getDb()
        .prepare("UPDATE discovery_runs SET status = ? WHERE id = ?")
        .run("failed", jobId);
      emitJobEvent(jobId, { type: "error", jobId, message: error.message });
      closeJobStream(jobId);
    });
  });

  // Return the platforms alongside the jobId so the rerun caller (discovery.js)
  // can populate the completion summary with the platforms that were actually
  // scanned, not just whatever is currently checked in the form.
  return res.status(202).json({ jobId, platforms });
});

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

// DELETE /api/discovery/keywords/:idx — removes keyword at index
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

module.exports = router;
