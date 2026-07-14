/**
 * pipelineRunner/pipelineStream.js
 *
 * SSE event-stream infrastructure for a single pipeline run.
 *
 * - pipelineStreams: Map of runId -> Set<ServerResponse>. Each open SSE
 *   response is registered here so buildPipelineEmitter can fan-out every
 *   event to every connected UI tab.
 * - registerPipelineStream: add a new SSE response (writes the initial
 *   "connected" event, removes the response from the Set on close so we
 *   don't leak memory on long-lived dashboard tabs).
 * - buildPipelineEmitter: returns an emit(event) function that
 *   (a) enriches the event with runId + ISO timestamp,
 *   (b) broadcasts via Socket.IO (so any subscribed web client receives it),
 *   (c) writes the SSE payload to every registered stream for this run,
 *   (d) logs significant events to the logger + DB logger with a resolved
 *       log level (error/warn/retry/info) derived from event.type/stage.
 * - closePipelineStream: ends every SSE response for a run and clears the
 *   Set (called from the orchestrator's finally block).
 */

const logger = require("../../utils/logger");
const { broadcast } = require("../../services/socketService");

const pipelineStreams = new Map();

/**
 * Register a new SSE response for a pipeline run. Sends the initial
 * "connected" event so the client knows the stream is live, and removes
 * the response from the Set on close so we don't leak memory.
 */
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

/**
 * Resolve a log level from a raw event: 'error'/'failed' stage -> error,
 * 'warn'/'warning' type -> warn, 'retry' type/stage -> retry, else info.
 */
function resolveLevel(event) {
  const type = String(event.type || "").toLowerCase();
  const stage = String(event.stage || "").toLowerCase();
  if (type === "error" || stage === "error" || stage === "failed")
    return "error";
  if (type === "warn" || type === "warning") return "warn";
  if (type === "retry" || stage === "retry") return "retry";
  return "info";
}

/**
 * Build an emit(event) function that fans the event out to:
 *  - Socket.IO (broadcast) for any web client subscribed to pipeline:event
 *  - every registered SSE stream for this runId
 *  - the logger + DB logger with a resolved log level
 */
function buildPipelineEmitter(runId) {
  return (event) => {
    const key = String(runId);
    const enriched = { ...event, runId, timestamp: new Date().toISOString() };
    const payload = `data: ${JSON.stringify(enriched)}\n\n`;

    broadcast("pipeline:event", enriched);

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

    const stageLabel = event.stage || event.type || "event";
    const message = event.message || String(stageLabel);
    const level = resolveLevel(event);
    logger.db(level, "outreach", stageLabel, message, {
      jobId: runId,
      eventType: event.type,
      stage: event.stage,
    });
  };
}

/**
 * End every SSE response for a run and remove the Set from the Map.
 * Called from the orchestrator's finally block so connected clients know
 * the stream is closed and don't keep a half-open connection open.
 */
function closePipelineStream(runId) {
  const key = String(runId);
  const streams = pipelineStreams.get(key);
  if (streams) {
    streams.forEach((s) => s.end());
    pipelineStreams.delete(key);
  }
}

module.exports = {
  pipelineStreams,
  registerPipelineStream,
  buildPipelineEmitter,
  closePipelineStream,
};
