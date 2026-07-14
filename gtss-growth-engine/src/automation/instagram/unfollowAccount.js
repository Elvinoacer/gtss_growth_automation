/**
 * Instagram Unfollow Account (unfollowAccount)
 * Navigates to a target profile, opens the unfollow confirmation popover,
 * confirms, and updates the ig_follow_tracker database table.
 * Extracted from the original instagram.js for maintainability.
 */

const {
  humanDelay,
  firstVisible,
  humanMouseMove,
  isInstagramBlocked,
} = require("../browserBase");
const { getDb } = require("../../db/database");
const logger = require("../../utils/logger");
const { normalizeInstagramUsername } = require("../../utils/instagramUsername");

const { IG_SELECTORS } = require("./constants");
const { igDelay, safeEmit } = require("./emitter");

/**
 * Unfollow a target account on Instagram.
 * @param {object} page - Playwright page context
 * @param {object} params - Parameters object
 * @param {string} params.username - Target username
 * @param {number} [params.leadId] - Optional database lead ID overrides
 * @param {function} emitter - Log events emitter callback
 */
async function unfollowAccount(page, { username, leadId }, emitter) {
  try {
    const resolvedUsername = normalizeInstagramUsername(username);
    const blockState = isInstagramBlocked();
    if (blockState.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram action aborted: account is blocked until ${blockState.resumesAt}`,
      );
      return {
        success: false,
        error: "account_blocked",
        resumesAt: blockState.resumesAt,
      };
    }

    if (!resolvedUsername) {
      return { success: false, error: "username_missing" };
    }

    safeEmit(emitter, "info", `Navigating to @${resolvedUsername} to unfollow`);
    const profileUrl = `https://www.instagram.com/${resolvedUsername}/`;
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);

    // 1. Locate current Unfollow action
    const unfollowBtn = await firstVisible(
      page,
      IG_SELECTORS.unfollowButton,
      4000,
    );
    if (!unfollowBtn) {
      safeEmit(emitter, "info", `Not currently following @${username}`);
      return { success: true, notFollowing: true };
    }

    // 2. Open confirmation popover
    safeEmit(emitter, "info", "Clicking unfollow overlay trigger...");
    await humanMouseMove(page, unfollowBtn);
    await humanDelay(300, 700);
    await unfollowBtn.click();
    await humanDelay(1500, 2500);

    // 3. Confirm choice
    const confirmBtn = await firstVisible(
      page,
      IG_SELECTORS.unfollowConfirm,
      3500,
    );
    if (!confirmBtn) {
      safeEmit(emitter, "error", "Unfollow confirmation modal did not load.");
      return { success: false, error: "Unfollow confirm button not found" };
    }

    safeEmit(emitter, "info", "Confirming unfollow choice...");
    await humanMouseMove(page, confirmBtn);
    await humanDelay(300, 600);
    await confirmBtn.click();
    await page
      .waitForLoadState("domcontentloaded", { timeout: 5000 })
      .catch(() => {});

    // 4. Delay
    await igDelay("afterAction");

    // 5. Update database tracker record
    const db = getDb();
    let finalLeadId = leadId;
    if (!finalLeadId) {
      const leadMatch = db
        .prepare(
          "SELECT id FROM leads WHERE LOWER(ig_username) = LOWER(?) OR LOWER(profile_url) LIKE LOWER(?)",
        )
        .get(resolvedUsername, `%instagram.com/${resolvedUsername}%`);
      if (leadMatch) {
        finalLeadId = leadMatch.id;
      }
    }

    if (finalLeadId) {
      const trackerRecord = db
        .prepare(
          `
        SELECT id FROM ig_follow_tracker
        WHERE lead_id = ? AND LOWER(username) = LOWER(?)
        ORDER BY id DESC LIMIT 1
      `,
        )
        .get(finalLeadId, resolvedUsername);

      if (trackerRecord) {
        db.prepare(
          `
          UPDATE ig_follow_tracker
          SET status = 'unfollowed', unfollowed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
        ).run(trackerRecord.id);
      } else {
        db.prepare(
          `
          INSERT INTO ig_follow_tracker (lead_id, username, status, unfollowed_at)
          VALUES (?, ?, 'unfollowed', CURRENT_TIMESTAMP)
        `,
        ).run(finalLeadId, resolvedUsername);
      }
    } else {
      // General match based on username alone
      db.prepare(
        `
        UPDATE ig_follow_tracker
        SET status = 'unfollowed', unfollowed_at = CURRENT_TIMESTAMP
        WHERE username = ? AND status != 'unfollowed'
      `,
      ).run(resolvedUsername);
    }

    safeEmit(emitter, "done", `Successfully unfollowed @${resolvedUsername}`);
    return { success: true };
  } catch (err) {
    logger.error("Instagram unfollowAccount Failed", {
      username,
      error: err.message,
    });
    safeEmit(emitter, "error", `Unfollow action failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { unfollowAccount };
