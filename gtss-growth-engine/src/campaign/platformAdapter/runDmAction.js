/**
 * platformAdapter/runDmAction.js — Normalized direct-message outreach action
 * across LinkedIn, Instagram, X, Facebook, and TikTok.
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
  isXDmOutreachEnabled,
  isIgDmOutreachEnabled,
} = require("../../config/pipelineConfig");
const {
  getInstagramUsername,
  getEmitCallback,
  classifyAndNormalizeError,
} = require("./helpers");

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
  if (!["linkedin", "instagram", "x", "facebook", "tiktok"].includes(normPlatform)) {
    return {
      outcome: "failed",
      error: `Unsupported platform: ${platform}`,
      metadata: {},
      retryable: false,
    };
  }

  // X / Instagram cold-DM outreach is off by default until re-enabled in Settings.
  if (normPlatform === "x" && !isXDmOutreachEnabled()) {
    const reason =
      "X DM outreach is disabled. Enable it under Settings → Pipeline Configuration when you have a premium-capable X account.";
    queueLog("warn", "adapter", "x", reason);
    emit("warn", reason);
    return {
      outcome: "skipped",
      error: reason,
      metadata: { reason: "x_dm_outreach_disabled" },
      retryable: false,
    };
  }
  if (normPlatform === "instagram" && !isIgDmOutreachEnabled()) {
    const reason =
      "Instagram DM outreach is disabled. Enable it under Settings → Pipeline Configuration when you are ready for paced, personalized IG DMs.";
    queueLog("warn", "adapter", "instagram", reason);
    emit("warn", reason);
    return {
      outcome: "skipped",
      error: reason,
      metadata: { reason: "ig_dm_outreach_disabled" },
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
        // Preserve as not_connected so the DM queue can re-snooze (waiting for
        // acceptance) instead of falsely marking the job as sent/skipped.
        return {
          outcome: "not_connected",
          error: res.reason || "Not a 1st-degree connection yet",
          metadata: {},
          retryable: true,
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

    if (normPlatform === "tiktok") {
      const res = await tiktok.sendDirectMessage(
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
          "dm",
          res.reason || "TikTok DM failed",
        );
      }
      // Fallback for any other outcome (e.g. "skipped", "session_required",
      // or a future outcome string). Without this, the function would return
      // `undefined`, causing `res.outcome` in the caller to throw a TypeError.
      return classifyAndNormalizeError(
        "tiktok",
        "dm",
        res.reason || `TikTok DM returned unhandled outcome: ${res.outcome}`,
      );
    }
  } catch (err) {
    return classifyAndNormalizeError(normPlatform, "dm", err);
  }
}

module.exports = { runDmAction };
