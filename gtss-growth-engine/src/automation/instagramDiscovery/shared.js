/**
 * instagramDiscovery/shared.js
 *
 * Shared constants and helper utilities used by every split file in the
 * instagramDiscovery module:
 *   - IG_DELAYS         Human-like delay ranges (ms) for each interaction type
 *   - DISCOVERY_PAGINATION  Tuning knobs for the feed-discovery scroll loop
 *   - igDelay(type)     Async pause using IG_DELAYS ranges
 *   - safeEmit(...)     Emit log events to a callback/emitter AND the system logger
 *   - parseIgCount(val) Parse "2.3K" / "1.2M" style metric suffixes into integers
 *
 * These were all top-level helpers in the original instagramDiscovery.js and
 * are referenced by every other split file.
 */

const { humanDelay } = require("../browserBase");
const logger = require("../../utils/logger");

// ── CONSTANTS ───────────────────────────────────────────────────────────────

const IG_DELAYS = {
  betweenProfileVisits: { min: 12000, max: 25000 },
  betweenFollows: { min: 45000, max: 120000 },
  betweenLikes: { min: 20000, max: 60000 },
  betweenDMs: { min: 60000, max: 180000 },
  afterHashtagLoad: { min: 5000, max: 12000 },
  afterAction: { min: 3000, max: 8000 },
};

const DISCOVERY_PAGINATION = {
  maxIterationsMultiplier: 6,
  minMaxIterations: 25,
  maxStagnantRounds: 4,
  maxIdleMs: 120000,
  scrollAttemptsPerRound: 4,
};

// ── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Perform a natural human-like pause matching Nairobi delay patterns.
 */
async function igDelay(type) {
  const range = IG_DELAYS[type] || { min: 3000, max: 8000 };
  await humanDelay(range.min, range.max);
}

/**
 * Emit log events to active emitter callbacks or system logger.
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
  logger[logLevel]("INSTAGRAM_DISCOVERY", message, data);
}

/**
 * Parses Instagram-style metric suffix tags ("2.3K" -> 2300, "1.2M" -> 1200000).
 * @param {string|number} val - Suffix counts
 * @returns {number} Integer value representation
 */
function parseIgCount(val) {
  if (val === undefined || val === null) return 0;
  if (typeof val === "number") return val;

  let str = val.toString().trim().toUpperCase().replace(/,/g, "");
  let multiplier = 1;

  if (str.endsWith("K")) {
    multiplier = 1000;
    str = str.slice(0, -1);
  } else if (str.endsWith("M")) {
    multiplier = 1000000;
    str = str.slice(0, -1);
  }

  const num = parseFloat(str);
  return isNaN(num) ? 0 : Math.round(num * multiplier);
}

module.exports = {
  IG_DELAYS,
  DISCOVERY_PAGINATION,
  igDelay,
  safeEmit,
  parseIgCount,
};
