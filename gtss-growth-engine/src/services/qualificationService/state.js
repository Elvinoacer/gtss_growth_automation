/**
 * qualificationService/state.js
 *
 * Module-level mutable state + tiny pure helpers for the qualification
 * service. Kept in one place so the SSE / scoring / batch / pipeline-stage
 * split files all share the SAME Set/Map references (since Sets and Maps
 * are passed by reference, mutations made via the exports below are
 * visible to every other split file that imports them).
 *
 * Exports:
 *   - jobStreams:        Map<jobId, Set<res>>   active SSE response streams
 *   - jobEventHistory:   Map<jobId, event[]>    last 200 events per job
 *                                                 (replay buffer for new SSE clients)
 *   - activeQualJobs:    Set<jobId>              stop-flag set (jobs added
 *                                                 here are treated as "stop
 *                                                 requested" on the next tick)
 *   - BATCH_SIZE:        number (10)             leads per batch (Gemini rate limit)
 *   - BATCH_DELAY_MS:    number (2000)           delay between batches
 *   - parseGeminiJsonObject(rawText): object     tolerant JSON.parse that
 *                                                 extracts the first {...} block
 *   - delay(ms): Promise<void>                   setTimeout-as-promise helper
 *   - stopQualificationJob(jobId): void          add jobId to activeQualJobs
 *   - isQualificationStopped(jobId): bool        check if jobId is in activeQualJobs
 *
 * The split files live one directory deeper than the original
 * qualificationService.js, so the require paths to ../db, ../utils,
 * ../config are unchanged (they were already ../X in the original — the
 * split files at ../../X would be wrong; they remain ../X).
 *   Original: src/services/qualificationService.js → ../db = src/db
 *   Split:    src/services/qualificationService/state.js → ../db = src/db ✓
 * (Same depth — the split directory is one level deeper than the original
 * file's directory, but the split FILE is at the same depth as the
 * original file relative to ../db. Wait: src/services/qualificationService.js
 * is at depth 3 (services), src/services/qualificationService/state.js is at
 * depth 4. So `../db` from the original = src/db; `../db` from the split
 * file = src/services/db (WRONG). Need `../../db` from the split file.)
 *
 * Re-verified: split files at src/services/qualificationService/X.js need
 * `../../db/database`, `../../utils/logger`, `../../config/pipelineConfig`,
 * and `../X` for sibling services (aiService, contextService, socketService,
 * instagramDiscoveryService).
 */

const jobStreams = new Map();
const jobEventHistory = new Map();
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 2000;
const activeQualJobs = new Set();

function parseGeminiJsonObject(rawText) {
  const raw = String(rawText || "").trim();
  try {
    return JSON.parse(raw);
  } catch (_) {
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    }
    throw _;
  }
}

function stopQualificationJob(jobId) {
  activeQualJobs.add(String(jobId));
}

function isQualificationStopped(jobId) {
  return activeQualJobs.has(String(jobId));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  jobStreams,
  jobEventHistory,
  activeQualJobs,
  BATCH_SIZE,
  BATCH_DELAY_MS,
  parseGeminiJsonObject,
  stopQualificationJob,
  isQualificationStopped,
  delay,
};
