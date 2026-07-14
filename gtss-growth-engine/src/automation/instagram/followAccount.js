/**
 * Instagram Follow Account (followAccount)
 * Navigates to a target profile, locates the Follow control, clicks it, and
 * records the transition in the ig_follow_tracker database table.
 * Extracted from the original instagram.js for maintainability.
 */

const {
  humanDelay,
  firstVisible,
  checkForInstagramBlock,
  humanMouseMove,
  isInstagramBlocked,
} = require("../browserBase");
const { getDb } = require("../../db/database");
const logger = require("../../utils/logger");
const { normalizeInstagramUsername } = require("../../utils/instagramUsername");

const { IG_SELECTORS } = require("./constants");
const { igDelay, safeEmit } = require("./emitter");

/**
 * Follow a target account on Instagram.
 * @param {object} page - Playwright page context
 * @param {object} params - Parameters object
 * @param {string} params.username - Target username
 * @param {number} [params.leadId] - Optional database lead ID overrides
 * @param {function} emitter - Log events emitter callback
 */
async function followAccount(page, { username, leadId }, emitter) {
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

    safeEmit(emitter, "info", `Navigating to @${resolvedUsername} to follow`);
    const profileUrl = `https://www.instagram.com/${resolvedUsername}/`;
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);

    const blockCheck = await checkForInstagramBlock(page);
    if (blockCheck.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram block detected: ${blockCheck.reason}`,
      );
      return { success: false, error: blockCheck.reason };
    }

    // 1. Locate current Follow action
    const followBtn = await firstVisible(page, IG_SELECTORS.followButton, 4000);
    if (!followBtn) {
      const unfollowBtn = await firstVisible(
        page,
        IG_SELECTORS.unfollowButton,
        4000,
      ).catch(() => null);

      if (unfollowBtn) {
        const btnText = await unfollowBtn.innerText().catch(() => "");
        if (btnText.toLowerCase().includes("requested")) {
          safeEmit(
            emitter,
            "info",
            `Follow request is already pending/requested for @${username}`,
          );
          return { success: true, requestPending: true };
        }

        safeEmit(emitter, "info", `Already following @${username}`);
        return { success: true, alreadyFollowing: true };
      }

      safeEmit(
        emitter,
        "error",
        `Could not find a follow control for @${resolvedUsername}`,
      );
      return { success: false, error: "follow_button_not_found" };
    }

    // Double check followBtn text in case it indicates requested/following state
    const followText = await followBtn.innerText().catch(() => "");
    if (followText.toLowerCase().includes("requested")) {
      safeEmit(
        emitter,
        "info",
        `Follow request is already pending/requested for @${username}`,
      );
      return { success: true, requestPending: true };
    }
    if (followText.toLowerCase().includes("following")) {
      safeEmit(emitter, "info", `Already following @${username}`);
      return { success: true, alreadyFollowing: true };
    }

    // 3. Initiate follow click with human mouse movement
    safeEmit(emitter, "info", `Attempting to follow @${username}`);
    await humanMouseMove(page, followBtn);
    await humanDelay(300, 700);
    await followBtn.click();
    await page
      .waitForLoadState("domcontentloaded", { timeout: 5000 })
      .catch(() => {});

    // 4. Handle private account dialogue or generic popup alerts if they appear
    await humanDelay(1500, 2500);
    const popupConfirm = await firstVisible(
      page,
      [
        'button:has-text("OK")',
        'button:has-text("Confirm")',
        'button:has-text("Dismiss")',
      ],
      1500,
    ).catch(() => null);

    if (popupConfirm) {
      safeEmit(
        emitter,
        "info",
        "Dismissing private confirmation or info dialogue...",
      );
      await humanMouseMove(page, popupConfirm);
      await humanDelay(300, 600);
      await popupConfirm.click();
      await humanDelay(1000, 2000);
    }

    // 5. Assert follow state transition
    const postFollowBtn = await firstVisible(
      page,
      IG_SELECTORS.unfollowButton,
      2000,
    ).catch(() => null);
    let requestPending = false;
    if (postFollowBtn) {
      const postText = await postFollowBtn.innerText().catch(() => "");
      if (postText.toLowerCase().includes("requested")) {
        requestPending = true;
      }
    }

    // 6. Nairobi delay action
    await igDelay("afterAction");

    // 7. Log to database: Find or upsert a lead record first to respect Foreign Key checks
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
      } else {
        const insertInfo = db
          .prepare(
            `
          INSERT INTO leads (platform, name, profile_url, ig_username, status)
          VALUES (?, ?, ?, ?, ?)
        `,
          )
          .run(
            "instagram",
            resolvedUsername,
            profileUrl,
            resolvedUsername,
            "discovered",
          );
        finalLeadId = insertInfo.lastInsertRowid;
      }
    }

    // Insert follow tracker entry
    const leadRow = db
      .prepare("SELECT source_keyword FROM leads WHERE id = ?")
      .get(finalLeadId);
    const sourceKeyword = leadRow ? leadRow.source_keyword : null;

    const finalStatus = requestPending ? "requested" : "following";
    const trackerRecord = db
      .prepare(
        "SELECT id FROM ig_follow_tracker WHERE lead_id = ? AND LOWER(username) = LOWER(?)",
      )
      .get(finalLeadId, resolvedUsername);
    if (trackerRecord) {
      db.prepare(
        `
        UPDATE ig_follow_tracker
        SET status = ?, followed_at = CURRENT_TIMESTAMP, unfollowed_at = NULL, follow_source = ?
        WHERE id = ?
      `,
      ).run(finalStatus, sourceKeyword, trackerRecord.id);
    } else {
      db.prepare(
        `
        INSERT INTO ig_follow_tracker (lead_id, username, status, followed_at, follow_source)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
      `,
      ).run(finalLeadId, resolvedUsername, finalStatus, sourceKeyword);
    }

    safeEmit(
      emitter,
      "done",
      `Successfully followed @${resolvedUsername} (State: ${finalStatus})`,
    );
    return { success: true, requestPending };
  } catch (err) {
    logger.error("Instagram followAccount Failed", {
      username,
      error: err.message,
    });
    safeEmit(emitter, "error", `Follow action failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { followAccount };
