/**
 * pipelineRunner/summaryEmail.js
 *
 * Send a per-run summary email/Slack notification when the pipeline finishes
 * (success OR failure OR abort — the orchestrator's finally block always
 * calls this). The notification body enumerates each completed stage's
 * metrics (new leads, qualified, generated, sent, etc.) parsed from the
 * run's stages_json column.
 */

const { getDb } = require("../../db/database");
const { sendNotification } = require("../../services/notificationService");
const { getContext } = require("../../services/contextService");
const logger = require("../../utils/logger");

/**
 * Build & send a summary notification for a finished pipeline run.
 *
 * Looks up the pipeline_runs row, parses its stages_json, formats a plain-
 * text summary line per stage, and dispatches it via sendNotification
 * (which fans out to email + Slack per the user's notification settings).
 *
 * Failures are logged and swallowed — a notification failure must never
 * mask the actual pipeline result that the caller is about to throw.
 */
async function sendPipelineSummaryEmail(runId) {
  const db = getDb();
  const run = db.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(runId);
  if (!run) return;

  const ctx = getContext();

  let stages = {};
  try {
    stages = JSON.parse(run.stages_json || "{}");
  } catch (_) {}

  const lines = [
    `${ctx.ctx_biz_name} Pipeline Run #${runId} — ${run.status.toUpperCase()}`,
    `Trigger: ${run.trigger} | Mode: ${run.mode}`,
    `Started: ${run.started_at} | Finished: ${run.finished_at || "N/A"}`,
    "",
    "── Stage Results ──",
  ];

  if (stages.discovery) {
    const d = stages.discovery;
    lines.push(
      `Discovery: ${d.newLeads || 0} new leads, ${d.keywordsRun || 0} keywords, ${d.skipped || 0} skipped`,
    );
  }
  if (stages.qualification) {
    const q = stages.qualification;
    lines.push(
      `Qualification: ${q.qualified || 0} qualified, ${q.deprioritized || 0} deprioritized`,
    );
  }
  if (stages.messages) {
    const m = stages.messages;
    lines.push(
      `Messages: ${m.generated || 0} generated, ${m.approved || 0} auto-approved`,
    );
  }
  if (stages.send) {
    const s = stages.send;
    lines.push(
      `Send: ${s.sent || 0} sent, ${s.failed || 0} failed, ${s.skipped || 0} skipped`,
    );
  }

  try {
    await sendNotification(
      `${ctx.ctx_biz_name} Pipeline ${run.status === "completed" ? "✓" : "✗"} Run #${runId}`,
      lines.join("\n"),
    );
  } catch (err) {
    logger.warn("PIPELINE", "Failed to send summary email", {
      error: err.message,
    });
  }
}

module.exports = { sendPipelineSummaryEmail };
