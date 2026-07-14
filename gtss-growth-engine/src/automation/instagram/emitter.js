/**
 * Instagram Emitter Helpers
 * igDelay — natural human-like pause matching Nairobi delay patterns.
 * safeEmit — emit an orchestration event to the active emitter or fall back
 * to the native logger.
 * Extracted from the original instagram.js for maintainability.
 */

const { humanDelay } = require("../browserBase");
const logger = require("../../utils/logger");
const { IG_DELAYS } = require("./constants");

/**
 * Perform a natural human-like pause matching Nairobi delay patterns.
 * @param {string} type - Delay type name
 */
async function igDelay(type) {
  const range = IG_DELAYS[type] || { min: 3000, max: 8000 };
  await humanDelay(range.min, range.max);
}

/**
 * Emit an orchestration event to the active emitter or fall back to native logger.
 */
function safeEmit(emitter, type, message, data = {}) {
  if (typeof emitter === "function") {
    try {
      emitter(type, message, data);
    } catch (_) {}
  } else if (emitter && typeof emitter.emit === "function") {
    try {
      emitter.emit(type, message, data);
    } catch (_) {}
  }
  const logLevel =
    type === "error" ? "error" : type === "warn" ? "warn" : "info";
  logger[logLevel]("INSTAGRAM_OUTREACH", message, data);
}

module.exports = { igDelay, safeEmit };
