/**
 * massFollowPipeline/shared.js
 *
 * Constants and utility helpers shared by every split file in the
 * massFollowPipeline module:
 *   - MASS_FOLLOW_STAGES         The 3 pipeline stage names (select_targets / follow / report)
 *   - SUPPORTED_PLATFORMS        Set of platforms this pipeline knows how to follow on
 *   - buildEmitter(jobId)        Emit callback factory (logger + Socket.IO + pipelineLogger)
 *   - sleep(ms, executionId)     Pause-aware sleep that resolves early on abort
 *   - randomBetween(min, max)    Uniform random float in [min, max]
 *   - isWithinActiveWindow(p)    True if current hour is inside the platform's active window
 *
 * `isWithinActiveWindow` is exported from the index.js `_internal` block for tests.
 */

const logger = require("../../utils/logger");
const pipelineLogger = require("../../services/pipelineLogger");
const pipelineState = require("../../services/pipelineStateService");

const MASS_FOLLOW_STAGES = ["select_targets", "follow", "report"];

const SUPPORTED_PLATFORMS = new Set([
  "instagram",
  "x",
  "linkedin",
  "facebook",
]);

/**
 * Build an emit callback that mirrors events into the pipeline logger +
 * Socket.IO broadcast, matching the convention used by contentPipeline.js.
 */
function buildEmitter(jobId) {
  return (event) => {
    const stageLabel = event.stage || event.type || "event";
    const message = event.message || String(stageLabel);
    const level =
      event.level ||
      (String(stageLabel).toLowerCase() === "error" ? "error" : "info");
    logger.info("MASS-FOLLOW-PIPELINE", `[${jobId}] ${stageLabel}: ${message}`);
    try {
      const { broadcast } = require("../../services/socketService");
      broadcast("mass_follow_pipeline:event", { ...event, jobId });
    } catch (_) {}
    // Mirror into structured logs so the pipelines UI shows live progress.
    try {
      pipelineLogger.log({
        pipelineId: "mass_follow",
        executionId: jobId,
        level,
        stage: stageLabel,
        message,
        context: event.context || null,
      });
    } catch (_) {}
  };
}

function sleep(ms, executionId) {
  return new Promise((resolve) => {
    let elapsed = 0;
    const stepMs = 500;
    const tick = () => {
      // Honor Pause/Stop: if the user paused or aborted the pipeline,
      // resolve early so the runner can re-check pipelineState.
      if (executionId) {
        try {
          if (pipelineState.isAborted(executionId)) return resolve();
        } catch (_) {}
      }
      if (elapsed >= ms) return resolve();
      const wait = Math.min(stepMs, ms - elapsed);
      setTimeout(() => {
        elapsed += wait;
        tick();
      }, wait);
    };
    tick();
  });
}

function randomBetween(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.random() * (hi - lo);
}

function isWithinActiveWindow(policy) {
  if (!policy || !policy.activeWindow) return true;
  const currentHour = new Date().getHours();
  return (
    currentHour >= policy.activeWindow.startHour &&
    currentHour < policy.activeWindow.endHour
  );
}

module.exports = {
  MASS_FOLLOW_STAGES,
  SUPPORTED_PLATFORMS,
  buildEmitter,
  sleep,
  randomBetween,
  isWithinActiveWindow,
};
