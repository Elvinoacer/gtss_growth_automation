/**
 * platformAdapter/runConnectionAction.js — Normalized connection outreach
 * action across LinkedIn, Instagram, X, Facebook, and TikTok.
 *
 * Translates each platform controller's response shape into the standard
 * { outcome, error, metadata, retryable } schema. Catches all exceptions
 * and routes them through classifyAndNormalizeError so no unhandled error
 * ever escapes the adapter.
 *
 * Original platformAdapter.js was 655 lines; this is one of its thematic
 * splits. Relative require paths were updated for the new directory depth
 * (one extra `..` for src/automation/*).
 */

const linkedin = require("../../automation/linkedin");
const instagram = require("../../automation/instagram");
const x = require("../../automation/x");
const facebook = require("../../automation/facebook");
const tiktok = require("../../automation/tiktok");
const { queueLog } = require("../utils/campaignUtils");
const {
  getInstagramUsername,
  getEmitCallback,
  classifyAndNormalizeError,
} = require("./helpers");

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
  if (!["linkedin", "instagram", "x", "facebook", "tiktok"].includes(normPlatform)) {
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

    if (normPlatform === "tiktok") {
      const res = await tiktok.followUser(page, lead.profile_url, emit);
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
          "tiktok",
          "connection",
          res.reason || "TikTok connection failed",
        );
      }
      // Fallback for any other outcome (e.g. "skipped", "session_required",
      // or a future outcome string). Without this, the function would return
      // `undefined`, causing `res.outcome` in the caller to throw a TypeError.
      return classifyAndNormalizeError(
        "tiktok",
        "connection",
        res.reason || `TikTok connection returned unhandled outcome: ${res.outcome}`,
      );
    }
  } catch (err) {
    return classifyAndNormalizeError(normPlatform, "connection", err);
  }
}

module.exports = { runConnectionAction };
