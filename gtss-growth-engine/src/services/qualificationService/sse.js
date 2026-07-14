/**
 * qualificationService/sse.js
 *
 * SSE (Server-Sent Events) + Socket.IO broadcast infrastructure for the
 * qualification service, shared with discoveryService via the same
 * "jobStreams + jobEventHistory + emitJobEvent" pattern.
 *
 * Exports:
 *   - registerJobStream(jobId, res)  — attach an SSE client (Express res)
 *                                      to a jobId. Sends a "connected"
 *                                      event immediately + replays the last
 *                                      200 events from the jobEventHistory
 *                                      buffer. Removes the client on res close.
 *   - emitJobEvent(jobId, event)     — record event in jobEventHistory
 *                                      (capped at 200), broadcast via
 *                                      Socket.IO ("qualification:event"),
 *                                      and write to every active SSE client.
 *   - closeJobStream(jobId)          — end every SSE response for the jobId
 *                                      and schedule deletion of its history
 *                                      buffer 5 minutes later.
 *
 * The lazy `require("./socketService")` inside emitJobEvent is preserved
 * from the original — it avoids a circular require at module-load time
 * (socketService pulls in many other services that may in turn pull in
 * qualificationService).
 *
 * Path notes: the split files live one directory deeper than the original
 * qualificationService.js. The original used `require("./socketService")`
 * for the sibling service — from this split file that becomes
 * `require("../socketService")`.
 */

const {
  jobStreams,
  jobEventHistory,
} = require("./state");

function registerJobStream(jobId, res) {
  const key = String(jobId);
  if (!jobStreams.has(key)) {
    jobStreams.set(key, new Set());
  }

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
  broadcast("qualification:event", event);

  // Legacy SSE
  const streams = jobStreams.get(key);
  if (!streams || streams.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  streams.forEach((stream) => stream.write(payload));
}

function closeJobStream(jobId) {
  const key = String(jobId);
  const streams = jobStreams.get(key);
  if (!streams) return;
  streams.forEach((stream) => stream.end());
  jobStreams.delete(key);
  setTimeout(() => jobEventHistory.delete(key), 5 * 60 * 1000);
}

module.exports = { registerJobStream, emitJobEvent, closeJobStream };
