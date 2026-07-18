/**
 * pipelineRunner/runFullPipeline.js
 *
 * The outreach pipeline orchestrator. Two public functions:
 *
 *  - runFullPipelineNow(triggerSource, options): the actual 4-stage run
 *    (Discovery → Qualification → Messages → Send). Handles stage-by-stage
 *    checkpointing, abort signals, pause/resume between stages, retry on
 *    failure (per-stage withRetry), and a finally-block summary email +
 *    SSE stream close + jobRegistry finishJob.
 *
 *  - runFullPipeline(triggerSource, options): thin wrapper that enqueues
 *    runFullPipelineNow via the pipeline queue so concurrent triggers (a
 *    manual run while a cron run is mid-flight) don't overlap.
 *
 * Stage isolation rules (preserved from the original):
 *  - Discovery failures are NON-FATAL — we keep going to Qualification
 *    because there may be pre-existing discovered leads to qualify.
 *  - Qualification / Message failures ABORT the pipeline (the run is
 *    finalised as 'failed' and the error is re-thrown so the caller knows).
 *  - Send failures are logged but the run is still finalised as 'completed'
 *    (the messages were generated and approved — they'll be picked up by
 *    the next send cycle).
 */

const { getDb } = require("../../db/database");
const { stageMode, autoApproveVariant } = require("../../config/pipelineConfig");
const { runDiscoveryStage } = require("../discoveryPipeline");
const { runQualificationStage } = require("../../services/qualificationService");
const { runMessageStage } = require("../../services/messageService");
const { runSendStage } = require("../sendPipeline");
const { getContext } = require("../../services/contextService");
const { logActivity } = require("../../services/auditService");
const jobRegistry = require("../../jobs/jobRegistry");
const logger = require("../../utils/logger");
const { enqueuePipelineRun } = require("../pipelineQueue");
const pipelineState = require("../../services/pipelineStateService");
const pipelineLogger = require("../../services/pipelineLogger");
const checkpointService = require("../../services/pipelineCheckpoint");

const {
  createPipelineRun,
  updatePipelineRun,
  finalisePipelineRun,
  isPaused,
  throwIfAborted,
  runStageWithRetry,
} = require("./pipelineRunTracking");
const {
  PIPELINE_ABORT_FLAGS,
  PIPELINE_PAUSE_FLAGS,
  isPipelineAborted,
  awaitResume,
} = require("./state");
const {
  buildPipelineEmitter,
  closePipelineStream,
} = require("./pipelineStream");
const { sendPipelineSummaryEmail } = require("./summaryEmail");

/**
 * Run the full pipeline: Discovery → Qualification → Message Generation → Send
 *
 * @param {string} triggerSource - 'cron' | 'manual' | 'api'
 * @param {Object} [options] - Optional configuration
 * @param {string[]} [options.stages] - Subset of stages to run
 * @param {string} [options.mode] - Override the pipeline mode for this run
 * @returns {Promise<number>} The pipeline run ID
 */
async function runFullPipelineNow(triggerSource = "scheduled", options = {}) {
  // Optionally override PIPELINE_MODE for this run
  if (options.mode) {
    process.env.PIPELINE_MODE = options.mode;
  }

  const limits = options.limits || {};
  const maxLeadsPerKeyword = limits.max_leads_per_keyword;
  const maxDmsPerRun = limits.max_dms_per_run;
  const maxConnectionsPerRun = limits.max_connections_per_run;
  const {
    filterOutreachPlatforms,
  } = require("../../config/pipelineConfig");
  const selectedPlatforms = filterOutreachPlatforms(
    Array.isArray(limits.platforms)
      ? limits.platforms
          .map((platform) => String(platform).trim().toLowerCase())
          .filter(Boolean)
      : [],
  );

  const pipelineRunId = createPipelineRun(triggerSource);
  if (typeof options.onRunId === "function") options.onRunId(pipelineRunId);
  PIPELINE_ABORT_FLAGS.delete(String(pipelineRunId));
  PIPELINE_PAUSE_FLAGS.set(String(pipelineRunId), "running");
  const emit = buildPipelineEmitter(pipelineRunId);
  const controller =
    options.signal || options.abortController
      ? { signal: options.signal || options.abortController.signal }
      : jobRegistry.startJob(pipelineRunId, { pipelineId: "outreach", type: "outreach" });
  const signal = controller.signal;

  // ── Lifecycle bridge: link the legacy runId to the new state service ──
  // If an executionId was provided (from the new pipelineStateService),
  // use it for pause/abort checks and checkpoint saves. Otherwise fall back
  // to the legacy in-memory flags keyed by pipelineRunId.
  const executionId = options.executionId || String(pipelineRunId);
  const lifecycleEmit = (event) => {
    try { emit(event); } catch (_) {}
    try {
      if (event.message) {
        pipelineState.updateExecutionProgress(executionId, {
          stage: event.stage || event.type || null,
          message: event.message,
        });
      }
    } catch (_) {}
  };

  const stagesToRun = options.stages || [
    "discovery",
    "qualification",
    "messages",
    "send",
  ];

  // Resume-from-checkpoint support: if resumeFrom is set, skip stages that
  // already have a 'completed' checkpoint for this execution.
  let effectiveStages = stagesToRun;
  if (options.resumeFrom) {
    const resumeStage = options.resumeFrom;
    const idx = stagesToRun.indexOf(resumeStage);
    if (idx >= 0) {
      effectiveStages = stagesToRun.slice(idx);
      emit({
        type: "info",
        message: `Resuming from checkpoint at stage "${resumeStage}" — skipping earlier stages.`,
      });
      pipelineLogger.log({
        pipelineId: "outreach",
        executionId,
        level: "info",
        stage: "resume",
        message: `Resuming from stage "${resumeStage}"`,
        context: { resumeFrom: resumeStage, skippedStages: stagesToRun.slice(0, idx) },
      });
    }
  } else {
    // Even without explicit resumeFrom, skip stages that already completed
    // for this execution (e.g. after a retry-stage call).
    const completedStages = new Set(
      checkpointService
        .getCheckpoints(executionId)
        .filter((c) => c.status === "completed")
        .map((c) => c.stage),
    );
    if (completedStages.size > 0) {
      effectiveStages = stagesToRun.filter((s) => !completedStages.has(s));
      if (effectiveStages.length < stagesToRun.length) {
        emit({
          type: "info",
          message: `Skipping ${stagesToRun.length - effectiveStages.length} already-completed stage(s): ${stagesToRun.filter((s) => completedStages.has(s)).join(", ")}`,
        });
      }
    }
  }

  const globalMode = stageMode("discovery"); // reads PIPELINE_MODE

  emit({
    type: "start",
    message: `Pipeline started (mode: ${globalMode}, trigger: ${triggerSource}, stages: ${stagesToRun.join(", ")}${selectedPlatforms.length ? `, platforms: ${selectedPlatforms.join(", ")}` : ""})`,
  });
  logActivity({
    activityType: "pipeline_run",
    entityType: "pipeline",
    entityId: pipelineRunId,
    actor: triggerSource,
    status: "running",
    summary: `Outreach pipeline #${pipelineRunId} started`,
    details: { stages: stagesToRun, limits, keywords: options.keywords || [], platforms: selectedPlatforms },
  });

  try {
    if (isPaused("outreach") || pipelineState.isPaused(executionId)) {
      emit({ type: "warn", message: "Outreach pipeline is paused; run skipped" });
      finalisePipelineRun(pipelineRunId, "skipped");
      return pipelineRunId;
    }
    // ── Stage 1: Discovery ──────────────────────────────────────────────
    if (effectiveStages.includes("discovery")) {
      throwIfAborted(signal, pipelineRunId);
      pipelineState.throwIfAborted(executionId);
      pipelineState.updateExecutionProgress(executionId, { stage: "discovery", message: "Starting Stage 1: Lead Discovery", progress: 5 });
      emit({ type: "stage", message: "Starting Stage 1: Lead Discovery" });
      try {
        const result = await runStageWithRetry(
          "discovery",
          "outreach",
          pipelineRunId,
          emit,
          () =>
            runDiscoveryStage(
              pipelineRunId,
              emit,
              maxLeadsPerKeyword,
              options.keywords,
              selectedPlatforms,
            ),
          signal,
        );
        emit({
          type: "stage_done",
          message: `Discovery: ${result.newLeads} new leads found across ${result.keywordsRun} keywords`,
        });
        updatePipelineRun(pipelineRunId, { discovery: result });
        checkpointService.saveCheckpoint({
          executionId, pipelineId: "outreach", stage: "discovery",
          status: "completed", payload: result,
        });
        pipelineState.updateExecutionProgress(executionId, { stage: "discovery", message: `Discovery complete: ${result.newLeads} new leads`, progress: 25, completedSteps: 1 });
      } catch (err) {
        checkpointService.saveCheckpoint({
          executionId, pipelineId: "outreach", stage: "discovery",
          status: "failed", error: err, payload: { errorMessage: err.message },
        });
        emit({
          type: "error",
          message: `Discovery stage failed: ${err.message} — continuing to qualification`,
        });
        // Non-fatal: there may be pre-existing leads to qualify
      }
    } else {
      pipelineState.updateExecutionProgress(executionId, { stage: "discovery", message: "Discovery: skipped (already complete or not in scope)", progress: 25, completedSteps: (pipelineState.getExecutionState(executionId)?.completed_steps || 0) + 1 });
    }

    if (!(await awaitResume(pipelineRunId, emit)) || !(await pipelineState.awaitResume(executionId, emit))) {
      emit({ type: "warn", message: "Pipeline aborted by user." });
      finalisePipelineRun(pipelineRunId, "aborted");
      return pipelineRunId;
    }

    // ── Stage 2: Qualification ──────────────────────────────────────────
    if (effectiveStages.includes("qualification")) {
      throwIfAborted(signal, pipelineRunId);
      pipelineState.throwIfAborted(executionId);
      pipelineState.updateExecutionProgress(executionId, { stage: "qualification", message: "Starting Stage 2: Lead Qualification", progress: 30 });
      emit({ type: "stage", message: "Starting Stage 2: Lead Qualification" });
      try {
        const result = await runStageWithRetry(
          "qualification",
          "outreach",
          pipelineRunId,
          emit,
          () => runQualificationStage(pipelineRunId, emit, selectedPlatforms),
          signal,
        );
        emit({
          type: "stage_done",
          message: `Qualification: ${result.qualified} qualified, ${result.deprioritized} deprioritized`,
        });
        updatePipelineRun(pipelineRunId, { qualification: result });
        checkpointService.saveCheckpoint({
          executionId, pipelineId: "outreach", stage: "qualification",
          status: "completed", payload: result,
        });
        pipelineState.updateExecutionProgress(executionId, { stage: "qualification", message: `Qualification complete: ${result.qualified} qualified`, progress: 50, completedSteps: 2 });
      } catch (err) {
        checkpointService.saveCheckpoint({
          executionId, pipelineId: "outreach", stage: "qualification",
          status: "failed", error: err, payload: { errorMessage: err.message },
        });
        err.failedStage = "qualification";
        emit({
          type: "error",
          message: `Qualification stage failed: ${err.message} — aborting pipeline`,
        });
        finalisePipelineRun(pipelineRunId, "failed");
        closePipelineStream(pipelineRunId);
        await sendPipelineSummaryEmail(pipelineRunId);
        throw err;
      }
    }

    if (!(await awaitResume(pipelineRunId, emit)) || !(await pipelineState.awaitResume(executionId, emit))) {
      emit({ type: "warn", message: "Pipeline aborted by user." });
      finalisePipelineRun(pipelineRunId, "aborted");
      return pipelineRunId;
    }

    // ── Stage 3: Message Generation ─────────────────────────────────────
    if (effectiveStages.includes("messages")) {
      throwIfAborted(signal, pipelineRunId);
      pipelineState.throwIfAborted(executionId);
      pipelineState.updateExecutionProgress(executionId, { stage: "messages", message: "Starting Stage 3: Message Generation", progress: 55 });
      emit({ type: "stage", message: "Starting Stage 3: Message Generation" });
      try {
        const result = await runStageWithRetry(
          "messages",
          "outreach",
          pipelineRunId,
          emit,
          () => runMessageStage(pipelineRunId, emit, selectedPlatforms),
          signal,
        );
        emit({
          type: "stage_done",
          message: `Messages: ${result.generated} generated, ${result.approved} auto-approved (variant ${autoApproveVariant()})`,
        });
        updatePipelineRun(pipelineRunId, { messages: result });
        checkpointService.saveCheckpoint({
          executionId, pipelineId: "outreach", stage: "messages",
          status: "completed", payload: result,
        });
        pipelineState.updateExecutionProgress(executionId, { stage: "messages", message: `Messages complete: ${result.generated} generated`, progress: 75, completedSteps: 3 });
      } catch (err) {
        checkpointService.saveCheckpoint({
          executionId, pipelineId: "outreach", stage: "messages",
          status: "failed", error: err, payload: { errorMessage: err.message },
        });
        err.failedStage = "messages";
        emit({
          type: "error",
          message: `Message generation failed: ${err.message} — aborting pipeline`,
        });
        finalisePipelineRun(pipelineRunId, "failed");
        closePipelineStream(pipelineRunId);
        await sendPipelineSummaryEmail(pipelineRunId);
        throw err;
      }
    }

    if (!(await awaitResume(pipelineRunId, emit)) || !(await pipelineState.awaitResume(executionId, emit))) {
      emit({ type: "warn", message: "Pipeline aborted by user." });
      finalisePipelineRun(pipelineRunId, "aborted");
      return pipelineRunId;
    }

    // ── Stage 4: Send ───────────────────────────────────────────────────
    if (effectiveStages.includes("send")) {
      throwIfAborted(signal, pipelineRunId);
      pipelineState.throwIfAborted(executionId);
      pipelineState.updateExecutionProgress(executionId, { stage: "send", message: "Starting Stage 4: Send", progress: 80 });
      emit({ type: "stage", message: "Starting Stage 4: Send" });
      try {
        const result = await runStageWithRetry(
          "send",
          "outreach",
          pipelineRunId,
          emit,
          () =>
            runSendStage(
              pipelineRunId,
              emit,
              maxDmsPerRun,
              selectedPlatforms,
              maxConnectionsPerRun,
            ),
          signal,
        );
        emit({
          type: "stage_done",
          message: `Send: ${result.sent} sent, ${result.failed} failed, ${result.skipped} skipped`,
        });
        updatePipelineRun(pipelineRunId, { send: result });
        checkpointService.saveCheckpoint({
          executionId, pipelineId: "outreach", stage: "send",
          status: "completed", payload: result,
        });
        pipelineState.updateExecutionProgress(executionId, { stage: "send", message: `Send complete: ${result.sent} sent`, progress: 100, completedSteps: 4 });
      } catch (err) {
        checkpointService.saveCheckpoint({
          executionId, pipelineId: "outreach", stage: "send",
          status: "failed", error: err, payload: { errorMessage: err.message },
        });
        err.failedStage = "send";
        emit({ type: "error", message: `Send stage failed: ${err.message}` });
      }
    }

    finalisePipelineRun(pipelineRunId, "completed");
    emit({
      type: "complete",
      message: "Pipeline finished. See dashboard for full summary.",
    });
    logActivity({
      activityType: "pipeline_run",
      entityType: "pipeline",
      entityId: pipelineRunId,
      actor: triggerSource,
      status: "success",
      summary: `Outreach pipeline #${pipelineRunId} completed`,
    });
  } catch (err) {
    logger.error("PIPELINE", "Unhandled pipeline error", {
      runId: pipelineRunId,
      error: err.message,
    });
    const aborted = isPipelineAborted(pipelineRunId) || pipelineState.isAborted(executionId);
    finalisePipelineRun(pipelineRunId, aborted ? "aborted" : "failed");
    emit({ type: aborted ? "warn" : "error", message: `Pipeline ${aborted ? "aborted" : "failed"}: ${err.message}` });
    logActivity({
      activityType: "pipeline_run",
      entityType: "pipeline",
      entityId: pipelineRunId,
      actor: triggerSource,
      status: aborted ? "skipped" : "failure",
      summary: `Outreach pipeline #${pipelineRunId} ${aborted ? "aborted" : "failed"}`,
      details: { error: err.message, failedStage: err.failedStage || null },
    });
    // ALWAYS mark the execution as failed (or let markExecutionFailed
    // no-op if the execution is already STOPPED — which is the correct
    // behavior when the user clicked Stop and the abort propagated up
    // as a thrown error). The previous code only marked failed if
    // err.failedStage was set, which left the execution stuck in
    // 'running' state when the runner threw without a failedStage
    // (e.g., an abort signal thrown by throwIfAborted).
    try {
      pipelineState.markExecutionFailed(executionId, err, err.failedStage || null);
    } catch (_) {}
    throw err;
  } finally {
    jobRegistry.finishJob(pipelineRunId);
    closePipelineStream(pipelineRunId);
    await sendPipelineSummaryEmail(pipelineRunId);
  }

  return pipelineRunId;
}


async function runFullPipeline(triggerSource = "scheduled", options = {}) {
  return enqueuePipelineRun(
    "outreach",
    `outreach:${triggerSource}:${Date.now()}`,
    () => runFullPipelineNow(triggerSource, options),
    {
      onQueued: ({ position, activeRun }) => {
        logger.info(
          "PIPELINE",
          `Outreach pipeline queued at position ${position}; waiting for active run to finish`,
          { activeRun },
        );
      },
    },
  );
}

module.exports = { runFullPipelineNow, runFullPipeline };
