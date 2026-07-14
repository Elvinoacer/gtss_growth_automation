/**
 * messageService/runMessageStage.js
 *
 * Pipeline entry point for the message-generation stage (called by
 * pipelineRunner.runFullPipelineNow's Stage 3).
 *
 * Flow:
 *   1. SELECT every qualified lead with no approved message (filtered by
 *      the optional `platforms` arg if the pipeline was launched with a
 *      subset of platforms).
 *   2. For each lead:
 *      a. Check isPipelineAborted(jobId) — deferred-require from
 *         pipelineRunner so we don't create a require-cycle at module
 *         load time. If aborted, return early with the partial counts.
 *      b. Dispatch to generateFromTemplate (manual mode or 'template'
 *         source) or generateMessages (AI mode — generateViaAI handles
 *         its own template fallback on Gemini failure).
 *      c. Auto-approve the configured variant (default B) — UPDATE
 *         messages SET status='approved' WHERE lead_id=? AND variant=?
 *         AND status='pending'. If the UPDATE touched >0 rows, also
 *         UPDATE leads SET status='message_approved' so the send stage
 *         picks them up.
 *      d. Emit a "generated" event with the variant body preview +
 *         autoApproved flag.
 *      e. Sleep BATCH_DELAY_MS every BATCH_SIZE leads.
 *   3. Emit a final "complete" event with the { generated, approved } summary.
 *
 * Returns { generated, approved }.
 */

const { getDb } = require("../../db/database");
const {
  stageMode,
  autoApproveVariant,
  messageGenerationSource,
} = require("../../config/pipelineConfig");
const { BATCH_SIZE, BATCH_DELAY_MS } = require("./sseInfrastructure");
const { generateFromTemplate } = require("./generateFromTemplate");
const { generateMessages } = require("./generateMessages");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the message generation stage for the pipeline.
 * Generates messages for all qualified leads that don't yet have an approved message.
 * Auto-approves the configured variant (default: B).
 *
 * @param {string|number} jobId - Pipeline run ID for event tracking
 * @param {Function} emit - Event emitter function
 * @returns {Promise<{generated: number, approved: number}>}
 */
async function runMessageStage(jobId, emit, platforms = []) {
  const db = getDb();
  const mode = stageMode("message");
  const source = messageGenerationSource();
  const variant = autoApproveVariant();
  const selectedPlatforms = Array.isArray(platforms)
    ? platforms.map((platform) => String(platform).trim().toLowerCase()).filter(Boolean)
    : [];
  const platformClause =
    selectedPlatforms.length > 0
      ? `AND l.platform IN (${selectedPlatforms.map(() => "?").join(",")})`
      : "";

  // Get all qualified leads that don't yet have an approved message
  const leads = db
    .prepare(
      `
    SELECT l.* FROM leads l
    LEFT JOIN messages m ON m.lead_id = l.id AND m.status = 'approved'
    WHERE l.status = 'qualified' AND m.id IS NULL
    ${platformClause}
    ORDER BY l.lead_score DESC
  `,
    )
    .all(...selectedPlatforms);

  if (leads.length === 0) {
    emit({ type: "info", message: "No qualified leads need messages" });
    return { generated: 0, approved: 0 };
  }

  let generated = 0;
  let approved = 0;

  emit({
    type: "info",
    message: `Generating messages for ${leads.length} leads (source: ${source}, mode: ${mode}, auto-approve: variant ${variant})`,
  });

  for (let i = 0; i < leads.length; i++) {
    // Deferred require to avoid a load-time cycle: pipelineRunner →
    // messageService → pipelineRunner. The require is cached after the
    // first call, so subsequent iterations are cheap.
    const { isPipelineAborted } = require("../../pipeline/pipelineRunner");
    if (isPipelineAborted(jobId)) {
      emit({ type: "warn", message: "Message generation aborted by pipeline abort signal." });
      return { generated, approved };
    }

    const lead = leads[i];
    emit({
      type: "progress",
      message: `Generating message for ${lead.name || lead.id}...`,
      processed: i,
      total: leads.length,
    });

    try {
      let result;
      // Source dispatch: 'ai' (default) → generateViaAI, 'template' →
      // generateFromTemplate. The old `mode === 'manual'` branch is kept
      // only as an additional escape hatch — when both are set, manual
      // mode wins so the operator can force templates even if the source
      // says 'ai'.
      if (mode === "manual" || source === "template") {
        result = generateFromTemplate(lead);
      } else {
        // AI mode — generateViaAI handles its own template fallback on
        // Gemini failure, so this never deadlocks.
        result = await generateMessages(lead.id, lead.platform);
      }

      generated++;

      // Auto-approve configured variant
      const updated = db
        .prepare(
          `
        UPDATE messages
        SET status = 'approved',
            approved_by = 'pipeline-auto',
            approved_at = CURRENT_TIMESTAMP
        WHERE lead_id = ? AND variant = ? AND status = 'pending'
      `,
        )
        .run(lead.id, variant);

      if (updated.changes > 0) {
        db.prepare(
          "UPDATE leads SET status = 'message_approved', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'qualified'",
        ).run(lead.id);
        approved++;
        emit({
          type: "generated",
          leadId: lead.id,
          name: lead.name,
          autoApproved: variant,
          variantA: result.variantA.body.slice(0, 60),
          variantB: result.variantB.body.slice(0, 60),
        });
      }
    } catch (err) {
      emit({
        type: "warn",
        message: `Failed for ${lead.name || lead.id}: ${err.message}`,
      });
    }

    // Batch delay every BATCH_SIZE leads
    if ((i + 1) % BATCH_SIZE === 0 && i + 1 < leads.length) {
      await delay(BATCH_DELAY_MS);
    }
  }

  emit({
    type: "complete",
    message: `Generated ${generated} messages, ${approved} auto-approved as variant ${variant}`,
  });

  return { generated, approved };
}

module.exports = { runMessageStage };
