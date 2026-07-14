/**
 * Discovery Service — Job Streams & Stop Flags
 * Shared mutable state for in-flight discovery jobs: Server-Sent-Events (SSE)
 * response streams, event replay history, the stop flag set, and the hourly
 * visit-timestamp buffer used by enforceVisitLimit.
 * Extracted from the original discoveryService.js for maintainability.
 */

const { getPlatformKeys } = require("../platformCatalog");
const { broadcast } = require("../socketService");
const { DISCOVERY_PLATFORM_KEYS } = require("./constants");

// In-memory ring buffer of profile-visit timestamps (ms since epoch) used by
// enforceVisitLimit to throttle visits to MAX_PROFILE_VISITS_PER_HOUR per hour.
const visitTimestamps = [];

// jobId -> Set<ServerResponse> — SSE streams currently subscribed to a job.
const jobStreams = new Map();

// jobId (string) set — populated by stopDiscovery(), checked by isJobStopped().
const stoppedJobs = new Set();

// jobId (string) -> event[] — capped at 200 most-recent events per job, used
// to replay history when an SSE client (re)connects mid-run.
const jobEventHistory = new Map();

/**
 * Return the subset of DISCOVERY_PLATFORM_KEYS that the platformCatalog also
 * reports as enabled for this tenant.
 */
function listDiscoverySources() {
  const known = new Set(getPlatformKeys());
  return DISCOVERY_PLATFORM_KEYS.filter((platform) => known.has(platform));
}

/**
 * Register an SSE response stream for a jobId. Replays any buffered event
 * history for that job so the new client sees the full prior conversation.
 */
function registerJobStream(jobId, res) {
  const key = String(jobId);
  if (!jobStreams.has(key)) jobStreams.set(key, new Set());
  jobStreams.get(key).add(res);
  res.write(`data: ${JSON.stringify({ type: "connected", jobId })}\n\n`);
  (jobEventHistory.get(key) || []).forEach((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
  res.on("close", () => {
    const s = jobStreams.get(key);
    if (s) {
      s.delete(res);
      if (s.size === 0) jobStreams.delete(key);
    }
  });
}

/**
 * Emit a discovery event for a jobId. Broadcasts via Socket.IO (channel
 * "discovery:event") AND writes to every SSE stream currently subscribed to
 * the job. History is capped at the most-recent 200 events per job.
 */
function emitJobEvent(jobId, event) {
  const key = String(jobId);
  const h = jobEventHistory.get(key) || [];
  h.push(event);
  jobEventHistory.set(key, h.slice(-200));

  // Broadcast via Socket.IO
  broadcast("discovery:event", event);

  // Legacy SSE
  const s = jobStreams.get(key);
  if (s) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    s.forEach((st) => st.write(payload));
  }
}

/**
 * End every SSE stream for a jobId and remove the stream set from the map.
 * Event history is retained for 5 minutes after close to allow a final
 * reconnect-replay window, then garbage-collected.
 */
function closeJobStream(jobId) {
  const key = String(jobId);
  const s = jobStreams.get(key);
  if (s) {
    s.forEach((st) => st.end());
    jobStreams.delete(key);
  }
  setTimeout(() => jobEventHistory.delete(key), 5 * 60 * 1000);
}

/**
 * Mark a discovery job as stopped. The in-flight loop checks isJobStopped()
 * between platforms and aborts gracefully.
 */
function stopDiscovery(jobId) {
  stoppedJobs.add(String(jobId));
}

/**
 * Has this jobId been marked as stopped via stopDiscovery()?
 */
function isJobStopped(jobId) {
  return stoppedJobs.has(String(jobId));
}

module.exports = {
  visitTimestamps,
  jobStreams,
  stoppedJobs,
  jobEventHistory,
  listDiscoverySources,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
  stopDiscovery,
  isJobStopped,
};
