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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateAllMessages(jobId, productPitch, tone) {
  const db = getDb();
  const emit = (event) => emitJobEvent(jobId, { ...event, jobId });

  db.prepare(
    `INSERT INTO message_generation_jobs (id, status, started_at)
     VALUES (?, 'RUNNING', CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       status = 'RUNNING',
       started_at = CURRENT_TIMESTAMP,
       completed_at = NULL`,
  ).run(String(jobId));

  let finalStatus = "FAILED";

  const qualifiedLeads = db
    .prepare(
      `SELECT l.* FROM leads l
     WHERE l.status = 'qualified'
       AND NOT EXISTS (
         SELECT 1 FROM messages m
         WHERE m.lead_id = l.id AND m.status IN ('pending', 'approved')
       )
     ORDER BY l.lead_score DESC`,
    )
    .all();

  const total = qualifiedLeads.length;
  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  emit({
    type: "info",
    message: `Generating messages for ${total} qualified leads`,
  });

  try {
    for (let i = 0; i < qualifiedLeads.length; i += BATCH_SIZE) {
      const batch = qualifiedLeads.slice(i, i + BATCH_SIZE);

      for (const lead of batch) {
        try {
          const result = await generateMessages(
            lead.id,
            lead.platform,
            null,
            tone,
          );
          succeeded++;
          emit({
            type: "generated",
            leadId: lead.id,
            name: lead.name,
            variantA: result.variantA.body.slice(0, 60),
            variantB: result.variantB.body.slice(0, 60),
          });
        } catch (err) {
          failed++;
          emit({ type: "error", leadId: lead.id, message: err.message });
        }
        processed++;
        emit({ type: "progress", processed, total });
      }
      if (i + BATCH_SIZE < qualifiedLeads.length) await delay(BATCH_DELAY_MS);
    }
    const summary = { processed, succeeded, failed };
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

module.exports = { generateAllMessages };
