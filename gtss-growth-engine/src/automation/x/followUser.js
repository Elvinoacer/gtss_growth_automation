/**
 * x/followUser.js
 *
 * followUser(page, profileUrl, emit) — Follow a user on X (Twitter).
 *
 * Flow:
 *   1. Navigate to the profile URL + wait for the page to settle.
 *   2. Check the account status via checkAccountStatus — return early
 *      with `outcome: "failed"` if the account is suspended / doesn't exist.
 *   3. Check the Pending selector — if visible, the follow request is
 *      already pending (return `outcome: "already_connected"`).
 *   4. Check the Unfollow selector — if visible, we're already following
 *      (return `outcome: "already_connected"`).
 *   5. Locate the Follow button via firstVisibleOnProfile — return
 *      `outcome: "failed"` if not found (profile may be restricted).
 *   6. Click the Follow button, wait 2-4s for state transition.
 *   7. detectActionWarning — if a rate-limit / "try again later" toast
 *      appears, return `outcome: "failed"` with failCategory="rate_limited"
 *      when the warning includes "limit".
 *   8. Verify the state transition (Unfollow or Pending button now visible).
 *      If neither appears, we still return `outcome: "sent"` (treat as
 *      success with warning) since X sometimes delays the DOM update.
 *
 * The `emit(type, message)` callback lets the caller stream live progress
 * events to its UI ("info" / "warn" / "error").
 *
 * Path notes: the original file used `require("./browserBase")` for
 * humanDelay — from this split file (one level deeper) that becomes
 * `require("../browserBase")`. The original `require("../utils/logger")`
 * becomes `require("../../utils/logger")` here.
 */

const { humanDelay } = require("../browserBase");
const logger = require("../../utils/logger");
const { SELECTORS } = require("./selectors");
const {
  checkAccountStatus,
  detectActionWarning,
  firstVisibleOnProfile,
} = require("./domHelpers");

/**
 * Follow a user on X (Twitter).
 */
async function followUser(page, profileUrl, emit) {
  try {
    emit("info", `Navigating to profile: ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await humanDelay(500, 1000);

    const status = await checkAccountStatus(page, emit);
    if (status.suspended) {
      return { outcome: "failed", failCategory: "suspended", reason: status.reason };
    }
    if (status.notFound) {
      return { outcome: "failed", failCategory: "not_found", reason: status.reason };
    }

    emit("info", "Profile loaded. Checking follow status...");

    const isPending = await firstVisibleOnProfile(page, SELECTORS.pending, 1000);
    if (isPending) {
      emit("warn", "Follow request is already pending/requested.");
      return { outcome: "already_connected", reason: "Follow request is pending" };
    }

    const isFollowing = await firstVisibleOnProfile(page, SELECTORS.unfollow, 1000);
    if (isFollowing) {
      emit("info", "Already following this profile.");
      return { outcome: "already_connected" };
    }

    const followBtn = await firstVisibleOnProfile(page, SELECTORS.follow, 3000);
    if (!followBtn) {
      emit("error", "Follow button not visible or profile restricted.");
      return { outcome: "failed", reason: "Follow button not found" };
    }

    emit("info", `Clicking Follow button (${followBtn.selector})...`);
    await followBtn.locator.click();
    await humanDelay(2000, 4000);

    const warning = await detectActionWarning(page);
    if (warning) {
      emit("error", `X follow warning: ${warning}`);
      if (warning.toLowerCase().includes("limit")) {
        return { outcome: "failed", failCategory: "rate_limited", reason: warning };
      }
      return { outcome: "failed", reason: warning };
    }

    // Verify state transition
    const nowFollowing = await firstVisibleOnProfile(page, SELECTORS.unfollow, 2000);
    const nowPending = await firstVisibleOnProfile(page, SELECTORS.pending, 1000);

    if (nowFollowing || nowPending) {
      emit("info", "Successfully completed Follow action.");
      return { outcome: "sent" };
    }

    emit("warn", "Follow state transition could not be verified in the DOM.");
    return { outcome: "sent" }; // Treat as success but warning
  } catch (err) {
    logger.error("X Follow Request Failed", { profileUrl, error: err.message });
    emit("error", `Follow failed: ${err.message}`);
    return { outcome: "failed", reason: err.message };
  }
}

module.exports = { followUser };
