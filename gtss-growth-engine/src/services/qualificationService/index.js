/**
 * qualificationService/index.js — Public entry point for
 * `require("../services/qualificationService")`.
 *
 * Preserves the EXACT module.exports surface of the original
 * qualificationService.js monolith:
 *
 *   module.exports = {
 *     scoreLead,
 *     scoreLeadsBatch,
 *     stopQualificationJob,
 *     isQualificationStopped,
 *     runQualificationStage,
 *     registerJobStream,
 *     emitJobEvent,
 *     closeJobStream,
 *   };
 *
 * The split files live one directory deeper than the original
 * qualificationService.js. The original used:
 *   - `require("../db/database")`            → now `../../db/database`
 *   - `require("./aiService")`               → now `../aiService`
 *   - `require("./contextService")`          → now `../contextService`
 *   - `require("../utils/logger")`           → now `../../utils/logger`
 *   - `require("../config/pipelineConfig")`  → now `../../config/pipelineConfig`
 *   - `require("./socketService")` (lazy)    → now `../socketService`
 *   - `require("./instagramDiscoveryService")` → now `../instagramDiscoveryService`
 *   - `require("../pipeline/pipelineRunner")` (lazy) → now `../../pipeline/pipelineRunner`
 *
 * Module-level state (jobStreams, jobEventHistory, activeQualJobs) lives
 * in state.js and is imported by sse.js / batchProcessor.js so every
 * split file shares the SAME Set/Map references (since Sets/Maps are
 * passed by reference, mutations made via the state.js exports are
 * visible to every other split file that imports them).
 *
 * File manifest:
 *   state.js           — module-level Sets/Maps + BATCH_SIZE / BATCH_DELAY_MS
 *                        + parseGeminiJsonObject + delay +
 *                        stopQualificationJob / isQualificationStopped
 *   sse.js             — registerJobStream, emitJobEvent, closeJobStream
 *                        (shares Maps from state.js; lazy-requires
 *                        socketService to avoid circular-dep at load time)
 *   promptBuilder.js   — buildPrompt(lead) (uses contextService.getContext)
 *   scoring.js         — scoreLead(lead, options?) (calls Gemini via
 *                        aiService; AI→manual fallback; persists score)
 *   batchProcessor.js  — scoreLeadsBatch(leadIds, jobId, { pipelineRunId })
 *                        (BATCH_SIZE chunks + extended-timeout retry for
 *                        timed-out leads)
 *   pipelineStage.js   — runQualificationStage(jobId, emit, platforms?)
 *                        (manual bulk-qualify vs. AI scoring dispatcher)
 *   index.js           — this file
 */

const { scoreLead } = require("./scoring");
const { scoreLeadsBatch } = require("./batchProcessor");
const {
  stopQualificationJob,
  isQualificationStopped,
} = require("./state");
const { runQualificationStage } = require("./pipelineStage");
const {
  registerJobStream,
  emitJobEvent,
  closeJobStream,
} = require("./sse");

module.exports = {
  scoreLead,
  scoreLeadsBatch,
  stopQualificationJob,
  isQualificationStopped,
  runQualificationStage,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
};
