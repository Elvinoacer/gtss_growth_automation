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
const {
  needsAiMessageSql,
  retireTemplateMessages,
  isAiGeneratedBy,
} = require("./retireTemplateMessages");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the message generation stage for the pipeline.
 * Generates messages for all qualified leads that don't yet have a real
 * AI (or non-template) approved message. Auto-approves the configured
 * variant (default: B) — never auto-approves template-fallback.
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

  // Qualified leads without a real AI body yet. Template-only drafts do
  // not block re-generation — they are emergency fallbacks only.
  const leads = db
    .prepare(
      `
    SELECT l.* FROM leads l
    WHERE l.status = 'qualified'
      AND ${needsAiMessageSql("l")}
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
        // Drop stale template drafts before Gemini so bulk-approve and
        // the Automation queue only see the AI body.
        retireTemplateMessages(db, {
          leadId: lead.id,
          platform: lead.platform || null,
        });
        // AI mode — generateViaAI handles its own template fallback on
        // Gemini failure, so this never deadlocks.
        result = await generateMessages(lead.id, lead.platform);
      }

      generated++;

      // Auto-approve configured variant — never template-fallback, and
      // never plain template unless the operator forced template mode.
      const updated = db
        .prepare(
          `
        UPDATE messages
        SET status = 'approved',
            approved_by = 'pipeline-auto',
            approved_at = CURRENT_TIMESTAMP
        WHERE lead_id = ?
          AND variant = ?
          AND status = 'pending'
          AND COALESCE(generated_by, '') NOT IN ('template-fallback'
            ${mode === "manual" || source === "template" ? "" : ", 'template'"})
      `,
        )
        .run(lead.id, variant);

      if (updated.changes > 0) {
        // Retire any remaining template rows and older approvals for this
        // lead so the DM queue pins the AI body that was just approved.
        const approvedRow = db
          .prepare(
            `SELECT id, platform, generated_by FROM messages
             WHERE lead_id = ? AND variant = ? AND status = 'approved'
             ORDER BY approved_at DESC, id DESC LIMIT 1`,
          )
          .get(lead.id, variant);

        if (approvedRow) {
          if (isAiGeneratedBy(approvedRow.generated_by)) {
            retireTemplateMessages(db, {
              leadId: lead.id,
              platform: approvedRow.platform || lead.platform || null,
              keepIds: [approvedRow.id],
            });
          }
          db.prepare(
            `UPDATE messages
             SET status = 'skipped'
             WHERE lead_id = ?
               AND COALESCE(platform, '') = COALESCE(?, '')
               AND COALESCE(is_follow_up, 0) = 0
               AND id != ?
               AND status = 'approved'`,
          ).run(lead.id, approvedRow.platform || lead.platform || null, approvedRow.id);
        }

        db.prepare(
          "UPDATE leads SET status = 'message_approved', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'qualified'",
        ).run(lead.id);
        approved++;
        emit({
          type: "generated",
          leadId: lead.id,
          name: lead.name,
          autoApproved: variant,
          generatedBy: result.generatedBy || approvedRow?.generated_by || null,
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
