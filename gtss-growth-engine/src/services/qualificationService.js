const { getDb } = require("../db/database");
const { callGeminiText } = require("./aiService");
const logger = require("../utils/logger");
const {
  stageMode,
  manualQualificationScore,
  qualificationThreshold,
} = require("../config/pipelineConfig");

const jobStreams = new Map();
const jobEventHistory = new Map();
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 2000;

// ---------------------------------------------------------------------------
// SSE helpers (same pattern as discoveryService)
// ---------------------------------------------------------------------------

function registerJobStream(jobId, res) {
  const key = String(jobId);
  if (!jobStreams.has(key)) {
    jobStreams.set(key, new Set());
  }

  jobStreams.get(key).add(res);
  res.write(`data: ${JSON.stringify({ type: "connected", jobId })}\n\n`);
  (jobEventHistory.get(key) || []).forEach((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  res.on("close", () => {
    const streams = jobStreams.get(key);
    if (!streams) return;
    streams.delete(res);
    if (streams.size === 0) jobStreams.delete(key);
  });
}

function emitJobEvent(jobId, event) {
  const key = String(jobId);
  const history = jobEventHistory.get(key) || [];
  history.push(event);
  jobEventHistory.set(key, history.slice(-200));

  // Broadcast via Socket.IO
  const { broadcast } = require("./socketService");
  broadcast('qualification:event', event);

  // Legacy SSE
  const streams = jobStreams.get(key);
  if (!streams || streams.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  streams.forEach((stream) => stream.write(payload));
}

function closeJobStream(jobId) {
  const key = String(jobId);
  const streams = jobStreams.get(key);
  if (!streams) return;
  streams.forEach((stream) => stream.end());
  jobStreams.delete(key);
  setTimeout(() => jobEventHistory.delete(key), 5 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Gemini API interaction
// ---------------------------------------------------------------------------

function buildPrompt(lead) {
  return `You are a lead qualification specialist for GTSS, a Kenyan tech company selling restaurant management software.

Score this lead from 0 to 100 based on likelihood to be a paying client.

Scoring factors:
- Business type match (restaurant/cafe/hotel/SME = high score; unrelated = low): 30 points
- Location (Kenya, especially Nairobi/Mombasa = high; outside Africa = low): 20 points
- Business size signals (has website, company listed, professional profile = high): 20 points
- Profile completeness (full profile = high; empty = low): 15 points
- Activity recency (recent posts/activity signals = high): 15 points

Lead data:
Name: ${lead.name || "N/A"}
Role: ${lead.role || "N/A"}
Company: ${lead.company || "N/A"}
Location: ${lead.location || "N/A"}
Website: ${lead.website || "N/A"}
Platform: ${lead.platform || "N/A"}

Respond ONLY with valid JSON, no markdown, no preamble:
{"score": 72, "reason": "Restaurant owner in Nairobi with active profile and website — strong match.", "factors": {"business_type": 25, "location": 18, "business_size": 15, "completeness": 8, "recency": 6}}`;
}



// ---------------------------------------------------------------------------
// Core scoring
// ---------------------------------------------------------------------------

async function scoreLead(lead) {
  const db = getDb();
  const prompt = buildPrompt(lead);

  try {
    const rawResult = await callGeminiText(prompt);
    
    let result;
    try {
      result = JSON.parse(rawResult);
    } catch (err) {
      logger.error("GEMINI", "Failed to parse Gemini message content as JSON", {
        raw: rawResult,
      });
      const contentError = new Error("Gemini did not return valid JSON content");
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

    if (status === "qualified" && (lead.platform === "instagram" || (lead.profile_url && lead.profile_url.includes("instagram.com")))) {
      const { crawlAndQueueSuggestedAccounts } = require("./instagramDiscoveryService");
      crawlAndQueueSuggestedAccounts(lead.id).catch(err => {
        logger.error("IG_DISCOVERY", `Failed to crawl suggested accounts for lead ${lead.id}: ${err.message}`);
      });
    }

    return { score, reason, factors: result.factors || {} };
  } catch (error) {
    logger.error("QUALIFICATION", `Error scoring lead ${lead.id}`, error);

    // In AI mode, fall back to manual score when Gemini is unavailable
    const mode = stageMode('qualification');
    if (mode === 'ai') {
      const fallbackScore = manualQualificationScore();
      const threshold = qualificationThreshold();
      const fallbackStatus = fallbackScore >= threshold ? 'qualified' : 'deprioritized';
      const fallbackReason = `Auto-qualified: AI unavailable (${error.message}), score assigned by pipeline fallback`;

      logger.warn('QUALIFICATION', `Gemini unavailable for lead ${lead.id}, using manual fallback score ${fallbackScore}`);

      db.prepare(
        `UPDATE leads
         SET lead_score = ?, score_reason = ?, status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      ).run(fallbackScore, fallbackReason, fallbackStatus, lead.id);

      if (fallbackStatus === "qualified" && (lead.platform === "instagram" || (lead.profile_url && lead.profile_url.includes("instagram.com")))) {
        const { crawlAndQueueSuggestedAccounts } = require("./instagramDiscoveryService");
        crawlAndQueueSuggestedAccounts(lead.id).catch(err => {
          logger.error("IG_DISCOVERY", `Failed to crawl suggested accounts for lead ${lead.id}: ${err.message}`);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scoreLeadsBatch(leadIds, jobId) {
  const db = getDb();
  const emit = (event) => emitJobEvent(jobId, { ...event, jobId });
  const total = leadIds.length;
  let processed = 0;
  let qualified = 0;
  let deprioritized = 0;

  emit({ type: "info", message: `Starting qualification of ${total} leads` });

  try {
    for (let i = 0; i < leadIds.length; i += BATCH_SIZE) {
      const batch = leadIds.slice(i, i + BATCH_SIZE);

      for (const leadId of batch) {
        const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
        if (!lead) {
          processed++;
          continue;
        }

        try {
          const result = await scoreLead(lead);
          if (result.score >= 50) {
            qualified++;
          } else {
            deprioritized++;
          }
          emit({
            type: "scored",
            leadId: lead.id,
            name: lead.name,
            score: result.score,
            reason: result.reason,
          });
        } catch (error) {
          // Error already logged and handled in scoreLead
          emit({ type: "error", leadId, message: error.message });
        }

        processed++;
        emit({ type: "progress", processed, total });
      }

      if (i + BATCH_SIZE < leadIds.length) {
        await delay(BATCH_DELAY_MS);
      }
    }

    const summary = { processed, qualified, deprioritized };
    emit({ type: "done", result: summary });
    return summary;
  } catch (error) {
    emit({ type: "error", message: `Batch failed: ${error.message}` });
    throw error;
  } finally {
    closeJobStream(jobId);
  }
}

// ---------------------------------------------------------------------------
// Pipeline entry point: runQualificationStage
// ---------------------------------------------------------------------------

/**
 * Run the qualification stage for the pipeline.
 * In manual mode, all pending leads are bulk-qualified with a fixed score.
 * In AI mode, leads are scored via Gemini with automatic fallback.
 *
 * @param {string|number} jobId - Pipeline run ID for SSE event tracking
 * @param {Function} emit - Event emitter function (type, message)
 * @returns {Promise<{processed: number, qualified: number, deprioritized: number}>}
 */
async function runQualificationStage(jobId, emit) {
  const mode = stageMode('qualification');
  const db = getDb();

  // Find all leads that need qualification
  const pending = db.prepare(
    `SELECT id FROM leads
     WHERE status IN ('discovered', 'pending_qualification')
        OR (lead_score IS NULL AND status NOT IN ('dismissed', 'messaged', 'replied', 'meeting_booked', 'converted', 'lost'))
     ORDER BY created_at DESC`
  ).all().map(r => r.id);

  if (pending.length === 0) {
    emit({ type: 'info', message: 'No pending leads to qualify' });
    return { processed: 0, qualified: 0, deprioritized: 0 };
  }

  if (mode === 'manual') {
    // Bulk qualify all leads — intentionally makes all pass so the operator
    // can reject on the Message Generator page before messages are sent
    const score = manualQualificationScore();
    const reason = 'Pipeline manual mode — all leads pre-qualified for human review';

    emit({ type: 'info', message: `Manual mode: qualifying ${pending.length} leads with score ${score}` });

    db.prepare(
      `UPDATE leads
       SET lead_score = ?, score_reason = ?, status = 'qualified', updated_at = CURRENT_TIMESTAMP
       WHERE id IN (${pending.map(() => '?').join(',')})`
    ).run(score, reason, ...pending);

    for (const leadId of pending) {
      const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
      if (lead && (lead.platform === "instagram" || (lead.profile_url && lead.profile_url.includes("instagram.com")))) {
        const { crawlAndQueueSuggestedAccounts } = require("./instagramDiscoveryService");
        crawlAndQueueSuggestedAccounts(lead.id).catch(err => {
          logger.error("IG_DISCOVERY", `Failed to crawl suggested accounts for lead ${lead.id}: ${err.message}`);
        });
      }
    }

    emit({
      type: 'complete',
      message: `Manual mode: ${pending.length} leads qualified with score ${score}`,
      qualified: pending.length,
      deprioritized: 0,
    });

    return { processed: pending.length, qualified: pending.length, deprioritized: 0 };
  }

  // AI mode — calls existing scoreLeadsBatch with AI→manual fallback inside scoreLead
  emit({ type: 'info', message: `AI mode: scoring ${pending.length} leads via Gemini` });
  return await scoreLeadsBatch(pending, jobId);
}

module.exports = {
  scoreLead,
  scoreLeadsBatch,
  runQualificationStage,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
};
