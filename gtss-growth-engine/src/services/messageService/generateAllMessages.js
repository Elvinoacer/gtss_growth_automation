/**
 * messageService/generateAllMessages.js
 *
 * Batch job: generate messages for every qualified lead that doesn't yet
 * have an approved message. Used by the message-generation job UI (the
 * "Generate All" button) — NOT by the pipeline's runMessageStage (which
 * is the pipeline entry point).
 *
 * Flow:
 *   1. INSERT/UPSERT a message_generation_jobs row keyed by jobId (so the
 *      UI can poll the job status).
 *   2. SELECT every qualified lead with no pending/approved message.
 *   3. Process in batches of BATCH_SIZE: for each lead, call
 *      generateMessages(), emit a "generated" event with the first 60
 *      chars of each variant body, then sleep BATCH_DELAY_MS between
 *      batches (avoids hammering Gemini).
 *   4. Emit a final "done" event with the { processed, succeeded, failed }
 *      summary, mark the job row COMPLETED (or FAILED on throw), and
 *      close the SSE stream.
 *
 * Returns { processed, succeeded, failed }.
 */

const { getDb } = require("../../db/database");
const { BATCH_SIZE, BATCH_DELAY_MS, emitJobEvent, closeJobStream } = require("./sseInfrastructure");
const { generateMessages } = require("./generateMessages");
const {
  needsAiMessageSql,
  hasNonTemplateMessage,
  retireTemplateMessages,
  listFallbackLeads,
} = require("./retireTemplateMessages");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shared batch runner used by Generate All and Retry Fallbacks.
 *
 * Cascade per lead (identical for both buttons + pipeline AI path):
 *   Gemini API → Gemini Web → template-fallback
 *
 * @param {string} jobId
 * @param {object[]} leads
 * @param {string|null|undefined} tone
 * @param {{ label?: string, forceAi?: boolean }} [meta]
 */
async function runBulkGenerationJob(jobId, leads, tone, meta = {}) {
  const db = getDb();
  const emit = (event) => emitJobEvent(jobId, { ...event, jobId });
  const label = meta.label || "Generating messages";
  // Retry Fallbacks always forces the Gemini cascade even if Settings is
  // set to Template mode. Generate All respects the setting unless forced.
  const forceAi = meta.forceAi === true;

  db.prepare(
    `INSERT INTO message_generation_jobs (id, status, started_at)
     VALUES (?, 'RUNNING', CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       status = 'RUNNING',
       started_at = CURRENT_TIMESTAMP,
       completed_at = NULL`,
  ).run(String(jobId));

  let finalStatus = "FAILED";
  const total = leads.length;
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let aiCount = 0;
  let aiWebCount = 0;
  let fallbackCount = 0;

  emit({
    type: "info",
    message: `${label} for ${total} lead(s) — cascade: Gemini API → Gemini Web → template`,
  });

  try {
    for (let i = 0; i < leads.length; i += BATCH_SIZE) {
      const batch = leads.slice(i, i + BATCH_SIZE);

      for (const lead of batch) {
        try {
          // Clear stale template drafts so we never leave both a template B
          // and an AI B pending for the same lead (bulk-approve race).
          const retired = retireTemplateMessages(db, {
            leadId: lead.id,
            platform: lead.platform || null,
          });

          // If this lead already has a real Gemini draft/approval, just
          // retiring the templates is enough — don't burn another Gemini call.
          if (hasNonTemplateMessage(db, lead.id)) {
            succeeded++;
            aiCount++;
            emit({
              type: "info",
              leadId: lead.id,
              name: lead.name,
              message: `${lead.name || lead.id}: already has AI message — retired ${retired} template draft(s)`,
            });
            emit({
              type: "generated",
              leadId: lead.id,
              name: lead.name,
              generatedBy: "ai",
              variantA: "(existing AI kept)",
              variantB: "",
            });
          } else {
            const result = await generateMessages(
              lead.id,
              lead.platform,
              null,
              tone,
              {
                forceAi,
                onProgress: (step) => {
                  if (!step || !step.message) return;
                  // Surface API → Web transitions in the live progress feed.
                  if (
                    step.stage === "web" ||
                    step.stage === "web_ok" ||
                    step.stage === "api_ok" ||
                    step.stage === "template"
                  ) {
                    emit({
                      type: "info",
                      leadId: lead.id,
                      name: lead.name,
                      message: `${lead.name || lead.id}: ${step.message}`,
                      stage: step.stage,
                      source: step.source || null,
                    });
                  }
                },
              },
            );
            succeeded++;
            const generatedBy = String(result.generatedBy || "").toLowerCase();
            if (generatedBy === "ai") {
              aiCount++;
            } else if (generatedBy === "ai-web") {
              aiWebCount++;
            } else if (
              generatedBy === "template" ||
              generatedBy === "template-fallback"
            ) {
              fallbackCount++;
            }
            emit({
              type: "generated",
              leadId: lead.id,
              name: lead.name,
              generatedBy: result.generatedBy || null,
              variantA: result.variantA.body.slice(0, 60),
              variantB: result.variantB.body.slice(0, 60),
            });
          }
        } catch (err) {
          failed++;
          emit({ type: "error", leadId: lead.id, message: err.message });
        }
        processed++;
        emit({ type: "progress", processed, total });
      }
      if (i + BATCH_SIZE < leads.length) await delay(BATCH_DELAY_MS);
    }
    const summary = {
      processed,
      succeeded,
      failed,
      aiCount,
      aiWebCount,
      // Total real Gemini successes (API + Web) for UI convenience
      aiTotal: aiCount + aiWebCount,
      fallbackCount,
    };
    emit({ type: "done", result: summary });
    finalStatus = "COMPLETED";
    return summary;
  } catch (error) {
    emit({ type: "error", message: error.message });
    throw error;
  } finally {
    db.prepare(
      "UPDATE message_generation_jobs SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(finalStatus, String(jobId));
    closeJobStream(jobId);
  }
}

async function generateAllMessages(jobId, productPitch, tone) {
  const db = getDb();

  // Include leads stuck on template / template-fallback only. Those drafts
  // are emergency fallbacks — Generate All must re-attempt Gemini so the
  // Automation queue can send real AI bodies.
  const qualifiedLeads = db
    .prepare(
      `SELECT l.* FROM leads l
     WHERE l.status = 'qualified'
       AND ${needsAiMessageSql("l")}
     ORDER BY l.lead_score DESC`,
    )
    .all();

  return runBulkGenerationJob(jobId, qualifiedLeads, tone, {
    label:
      "Generating messages for qualified leads (API → Web → template)",
    // Same cascade as Retry Fallbacks when AI source is selected; forceAi
    // is false so an intentional Template setting is still respected.
    forceAi: false,
  });
}

/**
 * Re-run Gemini for every lead that currently only has template /
 * template-fallback drafts — including leads that left 'qualified' after
 * an earlier fallback was created. This is the "Retry All Fallbacks" button.
 *
 * Always uses the full cascade (API → Web → template), matching Generate
 * All's AI path and the pipeline message stage.
 */
async function retryFallbackMessages(jobId, productPitch, tone) {
  const leads = listFallbackLeads(getDb());
  return runBulkGenerationJob(jobId, leads, tone, {
    label: "Retrying fallbacks via Gemini cascade (API → Web → template)",
    forceAi: true,
  });
}

module.exports = { generateAllMessages, retryFallbackMessages, runBulkGenerationJob };
