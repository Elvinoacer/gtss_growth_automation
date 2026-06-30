/**
 * Platform Adapter Module
 *
 * Implements a normalized execution layer wrapping existing platform-specific
 * automation controllers (LinkedIn, Instagram, X).
 *
 * Guarantees consistent response structures, structured logs, and try-catch safety
 * where no unhandled exceptions are thrown. Normalizes selector, network, and
 * expired session failures into deterministic outcome states.
 */

const linkedin = require("../automation/linkedin");
const instagram = require("../automation/instagram");
const x = require("../automation/x");
const facebook = require("../automation/facebook");
const logger = require("../utils/logger");
const { resolveInstagramUsername } = require("../utils/instagramUsername");
const { classifyOutcome, queueLog } = require("./utils/campaignUtils");

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
  const errMsg = String(error?.message || error || "").toLowerCase();

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
      error: error?.message || String(error),
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
    `${actionType} action failed: ${error?.message || String(error)} (Retryable: ${retryable})`,
  );

  return {
    outcome: "failed",
    error: error?.message || String(error),
    metadata: {},
    retryable,
  };
}

/**
 * Normalizes connection outreach actions across LinkedIn, Instagram, and X.
 *
 * @param {string} platform - Target platform key ('linkedin', 'instagram', 'x')
 * @param {object} page - Playwright page context
 * @param {object} lead - Target lead record
 * @param {string} message - Optional connection invitation message / note
 * @param {function|object} emitter - Logging callback or event emitter
 * @returns {Promise<object>} Normalized result: { outcome, error, metadata, retryable }
 */
async function runConnectionAction(platform, page, lead, message, emitter) {
  const normPlatform = String(platform).toLowerCase().trim();
  const emit = getEmitCallback(emitter);

  queueLog(
    "info",
    "adapter",
    normPlatform,
    `Initiating connection action for lead ${lead.id}.`,
  );

  // Runtime validation for unsupported platforms
  if (!["linkedin", "instagram", "x", "facebook"].includes(normPlatform)) {
    return {
      outcome: "failed",
      error: `Unsupported platform: ${platform}`,
      metadata: {},
      retryable: false,
    };
  }

  try {
    if (normPlatform === "linkedin") {
      const res = await linkedin.sendConnectionRequest(
        page,
        lead.profile_url,
        message,
        emit,
      );
      if (res.outcome === "sent") {
        return { outcome: "sent", error: null, metadata: {}, retryable: false };
      }
      if (res.outcome === "already_connected") {
        return {
          outcome: "skipped",
          error: null,
          metadata: {},
          retryable: false,
        };
      }
      if (res.outcome === "not_connected") {
        return {
          outcome: "skipped",
          error: res.reason,
          metadata: {},
          retryable: false,
        };
      }
      return classifyAndNormalizeError(
        "linkedin",
        "connection",
        res.reason || "LinkedIn connection failed",
      );
    }

    if (normPlatform === "x") {
      const res = await x.followUser(page, lead.profile_url, emit);
      if (res.outcome === "sent") {
        return { outcome: "sent", error: null, metadata: {}, retryable: false };
      }
      if (res.outcome === "already_connected") {
        return {
          outcome: "skipped",
          error: null,
          metadata: {},
          retryable: false,
        };
      }
      if (res.outcome === "failed") {
        if (res.failCategory === "suspended") {
          return {
            outcome: "blocked",
            error: res.reason,
            metadata: { category: "suspended" },
            retryable: false,
          };
        }
        if (res.failCategory === "not_found") {
          return {
            outcome: "failed",
            error: res.reason,
            metadata: { category: "not_found" },
            retryable: false,
          };
        }
        if (res.failCategory === "rate_limited") {
          return {
            outcome: "failed",
            error: res.reason,
            metadata: { category: "rate_limited" },
            retryable: true,
          };
        }
        return classifyAndNormalizeError(
          "x",
          "connection",
          res.reason || "X connection failed",
        );
      }
      // Fallback for any other outcome (e.g. "skipped", "session_required",
      // or a future outcome string). Without this, the function would return
      // `undefined`, causing `res.outcome` in the caller to throw a TypeError.
      return classifyAndNormalizeError(
        "x",
        "connection",
        res.reason || `X connection returned unhandled outcome: ${res.outcome}`,
      );
    }

    if (normPlatform === "instagram") {
      const username = getInstagramUsername(lead);
      const res = await instagram.followAccount(
        page,
        { username, leadId: lead.id },
        emit,
      );
      if (res.success) {
        return {
          outcome: "sent",
          error: null,
          metadata: { requestPending: res.requestPending },
          retryable: false,
        };
      } else {
        if (res.error === "account_blocked") {
          return {
            outcome: "blocked",
            error: "Instagram account blocked",
            metadata: { resumesAt: res.resumesAt },
            retryable: false,
          };
        }
        return classifyAndNormalizeError(
          "instagram",
          "connection",
          res.error || "Instagram connection failed",
        );
      }
    }

    if (normPlatform === "facebook") {
      const res = await facebook.sendConnectionRequest(
        page,
        lead.profile_url,
        message,
        emit,
      );
      if (res.outcome === "sent") {
        return { outcome: "sent", error: null, metadata: {}, retryable: false };
      }
      if (res.outcome === "already_connected") {
        return {
          outcome: "skipped",
          error: null,
          metadata: {},
          retryable: false,
        };
      }
      if (res.outcome === "failed") {
        if (res.failCategory === "restricted") {
          return {
            outcome: "blocked",
            error: res.reason,
            metadata: { category: "restricted" },
            retryable: false,
          };
        }
        if (res.failCategory === "not_found") {
          return {
            outcome: "failed",
            error: res.reason,
            metadata: { category: "not_found" },
            retryable: false,
          };
        }
        if (res.failCategory === "rate_limited") {
          return {
            outcome: "failed",
            error: res.reason,
            metadata: { category: "rate_limited" },
            retryable: true,
          };
        }
        return classifyAndNormalizeError(
          "facebook",
          "connection",
          res.reason || "Facebook connection failed",
        );
      }
      // Fallback for any other outcome (e.g. "skipped", "session_required",
      // or a future outcome string). Without this, the function would return
      // `undefined`, causing `res.outcome` in the caller to throw a TypeError.
      return classifyAndNormalizeError(
        "facebook",
        "connection",
        res.reason || `Facebook connection returned unhandled outcome: ${res.outcome}`,
      );
    }
  } catch (err) {
    return classifyAndNormalizeError(normPlatform, "connection", err);
  }
}

/**
 * Normalizes direct message outreach actions across LinkedIn, Instagram, and X.
 *
 * @param {string} platform - Target platform key ('linkedin', 'instagram', 'x')
 * @param {object} page - Playwright page context
 * @param {object} lead - Target lead record
 * @param {string} message - Direct message body
 * @param {function|object} emitter - Logging callback or event emitter
 * @returns {Promise<object>} Normalized result: { outcome, error, metadata, retryable }
 */
async function runDmAction(platform, page, lead, message, emitter) {
  const normPlatform = String(platform).toLowerCase().trim();
  const emit = getEmitCallback(emitter);

  queueLog(
    "info",
    "adapter",
    normPlatform,
    `Initiating DM action for lead ${lead.id}.`,
  );

  // Runtime validation for unsupported platforms
  if (!["linkedin", "instagram", "x", "facebook"].includes(normPlatform)) {
    return {
      outcome: "failed",
      error: `Unsupported platform: ${platform}`,
      metadata: {},
      retryable: false,
    };
  }

  try {
    if (normPlatform === "linkedin") {
      const res = await linkedin.sendDirectMessage(
        page,
        lead.profile_url,
        message,
        emit,
        lead.lead_name || lead.name || null, // passed for browser-side identity verification
      );
      if (res.outcome === "sent") {
        return { outcome: "sent", error: null, metadata: {}, retryable: false };
      }
      if (res.outcome === "not_connected") {
        return {
          outcome: "skipped",
          error: res.reason,
          metadata: {},
          retryable: false,
        };
      }
      if (res.outcome === "premium_required") {
        return {
          outcome: "premium_required",
          error: res.reason,
          metadata: {},
          retryable: false,
        };
      }
      return classifyAndNormalizeError(
        "linkedin",
        "dm",
        res.reason || "LinkedIn DM failed",
      );
    }

    if (normPlatform === "x") {
      const res = await x.sendDirectMessage(
        page,
        lead.profile_url,
        message,
        emit,
      );
      if (res.outcome === "sent") {
        return { outcome: "sent", error: null, metadata: {}, retryable: false };
      }
      if (res.outcome === "not_connected") {
        return {
          outcome: "skipped",
          error: res.reason,
          metadata: {},
          retryable: false,
        };
      }
      if (res.outcome === "failed") {
        if (res.failCategory === "suspended") {
          return {
            outcome: "blocked",
            error: res.reason,
            metadata: { category: "suspended" },
            retryable: false,
          };
        }
        if (res.failCategory === "not_found") {
          return {
            outcome: "failed",
            error: res.reason,
            metadata: { category: "not_found" },
            retryable: false,
          };
        }
        return classifyAndNormalizeError(
          "x",
          "dm",
          res.reason || "X DM failed",
        );
      }
      // Fallback for any other outcome (e.g. "skipped", "session_required",
      // or a future outcome string). Without this, the function would return
      // `undefined`, causing `res.outcome` in the caller to throw a TypeError.
      return classifyAndNormalizeError(
        "x",
        "dm",
        res.reason || `X DM returned unhandled outcome: ${res.outcome}`,
      );
    }

    if (normPlatform === "instagram") {
      const username = getInstagramUsername(lead);
      const res = await instagram.sendDM(page, { username, message }, emit);
      if (res.success) {
        if (res.hadReply) {
          return {
            outcome: "skipped",
            error: "Lead has replied to us",
            metadata: { hadReply: true },
            retryable: false,
          };
        }
        return {
          outcome: "sent",
          error: null,
          metadata: { isMessageRequest: res.isMessageRequest },
          retryable: false,
        };
      } else {
        if (res.error === "already_messaged") {
          return {
            outcome: "skipped",
            error: "Already messaged",
            metadata: { threadUrl: res.threadUrl },
            retryable: false,
          };
        }
        if (res.error === "account_blocked") {
          return {
            outcome: "blocked",
            error: "Instagram account blocked",
            metadata: { resumesAt: res.resumesAt },
            retryable: false,
          };
        }
        if (res.error === "empty_message" || res.error === "message_too_long") {
          return {
            outcome: "failed",
            error: res.error,
            metadata: {},
            retryable: false,
          };
        }
        return classifyAndNormalizeError(
          "instagram",
          "dm",
          res.error || "Instagram DM failed",
        );
      }
    }

    if (normPlatform === "facebook") {
      const res = await facebook.sendDirectMessage(
        page,
        lead.profile_url,
        message,
        emit,
      );
      if (res.outcome === "sent") {
        return { outcome: "sent", error: null, metadata: {}, retryable: false };
      }
      if (res.outcome === "not_connected") {
        return {
          outcome: "skipped",
          error: res.reason,
          metadata: {},
          retryable: false,
        };
      }
      if (res.outcome === "failed") {
        if (res.failCategory === "restricted") {
          return {
            outcome: "blocked",
            error: res.reason,
            metadata: { category: "restricted" },
            retryable: false,
          };
        }
        if (res.failCategory === "not_found") {
          return {
            outcome: "failed",
            error: res.reason,
            metadata: { category: "not_found" },
            retryable: false,
          };
        }
        return classifyAndNormalizeError(
          "facebook",
          "dm",
          res.reason || "Facebook DM failed",
        );
      }
      // Fallback for any other outcome (e.g. "skipped", "session_required",
      // or a future outcome string). Without this, the function would return
      // `undefined`, causing `res.outcome` in the caller to throw a TypeError.
      return classifyAndNormalizeError(
        "facebook",
        "dm",
        res.reason || `Facebook DM returned unhandled outcome: ${res.outcome}`,
      );
    }
  } catch (err) {
    return classifyAndNormalizeError(normPlatform, "dm", err);
  }
}

module.exports = {
  runConnectionAction,
  runDmAction,
};
