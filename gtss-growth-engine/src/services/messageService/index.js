/**
 * messageService/index.js
 *
 * Re-exports the EXACT same module.exports surface as the original
 * messageService.js — 10 public exports:
 *
 *   { generateMessages, generateViaAI, generateFollowUp, generateAllMessages,
 *     generateFromTemplate, runMessageStage, registerJobStream, emitJobEvent,
 *     closeJobStream, getCharLimit, CHAR_LIMITS }
 *
 * Every in-tree caller that did `require("../services/messageService")`
 * (notably pipelineRunner.runFullPipelineNow, which calls runMessageStage)
 * continues to resolve to this index.js (Node.js directory-index resolution).
 *
 * The split files live one directory deeper than the original, so every
 * `require("../X")` in the original file became `require("../../X")` in
 * the split files for paths to ../../db, ../../config, ../../utils,
 * ../../pipeline. Same-directory sibling requires to ../contextService,
 * ../platformCatalog, ../aiService, ../socketService stay one-level
 * (`../X`).
 */

const { registerJobStream, emitJobEvent, closeJobStream } = require("./sseInfrastructure");
const { CHAR_LIMITS, getCharLimit } = require("./templates");
const { generateFromTemplate } = require("./generateFromTemplate");
const { generateViaAI } = require("./generateViaAI");
const { generateMessages } = require("./generateMessages");
const { generateFollowUp } = require("./generateFollowUp");
const { generateAllMessages } = require("./generateAllMessages");
const { runMessageStage } = require("./runMessageStage");

module.exports = {
  generateMessages,
  generateViaAI,
  generateFollowUp,
  generateAllMessages,
  generateFromTemplate,
  runMessageStage,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
  getCharLimit,
  CHAR_LIMITS,
};
