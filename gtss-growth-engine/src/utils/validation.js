/**
 * GTSS Growth Engine Input Validation Utilities
 */

const { isKnownPlatform } = require("../services/platformCatalog");

/**
 * Escapes HTML special characters to prevent XSS.
 */
function escapeHtml(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Recursively sanitizes an object's string properties.
 */
function sanitize(obj) {
  if (!obj || typeof obj !== "object") return obj;

  for (const key in obj) {
    if (typeof obj[key] === "string") {
      obj[key] = escapeHtml(obj[key].trim());
    } else if (typeof obj[key] === "object") {
      sanitize(obj[key]);
    }
  }
  return obj;
}

/**
 * Express middleware to sanitize req.body, req.query, and req.params.
 */
function sanitizeRequestBody(req, res, next) {
  if (req.body) sanitize(req.body);
  if (req.query) sanitize(req.query);
  if (req.params) sanitize(req.params);
  next();
}

/**
 * Validates lead platform.
 */
function isValidPlatform(platform) {
  return isKnownPlatform(platform);
}

/**
 * Validates status transitions.
 *
 * Allowed transitions map — each key lists the statuses it can move to.
 * Any status can always stay the same (no-op).
 */
const VALID_TRANSITIONS = {
  discovered:            ["qualified", "deprioritized", "dismissed", "pending_qualification"],
  pending_qualification: ["qualified", "deprioritized", "dismissed", "discovered"],
  scoring_failed:        ["qualified", "deprioritized", "dismissed", "discovered", "pending_qualification"],
  qualified:             ["messaged", "deprioritized", "dismissed"],
  deprioritized:         ["qualified", "dismissed", "discovered"],
  dismissed:             ["discovered", "qualified", "deprioritized"],
  messaged:              ["replied", "meeting_booked", "lost", "dismissed"],
  replied:               ["meeting_booked", "converted", "lost"],
  meeting_booked:        ["converted", "lost", "replied"],
  converted:             ["lost"],
  lost:                  ["messaged", "replied", "meeting_booked"],
};

function isValidStatusTransition(oldStatus, newStatus) {
  if (!oldStatus) return true; // New lead
  if (oldStatus === newStatus) return true; // No-op

  const allowed = VALID_TRANSITIONS[oldStatus];
  if (!allowed) return false; // Unknown source status

  return allowed.includes(newStatus);
}

/**
 * Validates daily limits.
 */
function isValidLimit(limit) {
  const n = parseInt(limit, 10);
  return !isNaN(n) && n >= 1 && n <= 200;
}

module.exports = {
  sanitizeRequestBody,
  isValidPlatform,
  isValidStatusTransition,
  isValidLimit,
  escapeHtml,
};
