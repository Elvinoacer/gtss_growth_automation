/**
 * Discovery Pipeline — Stage 1 of the Pipeline Orchestrator
 *
 * Iterates over all keywords in keywords.json, fires discoverLeads()
 * for each, deduplicates results, and returns a summary.
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/database');
const { discoverLeads } = require('../services/discoveryService');
const { stageMode, keywordsFilePath } = require('../config/pipelineConfig');
const logger = require('../utils/logger');

/**
 * Load the keywords configuration file.
 * @returns {{ keywords: string[], platforms: string[], maxLeadsPerKeyword: number }}
 */
function loadKeywords() {
  const filePath = path.resolve(keywordsFilePath());
  try {
    if (!fs.existsSync(filePath)) {
      logger.warn('PIPELINE', `Keywords file not found at ${filePath}`);
      return { keywords: [], platforms: ['linkedin'], maxLeadsPerKeyword: 10 };
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    logger.error('PIPELINE', 'Failed to load keywords.json', { error: err.message });
    return { keywords: [], platforms: ['linkedin'], maxLeadsPerKeyword: 10 };
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
async function runDiscoveryStage(pipelineRunId, emit) {
  const mode = stageMode('discovery');
  const db = getDb();

  if (mode === 'manual') {
    emit({
      type: 'info',
      message: 'Discovery: manual mode — import leads via CSV or manual entry on the Discovery page. Pipeline will continue with existing discovered leads.',
    });

    // Count existing discovered leads that can proceed
    const existing = db.prepare(
      "SELECT COUNT(*) as count FROM leads WHERE status IN ('discovered', 'pending_qualification')"
    ).get();

    return { newLeads: 0, keywordsRun: 0, skipped: 0, existingDiscovered: existing.count };
  }

  // AI mode — full automated discovery
  const config = loadKeywords();
  const { keywords, platforms, maxLeadsPerKeyword } = config;

  if (keywords.length === 0) {
    emit({ type: 'warn', message: 'No keywords configured. Skipping discovery.' });
    return { newLeads: 0, keywordsRun: 0, skipped: 0 };
  }

  emit({
    type: 'info',
    message: `Discovery: running ${keywords.length} keywords across ${platforms.join(', ')} (max ${maxLeadsPerKeyword} leads per keyword)`,
  });

  let totalNewLeads = 0;
  let keywordsRun = 0;
  let skipped = 0;

  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i];

    emit({
      type: 'progress',
      message: `Keyword ${i + 1}/${keywords.length}: "${keyword}"`,
      processed: i,
      total: keywords.length,
    });

    try {
      // Create a discovery_run record linked to this pipeline run
      const run = db.prepare(
        `INSERT INTO discovery_runs (keyword, platforms, leads_found, status, pipeline_run_id)
         VALUES (?, ?, 0, 'running', ?)`
      ).run(keyword, JSON.stringify(platforms), pipelineRunId);

      const jobId = run.lastInsertRowid;

      const result = await discoverLeads(
        keyword,
        platforms,
        maxLeadsPerKeyword,
        jobId,
      );

      // Tag any new leads with the pipeline run ID
      if (result.new > 0) {
        db.prepare(
          `UPDATE leads
           SET pipeline_run_id = ?
           WHERE source_keyword = ? AND pipeline_run_id IS NULL`
        ).run(pipelineRunId, keyword);
      }

      totalNewLeads += result.new || 0;
      keywordsRun++;

      emit({
        type: 'info',
        message: `"${keyword}": ${result.new} new leads (${result.duplicates} duplicates)`,
      });
    } catch (err) {
      logger.error('PIPELINE', `Discovery failed for keyword "${keyword}"`, { error: err.message });
      emit({
        type: 'warn',
        message: `"${keyword}" failed: ${err.message} — continuing with next keyword`,
      });
      skipped++;
    }
  }

  emit({
    type: 'complete',
    message: `Discovery complete: ${totalNewLeads} new leads from ${keywordsRun} keywords (${skipped} skipped)`,
  });

  return { newLeads: totalNewLeads, keywordsRun, skipped };
}

module.exports = {
  runDiscoveryStage,
};
