/**
 * Scheduler Service — SSE Job Stream Infrastructure
 * registerJobStream, emitJobEvent, closeJobStream — Server-Sent-Events
 * plumbing that mirrors messageService's pattern: each long-running
 * publishPost job opens an SSE stream on /api/scheduler/:jobId/stream,
 * events are buffered per-job (last 200) so a reconnecting client
 * catches up, and every event is also broadcast via Socket.IO.
 * Extracted from the original schedulerService.js for maintainability.
 */

// ---------------------------------------------------------------------------
// SSE infrastructure (mirrors messageService pattern)
// ---------------------------------------------------------------------------

const jobStreams = new Map();
const jobEventHistory = new Map();

function registerJobStream(jobId, res) {
  const key = String(jobId);
  if (!jobStreams.has(key)) jobStreams.set(key, new Set());

  jobStreams.get(key).add(res);
  res.write(`data: ${JSON.stringify({ type: "connected", jobId })}\n\n`);
  (jobEventHistory.get(key) || []).forEach((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  res.on("close", () => {
    const streams = jobStreams.get(key);
    if (!streams) return;
    streams.delete(res);
    if (streams.size === 0) jobStreams.delete(key);
  });
}

function emitJobEvent(jobId, event) {
  const key = String(jobId);
  const history = jobEventHistory.get(key) || [];
  history.push(event);
  jobEventHistory.set(key, history.slice(-200));

  // Broadcast via Socket.IO
  const { broadcast } = require("../socketService");
  broadcast("scheduler:event", event);

  // Legacy SSE
  const streams = jobStreams.get(key);
  if (!streams || streams.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  streams.forEach((stream) => stream.write(payload));
}

function closeJobStream(jobId) {
  const key = String(jobId);
  const streams = jobStreams.get(key);
  if (streams) {
    streams.forEach((s) => s.end());
    jobStreams.delete(key);
  }
  setTimeout(() => jobEventHistory.delete(key), 5 * 60 * 1000);
}

module.exports = {
  jobStreams,
  jobEventHistory,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
};
