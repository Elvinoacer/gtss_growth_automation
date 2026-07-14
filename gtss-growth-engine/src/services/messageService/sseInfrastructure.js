/**
 * messageService/sseInfrastructure.js
 *
 * SSE event-stream infrastructure for message-generation jobs (mirrors the
 * qualificationService pattern): per-jobId Set<ServerResponse> for fan-out,
 * a 200-event rolling history per job so a UI tab that connects late
 * still sees recent events, and Socket.IO broadcast on every emit so any
 * subscribed web client receives the event too.
 *
 * - registerJobStream(jobId, res): add a new SSE response, send the
 *   initial "connected" event, replay the rolling history to the new
 *   client, remove the response from the Set on close.
 * - emitJobEvent(jobId, event): broadcast an event to Socket.IO AND every
 *   registered SSE stream for this job. Pushes the event onto the rolling
 *   history (capped at 200).
 * - closeJobStream(jobId): end every SSE response for a job and schedule
 *   the rolling history to be deleted 5 minutes later (so a UI tab that
 *   reconnects shortly after the job finishes still sees the final
 *   events, but we don't leak memory forever).
 *
 * Also exports the BATCH_SIZE / BATCH_DELAY_MS constants used by the
 * batched generateAllMessages / runMessageStage loops (process BATCH_SIZE
 * leads, then sleep BATCH_DELAY_MS before the next batch to avoid
 * hammering Gemini and to spread the database writes out).
 */

const jobStreams = new Map();
const jobEventHistory = new Map();
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 2500;

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
  broadcast("messages:event", event);

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
  BATCH_SIZE,
  BATCH_DELAY_MS,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
};
