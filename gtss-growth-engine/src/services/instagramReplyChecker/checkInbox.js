/**
 * instagramReplyChecker/checkInbox.js — inbox-scan orchestrator + telemetry.
 *
 * Coordinates a single reply-scan run: opens the authenticated IG browser,
 * runs daily session warmup, then runs checkPrimaryInbox + checkMessageRequests.
 * Wraps the run in a re-entrancy guard (checkingInbox) so a second scheduler
 * tick can't kick off a parallel scan. Always writes a telemetry_logs row
 * (success or failure) and tears down the browser in the finally block.
 *
 * Public exports: checkInbox (re-entrancy-guarded entry point) +
 * isCheckingInbox (read-only status peek used by scheduledPoster and
 * pipelineScheduler to skip overlapping work).
 *
 * Extracted from the original instagramReplyChecker.js for maintainability.
 */

const { getDb } = require("../../db/database");
const {
  createInstagramBrowser,
  dailySessionWarmup,
} = require("../../automation/browserBase");
const logger = require("../../utils/logger");
const { checkPrimaryInbox, checkMessageRequests } = require("./inboxScanning");

let checkingInbox = false;

function isCheckingInbox() {
  return checkingInbox;
}

/**
 * Coordinate and run both Inbox and Message Request scans.
 *
 * @returns {Promise<Object>} Execution status outcome.
 */
async function _checkInboxImpl() {
  const db = getDb();
  logger.info("INSTAGRAM_REPLY_CHECKER", "Initializing inbox reply scan...");
  const startTime = Date.now();
  let browserState = null;
  let success = false;
  let errMessage = null;
  let primaryUnreadCount = 0;
  let requestsCount = 0;

  try {
    browserState = await createInstagramBrowser();
    const page = browserState.page;

    // Simulate natural session warmups
    await dailySessionWarmup(page);

    // 1. Check Primary Inbox
    primaryUnreadCount = await checkPrimaryInbox(page).catch(() => 0);

    // 2. Check Message Requests
    requestsCount = await checkMessageRequests(page).catch(() => 0);

    success = true;
    return { success: true, primaryUnreadCount, requestsCount };
  } catch (err) {
    logger.error(
      "INSTAGRAM_REPLY_CHECKER",
      "Fatal exception during automated inbox scanning",
      err,
    );
    errMessage = err.message;
    throw err;
  } finally {
    const durationMs = Date.now() - startTime;
    try {
      db.prepare(
        `
        INSERT INTO telemetry_logs (platform, action_type, status, duration_ms, processed_count, success_count, error_count, details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        "instagram",
        "check_inbox",
        success ? "success" : "failed",
        durationMs,
        primaryUnreadCount + requestsCount,
        success ? primaryUnreadCount + requestsCount : 0,
        success ? 0 : 1,
        JSON.stringify({
          primaryUnreadCount,
          requestsCount,
          error: errMessage,
          browserMode: browserState ? browserState.mode : "unknown",
        }),
      );
    } catch (telemetryErr) {
      logger.error(
        "INSTAGRAM_REPLY_CHECKER",
        "Failed to write checkInbox telemetry",
        telemetryErr,
      );
    }

    if (browserState) {
      const { closeBrowser } = require("../../automation/browserBase");
      await closeBrowser(
        browserState.browser,
        "instagram",
        browserState.context,
        {
          mode: browserState.mode,
          tracePath: browserState.tracePath,
          shouldCloseBrowser: browserState.shouldCloseBrowser,
          lock: browserState.lock,
        },
      );
    }
  }
}

async function checkInbox() {
  if (checkingInbox) {
    logger.warn(
      "INSTAGRAM_REPLY_CHECKER",
      "checkInbox skipped: already in progress.",
    );
    return { skipped: true };
  }

  checkingInbox = true;
  try {
    return await _checkInboxImpl();
  } finally {
    checkingInbox = false;
  }
}

module.exports = {
  checkingInbox,
  isCheckingInbox,
  checkInbox,
  _checkInboxImpl,
};
