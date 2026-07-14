/**
 * qualificationService/pipelineStage.js
 *
 * The pipeline entry point: `runQualificationStage(jobId, emit, platforms)`.
 *
 * Decides between manual mode (bulk-qualify every pending lead with the
 * manual qualification score from pipelineConfig) and AI mode (delegate
 * to batchProcessor.scoreLeadsBatch, which calls Gemini for each lead
 * with the AI→manual fallback baked into scoring.scoreLead).
 *
 * Exports:
 *   - runQualificationStage(jobId, emit, platforms?): Promise<summary>
 *     Returns { processed, qualified, deprioritized, failed }.
 *
 * Behavior:
 *   - mode = stageMode("qualification") from pipelineConfig
 *   - In BOTH modes: SELECT all leads whose status is
 *     'discovered'/'pending_qualification' OR whose lead_score is NULL
 *     AND status is not in a terminal state. Optionally filtered by
 *     the `platforms` arg (case-insensitive, lowercased).
 *   - In manual mode: UPDATE every pending lead with the manual score +
 *     status='qualified' + reason="Pipeline manual mode — all leads
 *     pre-qualified for human review". For Instagram leads, also
 *     fire-and-forget crawlAndQueueSuggestedAccounts (so the suggested-
 *     accounts queue is populated the same way it is in AI mode).
 *   - In AI mode: emit "AI mode: scoring N leads via Gemini" + delegate
 *     to scoreLeadsBatch(pending, jobId, { pipelineRunId: jobId }).
 *
 * Path notes: the original file used `require("../config/pipelineConfig")`
 * — from this split file (one level deeper) that becomes
 * `require("../../config/pipelineConfig")`. Same shift for
 * ../../db/database. The sibling-service require
 * `require("./instagramDiscoveryService")` becomes
 * `require("../instagramDiscoveryService")` here.
 */

const { getDb } = require("../../db/database");
const logger = require("../../utils/logger");
const {
  stageMode,
  manualQualificationScore,
} = require("../../config/pipelineConfig");
const { scoreLeadsBatch } = require("./batchProcessor");

/**
 * Run the qualification stage for the pipeline.
 * In manual mode, all pending leads are bulk-qualified with a fixed score.
 * In AI mode, leads are scored via Gemini with automatic fallback.
 *
 * @param {string|number} jobId - Pipeline run ID for SSE event tracking
 * @param {Function} emit - Event emitter function (type, message)
 * @returns {Promise<{processed: number, qualified: number, deprioritized: number}>}
 */
async function runQualificationStage(jobId, emit, platforms = []) {
  const mode = stageMode("qualification");
  const db = getDb();
  const selectedPlatforms = Array.isArray(platforms)
    ? platforms.map((platform) => String(platform).trim().toLowerCase()).filter(Boolean)
    : [];
  const platformClause =
    selectedPlatforms.length > 0
      ? `AND platform IN (${selectedPlatforms.map(() => "?").join(",")})`
      : "";

  // Find all leads that need qualification
  const pending = db
    .prepare(
      `SELECT id FROM leads
     WHERE (
        status IN ('discovered', 'pending_qualification')
        OR (lead_score IS NULL AND status NOT IN ('dismissed', 'messaged', 'replied', 'meeting_booked', 'converted', 'lost'))
     )
     ${platformClause}
     ORDER BY created_at DESC`,
    )
    .all(...selectedPlatforms)
    .map((r) => r.id);

  if (pending.length === 0) {
    emit({ type: "info", message: "No pending leads to qualify" });
    return { processed: 0, qualified: 0, deprioritized: 0, failed: 0 };
  }

  if (mode === "manual") {
    // Bulk qualify all leads — intentionally makes all pass so the operator
    // can reject on the Message Generator page before messages are sent
    const score = manualQualificationScore();
    const reason =
      "Pipeline manual mode — all leads pre-qualified for human review";

    emit({
      type: "info",
      message: `Manual mode: qualifying ${pending.length} leads with score ${score}`,
    });

    db.prepare(
      `UPDATE leads
       SET lead_score = ?, score_reason = ?, status = 'qualified', updated_at = CURRENT_TIMESTAMP
       WHERE id IN (${pending.map(() => "?").join(",")})`,
    ).run(score, reason, ...pending);

    for (const leadId of pending) {
      const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
      if (
        lead &&
        (lead.platform === "instagram" ||
          (lead.profile_url && lead.profile_url.includes("instagram.com")))
      ) {
        const {
          crawlAndQueueSuggestedAccounts,
        } = require("../instagramDiscoveryService");
        crawlAndQueueSuggestedAccounts(lead.id).catch((err) => {
          logger.error(
            "IG_DISCOVERY",
            `Failed to crawl suggested accounts for lead ${lead.id}: ${err.message}`,
          );
        });
      }
    }

    emit({
      type: "complete",
      message: `Manual mode: ${pending.length} leads qualified with score ${score}`,
      qualified: pending.length,
      deprioritized: 0,
    });

    return {
      processed: pending.length,
      qualified: pending.length,
      deprioritized: 0,
      failed: 0,
    };
  }

  // AI mode — calls existing scoreLeadsBatch with AI→manual fallback inside scoreLead
  emit({
    type: "info",
    message: `AI mode: scoring ${pending.length} leads via Gemini`,
  });
  return await scoreLeadsBatch(pending, jobId, { pipelineRunId: jobId });
}

module.exports = { runQualificationStage };
