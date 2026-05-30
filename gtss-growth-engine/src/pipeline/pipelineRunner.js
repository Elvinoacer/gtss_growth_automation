/**
 * Pipeline Runner — Orchestrates all 4 stages sequentially
 *
 * Discovery → Qualification → Message Generation → Send
 *
 * Each stage is isolated — discovery failures are non-fatal,
 * qualification/message failures abort the pipeline.
 */

const { getDb } = require("../db/database");
const { stageMode, autoApproveVariant } = require("../config/pipelineConfig");
const { runDiscoveryStage } = require("./discoveryPipeline");
const { runQualificationStage } = require("../services/qualificationService");
const { runMessageStage } = require("../services/messageService");
const { runSendStage } = require("./sendPipeline");
const { sendNotification } = require("../services/notificationService");
const { getContext } = require("../services/contextService");
const logger = require("../utils/logger");

// ---------------------------------------------------------------------------
// Pipeline run tracking
// ---------------------------------------------------------------------------

/**
 * Create a new pipeline_runs record.
 * @param {string} triggerSource - 'cron' | 'manual' | 'api'
 * @returns {number} The pipeline run ID
 */
function createPipelineRun(triggerSource) {
  const db = getDb();
  const globalMode = stageMode("discovery"); // Just reads PIPELINE_MODE
  const result = db
    .prepare(
      `INSERT INTO pipeline_runs (trigger, mode, status, stages_json)
     VALUES (?, ?, 'running', '{}')`,
    )
    .run(triggerSource, globalMode);
  return result.lastInsertRowid;
}

/**
 * Update a pipeline run with per-stage results.
 */
function updatePipelineRun(runId, stageResults) {
  const db = getDb();
  const existing = db
    .prepare("SELECT stages_json FROM pipeline_runs WHERE id = ?")
    .get(runId);
  let stages = {};
  try {
    stages = JSON.parse(existing?.stages_json || "{}");
  } catch (_) {}

  Object.assign(stages, stageResults);

  db.prepare("UPDATE pipeline_runs SET stages_json = ? WHERE id = ?").run(
    JSON.stringify(stages),
    runId,
  );
}

/**
 * Finalise a pipeline run.
 */
function finalisePipelineRun(runId, status) {
  const db = getDb();
  db.prepare(
    "UPDATE pipeline_runs SET status = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run(status, runId);
}

// ---------------------------------------------------------------------------
// SSE event infrastructure for pipeline stream
// ---------------------------------------------------------------------------

const pipelineStreams = new Map();

function registerPipelineStream(runId, res) {
  const key = String(runId);
  if (!pipelineStreams.has(key)) pipelineStreams.set(key, new Set());
  pipelineStreams.get(key).add(res);

  res.write(`data: ${JSON.stringify({ type: "connected", runId })}\n\n`);

  res.on("close", () => {
    const streams = pipelineStreams.get(key);
    if (streams) {
      streams.delete(res);
      if (streams.size === 0) pipelineStreams.delete(key);
    }
  });
}

function buildPipelineEmitter(runId) {
  return (event) => {
    const key = String(runId);
    const payload = `data: ${JSON.stringify({ ...event, runId, timestamp: new Date().toISOString() })}\n\n`;

    const streams = pipelineStreams.get(key);
    if (streams) {
      streams.forEach((stream) => stream.write(payload));
    }

    // Also log significant events
    if (event.type === "error") {
      logger.error("PIPELINE", event.message || "Pipeline error", { runId });
    } else if (event.type === "stage" || event.type === "complete") {
      logger.info("PIPELINE", event.message || "", { runId });
    }
  };
}

function closePipelineStream(runId) {
  const key = String(runId);
  const streams = pipelineStreams.get(key);
  if (streams) {
    streams.forEach((s) => s.end());
    pipelineStreams.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Pipeline summary email
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full pipeline: Discovery → Qualification → Message Generation → Send
 *
 * @param {string} triggerSource - 'cron' | 'manual' | 'api'
 * @param {Object} [options] - Optional configuration
 * @param {string[]} [options.stages] - Subset of stages to run
 * @param {string} [options.mode] - Override the pipeline mode for this run
 * @returns {Promise<number>} The pipeline run ID
 */
async function runFullPipeline(triggerSource = "scheduled", options = {}) {
  // Optionally override PIPELINE_MODE for this run
  if (options.mode) {
    process.env.PIPELINE_MODE = options.mode;
  }

  const limits = options.limits || {};
  const maxLeadsPerKeyword = limits.max_leads_per_keyword;
  const maxDmsPerRun = limits.max_dms_per_run;

  const pipelineRunId = createPipelineRun(triggerSource);
  const emit = buildPipelineEmitter(pipelineRunId);

  const stagesToRun = options.stages || [
    "discovery",
    "qualification",
    "messages",
    "send",
  ];
  const globalMode = stageMode("discovery"); // reads PIPELINE_MODE

  emit({
    type: "start",
    message: `Pipeline started (mode: ${globalMode}, trigger: ${triggerSource}, stages: ${stagesToRun.join(", ")})`,
  });

  try {
    // ── Stage 1: Discovery ──────────────────────────────────────────────
    if (stagesToRun.includes("discovery")) {
      emit({ type: "stage", message: "Starting Stage 1: Lead Discovery" });
      try {
        const result = await runDiscoveryStage(pipelineRunId, emit, maxLeadsPerKeyword);
        emit({
          type: "stage_done",
          message: `Discovery: ${result.newLeads} new leads found across ${result.keywordsRun} keywords`,
        });
        updatePipelineRun(pipelineRunId, { discovery: result });
      } catch (err) {
        emit({
          type: "error",
          message: `Discovery stage failed: ${err.message} — continuing to qualification`,
        });
        // Non-fatal: there may be pre-existing leads to qualify
      }
    }

    // ── Stage 2: Qualification ──────────────────────────────────────────
    if (stagesToRun.includes("qualification")) {
      emit({ type: "stage", message: "Starting Stage 2: Lead Qualification" });
      try {
        const result = await runQualificationStage(pipelineRunId, emit);
        emit({
          type: "stage_done",
          message: `Qualification: ${result.qualified} qualified, ${result.deprioritized} deprioritized`,
        });
        updatePipelineRun(pipelineRunId, { qualification: result });
      } catch (err) {
        emit({
          type: "error",
          message: `Qualification stage failed: ${err.message} — aborting pipeline`,
        });
        finalisePipelineRun(pipelineRunId, "failed");
        closePipelineStream(pipelineRunId);
        await sendPipelineSummaryEmail(pipelineRunId);
        return pipelineRunId;
      }
    }

    // ── Stage 3: Message Generation ─────────────────────────────────────
    if (stagesToRun.includes("messages")) {
      emit({ type: "stage", message: "Starting Stage 3: Message Generation" });
      try {
        const result = await runMessageStage(pipelineRunId, emit);
        emit({
          type: "stage_done",
          message: `Messages: ${result.generated} generated, ${result.approved} auto-approved (variant ${autoApproveVariant()})`,
        });
        updatePipelineRun(pipelineRunId, { messages: result });
      } catch (err) {
        emit({
          type: "error",
          message: `Message generation failed: ${err.message} — aborting pipeline`,
        });
        finalisePipelineRun(pipelineRunId, "failed");
        closePipelineStream(pipelineRunId);
        await sendPipelineSummaryEmail(pipelineRunId);
        return pipelineRunId;
      }
    }

    // ── Stage 4: Send ───────────────────────────────────────────────────
    if (stagesToRun.includes("send")) {
      emit({ type: "stage", message: "Starting Stage 4: Send" });
      try {
        const result = await runSendStage(pipelineRunId, emit, maxDmsPerRun);
        emit({
          type: "stage_done",
          message: `Send: ${result.sent} sent, ${result.failed} failed, ${result.skipped} skipped`,
        });
        updatePipelineRun(pipelineRunId, { send: result });
      } catch (err) {
        emit({ type: "error", message: `Send stage failed: ${err.message}` });
      }
    }

    finalisePipelineRun(pipelineRunId, "completed");
    emit({
      type: "complete",
      message: "Pipeline finished. See dashboard for full summary.",
    });
  } catch (err) {
    logger.error("PIPELINE", "Unhandled pipeline error", {
      runId: pipelineRunId,
      error: err.message,
    });
    finalisePipelineRun(pipelineRunId, "failed");
    emit({ type: "error", message: `Pipeline failed: ${err.message}` });
  } finally {
    closePipelineStream(pipelineRunId);
    await sendPipelineSummaryEmail(pipelineRunId);
  }

  return pipelineRunId;
}

/**
 * Get details for a specific pipeline run.
 */
function getPipelineRun(runId) {
  const db = getDb();
  const run = db.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(runId);
  if (!run) return null;

  try {
    run.stages = JSON.parse(run.stages_json || "{}");
  } catch (_) {
    run.stages = {};
  }
  return run;
}

/**
 * List recent pipeline runs.
 */
function listPipelineRuns(limit = 20) {
  const db = getDb();
  return db
    .prepare("SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT ?")
    .all(limit)
    .map((run) => {
      try {
        run.stages = JSON.parse(run.stages_json || "{}");
      } catch (_) {
        run.stages = {};
      }
      return run;
    });
}

module.exports = {
  runFullPipeline,
  getPipelineRun,
  listPipelineRuns,
  registerPipelineStream,
  closePipelineStream,
};
