/**
 * LinkedIn Like Recent Post
 * likeRecentPost — navigate to a profile's recent-activity feed and like the
 * first unliked post. Extracted from the original linkedin.js for
 * maintainability.
 */

const { humanDelay, humanScroll } = require("../browserBase");
const logger = require("../../utils/logger");
const { SELECTORS } = require("./selectors");
const { firstVisible } = require("./profileActions");

/**
 * Like a recent post on the user's profile to warm them up.
 */
async function likeRecentPost(page, profileUrl, emit) {
  try {
    // LinkedIn post URLs often look like /in/username/recent-activity/all/
    const activityUrl = profileUrl.replace(/\/$/, "") + "/recent-activity/all/";
    emit("info", `Navigating to activity feed: ${activityUrl}`);

    await page.goto(activityUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);
    await humanScroll(page);

    // Look for posts
    // Note: LinkedIn changes classes frequently, these are approximate representations
    const likeMatch = await firstVisible(page, SELECTORS.unlikePost, 3000);

    if (!likeMatch) {
      emit("info", "No unliked posts found on the recent activity page.");
      return { outcome: "no_posts" };
    }

    emit(
      "info",
      `Found an unliked post (${likeMatch.selector}). Liking the most recent one...`,
    );

    // Scroll element into view
    await likeMatch.locator.scrollIntoViewIfNeeded();
    await humanDelay(1000, 2000);

    await likeMatch.locator.click();
    await humanDelay(2000, 3000);

    emit("info", "Successfully liked a recent post.");
    return { outcome: "liked" };
  } catch (err) {
    logger.error("LinkedIn Like Post Failed", {
      profileUrl,
      error: err.message,
    });
    emit("error", `Liking post failed: ${err.message}`);
    return { outcome: "failed", reason: err.message };
  }
}

module.exports = { likeRecentPost };
