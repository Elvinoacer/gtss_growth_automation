/**
 * qualificationService/batchProcessor.js
 *
 * Batch-scoring driver: iterates a list of lead IDs, scores each one
 * (via scoring.scoreLead), emits progress / scored / error / done events
 * via the SSE infrastructure, persists a `qualification_jobs` row with
 * the final status, and retries timed-out leads with an extended
 * (60-second) timeout window.
 *
 * Exports:
 *   - scoreLeadsBatch(leadIds, jobId, { pipelineRunId }?): Promise<summary>
 *     Returns { processed, qualified, deprioritized, failed }.
 *
 * Behavior:
 *   - Processes leads in BATCH_SIZE (10) chunks with BATCH_DELAY_MS (2000)
 *     between chunks (Gemini rate-limit courtesy).
 *   - Checks `isQualificationStopped(jobId)` at the top of each chunk —
 *     if the user clicked Stop, emits a "stopped" + "done" event and
 *     returns immediately with finalStatus="STOPPED".
 *   - If pipelineRunId is provided, also checks
 *     `isPipelineAborted(pipelineRunId)` — the pipeline runner aborts
 *     all child jobs when the user clicks Stop on the whole pipeline.
 *   - After the main loop, retries every timed-out lead with
 *     `scoreLead(lead, { timeoutMs: 60_000 })`. A successful retry
 *     decrements `failed` and increments `qualified`/`deprioritized`.
 *   - Persists the final status to the `qualification_jobs` row
 *     (COMPLETED / FAILED / STOPPED) and removes the job from the
 *     activeQualJobs stop-flag set.
 *
 * Path notes: the original file used `require("../pipeline/pipelineRunner")`
 * for isPipelineAborted — from this split file (one level deeper) that
 * becomes `require("../../pipeline/pipelineRunner")`. Same shift for
 * ../../db/database.
 */

const { getDb } = require("../../db/database");
const { BATCH_SIZE, BATCH_DELAY_MS, isQualificationStopped, activeQualJobs, delay } = require("./state");
const { emitJobEvent, closeJobStream } = require("./sse");
const { scoreLead } = require("./scoring");

async function scoreLeadsBatch(leadIds, jobId, { pipelineRunId } = {}) {
  const db = getDb();
  const emit = (event) => emitJobEvent(jobId, { ...event, jobId });
  const total = leadIds.length;
  let processed = 0;
  let qualified = 0;
  let deprioritized = 0;
  let failed = 0;
  const timedOutLeadIds = [];

  db.prepare(
    `INSERT INTO qualification_jobs (id, status, started_at)
     VALUES (?, 'RUNNING', CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       status = 'RUNNING',
       started_at = CURRENT_TIMESTAMP,
       completed_at = NULL`,
  ).run(String(jobId));

  let finalStatus = "FAILED";

  emit({ type: "info", message: `Starting qualification of ${total} leads` });

  try {
    for (let i = 0; i < leadIds.length; i += BATCH_SIZE) {
      if (isQualificationStopped(jobId)) {
        emit({ type: "stopped", message: "Qualification stopped by user." });
        const summary = { processed, qualified, deprioritized, failed };
        emit({ type: "done", result: summary });
        finalStatus = "STOPPED";
        return summary;
      }
      if (pipelineRunId) {
        const { isPipelineAborted } = require("../../pipeline/pipelineRunner");
        if (isPipelineAborted(pipelineRunId)) {
          emit({
            type: "warn",
            message: "Qualification aborted by pipeline abort signal.",
          });
          finalStatus = "STOPPED";
          return { processed, qualified, deprioritized, failed };
        }
      }

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
          failed++;
          if (error.status === "timeout") timedOutLeadIds.push(leadId);
          emit({
            type: "error",
            leadId,
            name: lead.name,
            message: `Scoring failed: ${error.message}`,
            errorCode: error.status || "unknown",
            isTimeout: error.status === "timeout",
            hint:
              error.status === "timeout"
                ? "Gemini timed out — lead will be retried on next run"
                : error.status === "parse_failed"
                  ? "Gemini returned non-JSON — lead needs manual scoring"
                  : "API error — check Gemini key in Settings",
          });
        }

        processed++;
        emit({ type: "progress", processed, total });
      }

      if (i + BATCH_SIZE < leadIds.length) {
        await delay(BATCH_DELAY_MS);
      }
    }

    if (timedOutLeadIds.length > 0) {
      emit({
        type: "info",
        message: `Retrying ${timedOutLeadIds.length} timed-out leads with extended timeout…`,
      });
      for (const retryLeadId of timedOutLeadIds) {
        if (isQualificationStopped(jobId)) break;
        const retryLead = db.prepare("SELECT * FROM leads WHERE id = ?").get(retryLeadId);
        if (!retryLead) continue;
        try {
          const result = await scoreLead(retryLead, { timeoutMs: 60_000 });
          failed = Math.max(0, failed - 1);
          if (result.score >= 50) qualified++;
          else deprioritized++;
          emit({
            type: "scored",
            leadId: retryLead.id,
            name: retryLead.name,
            score: result.score,
            reason: result.reason,
            retry: true,
          });
        } catch (err) {
          emit({
            type: "error",
            leadId: retryLeadId,
            message: `Retry also failed: ${err.message}`,
            errorCode: err.status || "unknown",
          });
        }
      }
    }

    const summary = { processed, qualified, deprioritized, failed };
    emit({ type: "done", result: summary });
    finalStatus = "COMPLETED";
    return summary;
  } catch (error) {
    emit({ type: "error", message: `Batch failed: ${error.message}` });
    throw error;
  } finally {
    db.prepare(
      "UPDATE qualification_jobs SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(finalStatus, String(jobId));
    activeQualJobs.delete(String(jobId));
    closeJobStream(jobId);
  }
}

module.exports = { scoreLeadsBatch };
