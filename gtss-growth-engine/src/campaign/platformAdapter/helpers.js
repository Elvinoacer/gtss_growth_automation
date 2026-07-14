/**
 * platformAdapter/helpers.js — Shared helpers used by both runConnectionAction
 * and runDmAction: Instagram username extraction, emit-callback normalization,
 * and the centralized error classifier that maps caught errors to the standard
 * { outcome, error, metadata, retryable } result schema.
 *
 * Original platformAdapter.js was 655 lines; this is one of its thematic
 * splits. Relative require paths were updated for the new directory depth
 * (one extra `..` for src/automation/* and src/utils/*; same `..` for
 * src/campaign/utils/*).
 */

const logger = require("../../utils/logger");
const { resolveInstagramUsername } = require("../../utils/instagramUsername");
const { classifyOutcome, queueLog } = require("../utils/campaignUtils");

/**
 * Extracts normalized Instagram username handle from a lead object.
 *
 * @param {object} lead - Database lead context record
 * @returns {string} Instagram username handle
 */
function getInstagramUsername(lead) {
  return resolveInstagramUsername(lead);
}

/**
 * Common formatter for log event callbacks across automation layers.
 *
 * @param {function|object} emitter - Callback or event emitter object
 * @returns {function} Unified log emit callback
 */
function getEmitCallback(emitter) {
  if (typeof emitter === "function") {
    return emitter;
  }
  if (emitter && typeof emitter.emit === "function") {
    return (type, msg) => {
      emitter.emit("event", { type, message: msg });
    };
  }
  // Default silent fallback
  return () => {};
}

/**
 * Centralized exception classifier mapping caught errors to standard result schemas.
 *
 * @param {string} platform - Social network platform identifier
 * @param {string} actionType - Outreach action category ('connection' | 'dm')
 * @param {Error|string} error - Caught runtime exception context
 * @returns {object} Standardized normalized outcome result
 */
function classifyAndNormalizeError(platform, actionType, error) {
  const errMsg = String(error && error.message ? error.message : error || "").toLowerCase();

  // 1. Session / Cookie validation failures detection
  if (
    errMsg.includes("session expired") ||
    errMsg.includes("login") ||
    errMsg.includes("sign in") ||
    errMsg.includes("cookie") ||
    errMsg.includes("unauthorized") ||
    errMsg.includes("auth")
  ) {
    queueLog(
      "error",
      "adapter",
      platform,
      `Expired or invalid session detected during ${actionType} action.`,
    );
    return {
      outcome: "session_required",
      error: (error && error.message) || String(error),
      metadata: {},
      retryable: false,
    };
  }

  // 2. Fall back to shared campaign outcomes classifier
  const classification = classifyOutcome(error);
  const retryable = !classification.isTerminal;

  queueLog(
    "error",
    "adapter",
    platform,
    `${actionType} action failed: ${(error && error.message) || String(error)} (Retryable: ${retryable})`,
  );

  return {
    outcome: "failed",
    error: (error && error.message) || String(error),
    metadata: {},
    retryable,
  };
}

module.exports = {
  getInstagramUsername,
  getEmitCallback,
  classifyAndNormalizeError,
};
