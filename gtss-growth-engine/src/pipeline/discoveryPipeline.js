/**
 * Discovery Pipeline — Stage 1 of the Pipeline Orchestrator
 *
 * Iterates over all keywords in keywords.json, fires discoverLeads()
 * for each, deduplicates results, and returns a summary.
 */

const fs = require("fs");
const path = require("path");
const { getDb } = require("../db/database");
const { discoverLeads } = require("../services/discoveryService");
const { getContext } = require("../services/contextService");
const { stageMode, keywordsFilePath } = require("../config/pipelineConfig");
const logger = require("../utils/logger");

/**
 * Load the keywords configuration file.
 * @returns {{ keywords: string[], platforms: string[], maxLeadsPerKeyword: number }}
 */
function loadKeywords() {
  const ctx = getContext();

  // Primary source: context store
  if (
    ctx.ctx_discovery_keywords &&
    Array.isArray(ctx.ctx_discovery_keywords) &&
    ctx.ctx_discovery_keywords.length > 0
  ) {
    const defaultPlatforms = process.env.DISCOVERY_PLATFORMS
      ? process.env.DISCOVERY_PLATFORMS.split(",")
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean)
      : ["linkedin", "x"];

    return {
      keywords: ctx.ctx_discovery_keywords,
      platforms: defaultPlatforms,
      maxLeadsPerKeyword: Number(ctx.ctx_discovery_max_per_keyword) || 10,
    };
  }

  // Fallback: read from filesystem (pre-migration path)
  const filePath = path.resolve(keywordsFilePath());
  const defaultPlatforms = process.env.DISCOVERY_PLATFORMS
    ? process.env.DISCOVERY_PLATFORMS.split(",")
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean)
    : ["linkedin", "x"];

  try {
    if (!fs.existsSync(filePath)) {
      logger.warn("PIPELINE", `Keywords file not found at ${filePath}`);
      return {
        keywords: [],
        platforms: defaultPlatforms,
        maxLeadsPerKeyword: 10,
      };
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    logger.error("PIPELINE", "Failed to load keywords", { error: err.message });
    return {
      keywords: [],
      platforms: defaultPlatforms,
      maxLeadsPerKeyword: 10,
    };
  }
}

/**
 * Run the discovery stage of the pipeline.
 *
 * In AI mode:  Full Playwright browser scraping via discoverLeads()
 * In manual mode: Skips scraping, logs instruction for operator
 *
 * @param {number} pipelineRunId - Pipeline run ID for tracking
 * @param {Function} emit - Event emitter for pipeline SSE stream
 * @returns {Promise<{newLeads: number, keywordsRun: number, skipped: number}>}
 */
async function runDiscoveryStage(
  pipelineRunId,
  emit,
  maxLeadsPerKeywordOverride,
  keywordsOverride,
) {
  const mode = stageMode("discovery");
  const db = getDb();

  if (mode === "manual") {
    emit({
      type: "info",
      message:
        "Discovery: manual mode — import leads via CSV or manual entry on the Discovery page. Pipeline will continue with existing discovered leads.",
    });

    // Count existing discovered leads that can proceed
    const existing = db
      .prepare(
        "SELECT COUNT(*) as count FROM leads WHERE status IN ('discovered', 'pending_qualification')",
      )
      .get();

    return {
      newLeads: 0,
      keywordsRun: 0,
      skipped: 0,
      existingDiscovered: existing.count,
    };
  }

  // AI mode — full automated discovery
  const config = loadKeywords();
  let { keywords, platforms, maxLeadsPerKeyword } = config;
  const selectedKeywords = Array.isArray(keywordsOverride)
    ? keywordsOverride.map((keyword) => String(keyword).trim()).filter(Boolean)
    : [];
  if (selectedKeywords.length > 0) {
    const selectedSet = new Set(selectedKeywords.map((keyword) => keyword.toLowerCase()));
    keywords = keywords.filter((item) => {
      const value =
        item && typeof item === "object" ? item.keyword : String(item || "");
      return selectedSet.has(String(value).trim().toLowerCase());
    });
    logger.db("info", "discovery", "keyword_filter", "Discovery keyword filter applied", {
      jobId: pipelineRunId,
      requested: selectedKeywords,
      matched: keywords.length,
    });
  }

  if (typeof maxLeadsPerKeywordOverride === "number") {
    maxLeadsPerKeyword = maxLeadsPerKeywordOverride;
  }

  // Support DISCOVERY_PLATFORMS environment variable override
  if (process.env.DISCOVERY_PLATFORMS) {
    platforms = process.env.DISCOVERY_PLATFORMS.split(",")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
  }

  if (keywords.length === 0) {
    emit({
      type: "warn",
      message: "No keywords configured. Skipping discovery.",
    });
    return { newLeads: 0, keywordsRun: 0, skipped: 0 };
  }

  emit({
    type: "info",
    message: `Discovery: running ${keywords.length} keywords across ${platforms.join(", ")} (max ${maxLeadsPerKeyword} leads per keyword)`,
  });

  let totalNewLeads = 0;
  let keywordsRun = 0;
  let skipped = 0;

  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i];
    let keywordText = keyword;
    let keywordPlatforms = platforms;

    if (keyword && typeof keyword === "object") {
      keywordText = keyword.keyword || "";
      if (keyword.platforms && Array.isArray(keyword.platforms)) {
        keywordPlatforms = keyword.platforms;
      }
    }

    // Apply active DISCOVERY_PLATFORMS override/filtering if set
    if (process.env.DISCOVERY_PLATFORMS) {
      keywordPlatforms = keywordPlatforms.filter((p) => platforms.includes(p));
    }

    if (!keywordText) {
      logger.warn("PIPELINE", `Skipping empty keyword at index ${i}`);
      continue;
    }

    emit({
      type: "progress",
      message: `Keyword ${i + 1}/${keywords.length}: "${keywordText}" on ${keywordPlatforms.join(", ")}`,
      processed: i,
      total: keywords.length,
    });

    try {
      // Create a discovery_run record linked to this pipeline run
      const run = db
        .prepare(
          `INSERT INTO discovery_runs (keyword, platforms, leads_found, status, pipeline_run_id)
         VALUES (?, ?, 0, 'running', ?)`,
        )
        .run(keywordText, JSON.stringify(keywordPlatforms), pipelineRunId);

      const jobId = run.lastInsertRowid;

      const result = await discoverLeads(
        keywordText,
        keywordPlatforms,
        maxLeadsPerKeyword,
        jobId,
      );

      // Tag any new leads with the pipeline run ID
      if (result.new > 0) {
        db.prepare(
          `UPDATE leads
           SET pipeline_run_id = ?
           WHERE source_keyword = ? AND pipeline_run_id IS NULL`,
        ).run(pipelineRunId, keywordText);
      }

      totalNewLeads += result.new || 0;
      keywordsRun++;

      emit({
        type: "info",
        message: `"${keywordText}": ${result.new} new leads (${result.duplicates} duplicates)`,
      });
    } catch (err) {
      logger.error(
        "PIPELINE",
        `Discovery failed for keyword "${keywordText}"`,
        { error: err.message },
      );
      emit({
        type: "warn",
        message: `"${keywordText}" failed: ${err.message} — continuing with next keyword`,
      });
      skipped++;
    }
  }

  emit({
    type: "complete",
    message: `Discovery complete: ${totalNewLeads} new leads from ${keywordsRun} keywords (${skipped} skipped)`,
  });

  return { newLeads: totalNewLeads, keywordsRun, skipped };
}

module.exports = {
  runDiscoveryStage,
};
