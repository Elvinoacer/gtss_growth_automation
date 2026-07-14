/**
 * qualificationService/scoring.js
 *
 * Core single-lead scoring logic. Calls Gemini via aiService, parses the
 * JSON response (tolerantly, via parseGeminiJsonObject), persists the
 * resulting score/reason/status to the leads table, and — for qualified
 * Instagram leads — kicks off the suggested-accounts crawl (fire-and-forget).
 *
 * Exports:
 *   - scoreLead(lead, options?): Promise<{ score, reason, factors }>
 *
 * Fallback behavior:
 *   - On Gemini timeout / parse failure: throws a typed error (status:
 *     "timeout" | "parse_failed") so the batch processor can retry
 *     timeouts with an extended timeout window.
 *   - On any OTHER Gemini error in AI mode (status !== "timeout" and !==
 *     "parse_failed"): falls back to the manual qualification score from
 *     pipelineConfig so a single Gemini outage doesn't block the whole
 *     pipeline. Persists the fallback score with a clear reason string
 *     ("Auto-qualified: AI unavailable (...)").
 *   - On any error in non-pipeline contexts (i.e., when stageMode is not
 *     "ai"): persists the lead as "scoring_failed" (HTTP 500 / parse
 *     failures) or "pending_qualification" (other errors) and re-throws.
 *
 * Path notes: the original file used `require("./X")` for sibling services
 * (aiService, contextService, socketService, instagramDiscoveryService) —
 * from this split file those become `require("../X")`. Path to
 * ../db/database and ../config/pipelineConfig and ../utils/logger are
 * unchanged in depth (the original was at src/services/, this split file
 * is at src/services/qualificationService/ — one level deeper — so those
 * become ../../db/database, ../../config/pipelineConfig, ../../utils/logger).
 */

const { getDb } = require("../../db/database");
const { callGeminiText, unwrapGeminiText } = require("../aiService");
const logger = require("../../utils/logger");
const {
  stageMode,
  manualQualificationScore,
  qualificationThreshold,
} = require("../../config/pipelineConfig");
const { parseGeminiJsonObject } = require("./state");
const { buildPrompt } = require("./promptBuilder");

async function scoreLead(lead, options = {}) {
  const db = getDb();
  const prompt = buildPrompt(lead);

  try {
    const generation = await callGeminiText(prompt, { timeoutMs: options.timeoutMs });
    const rawResult = unwrapGeminiText(generation);
    logger.db("info", "outreach", "qualification", "Gemini qualification response received", {
      leadId: lead.id,
      source: generation.source || "unknown",
      model: generation.model,
    });

    let result;
    try {
      result = parseGeminiJsonObject(rawResult);
    } catch (err) {
      logger.error("GEMINI", "Failed to parse Gemini message content as JSON", {
        raw: rawResult,
      });
      const contentError = new Error(
        "Gemini did not return valid JSON content",
      );
      contentError.status = "parse_failed";
      throw contentError;
    }

    const score = Math.max(0, Math.min(100, Number(result.score) || 0));
    const reason = String(result.reason || "");
    const threshold = qualificationThreshold();
    const status = score >= threshold ? "qualified" : "deprioritized";

    db.prepare(
      `UPDATE leads
       SET lead_score = ?, score_reason = ?, status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(score, reason, status, lead.id);

    if (
      status === "qualified" &&
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

    return { score, reason, factors: result.factors || {} };
  } catch (error) {
    logger.error("QUALIFICATION", `Error scoring lead ${lead.id}`, error);

    // In AI mode, fall back to manual score when Gemini is unavailable
    const mode = stageMode("qualification");
    if (mode === "ai" && error.status !== "timeout" && error.status !== "parse_failed") {
      const fallbackScore = manualQualificationScore();
      const threshold = qualificationThreshold();
      const fallbackStatus =
        fallbackScore >= threshold ? "qualified" : "deprioritized";
      const fallbackReason = `Auto-qualified: AI unavailable (${error.message}), score assigned by pipeline fallback`;

      logger.warn(
        "QUALIFICATION",
        `Gemini unavailable for lead ${lead.id}, using manual fallback score ${fallbackScore}`,
      );

      db.prepare(
        `UPDATE leads
         SET lead_score = ?, score_reason = ?, status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      ).run(fallbackScore, fallbackReason, fallbackStatus, lead.id);

      if (
        fallbackStatus === "qualified" &&
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

      return { score: fallbackScore, reason: fallbackReason, factors: {} };
    }

    // Original error handling for non-pipeline contexts
    const status =
      error.status === 500 || error.status === "parse_failed"
        ? "scoring_failed"
        : "pending_qualification";

    db.prepare(
      `UPDATE leads
       SET status = ?, score_reason = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(status, `Qualification failed: ${error.message}`, lead.id);

    throw error;
  }
}

module.exports = { scoreLead };
