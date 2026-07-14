/**
 * x/likeRecentPost.js
 *
 * likeRecentPost(page, profileUrl, emit) — Like a recent tweet on the
 * user's profile timeline to warm them up before following / messaging.
 *
 * Flow:
 *   1. Navigate to the profile URL + humanScroll (trigger lazy-load of
 *      the timeline).
 *   2. Locate the first tweet via SELECTORS.tweet — return
 *      `outcome: "no_posts"` if none visible.
 *   3. Iterate the first 5 tweets; for each, check whether the Unlike
 *      selector is already visible (i.e., the tweet is already liked) —
 *      skip if so. Otherwise locate the Like selector, scroll it into
 *      view, click it, wait 2-3s, and return `outcome: "liked"`.
 *   4. If all 5 tweets are already liked, return `outcome: "no_posts"`.
 *
 * The `emit(type, message)` callback lets the caller stream live progress
 * events to its UI ("info" / "warn" / "error").
 *
 * Path notes: the original file used `require("./browserBase")` for
 * humanDelay + humanScroll — from this split file (one level deeper) that
 * becomes `require("../browserBase")`. The original
 * `require("../utils/logger")` becomes `require("../../utils/logger")` here.
 */

const { humanDelay, humanScroll } = require("../browserBase");
const logger = require("../../utils/logger");
const { SELECTORS } = require("./selectors");
const { firstVisible } = require("./domHelpers");

/**
 * Like a recent tweet on the user's profile timeline to warm them up.
 */
async function likeRecentPost(page, profileUrl, emit) {
  try {
    emit("info", `Liking recent post on X profile: ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);
    await humanScroll(page);
    await humanDelay(1000, 2000);

    // Wait for tweets to load on timeline
    const tweetMatch = await firstVisible(page, SELECTORS.tweet, 5000);
    if (!tweetMatch) {
      emit("info", "No recent tweets visible on the user profile timeline.");
      return { outcome: "no_posts" };
    }

    emit("info", "Timeline loaded. Locating first unliked tweet...");

    const tweets = page.locator(SELECTORS.tweet);
    const count = await tweets.count().catch(() => 0);

    for (let i = 0; i < Math.min(count, 5); i++) {
      const tweet = tweets.nth(i);
      const isAlreadyLiked = await tweet.locator(SELECTORS.unlike[0]).first().isVisible().catch(() => false);
      if (isAlreadyLiked) {
        emit("info", `Skipping already-liked tweet at position ${i + 1}.`);
        continue;
      }

      const likeBtn = tweet.locator(SELECTORS.like[0]).first();
      if (await likeBtn.isVisible()) {
        emit("info", `Liking tweet at index ${i}...`);
        await likeBtn.scrollIntoViewIfNeeded();
        await humanDelay(500, 1000);
        await likeBtn.click();
        await humanDelay(2000, 3000);

        emit("info", "Successfully liked the recent tweet.");
        return { outcome: "liked" };
      }
    }

    emit("info", "All loaded tweets in range are already liked.");
    return { outcome: "no_posts" };
  } catch (err) {
    logger.error("X Like Post Failed", { profileUrl, error: err.message });
    emit("error", `Liking post failed: ${err.message}`);
    return { outcome: "failed", reason: err.message };
  }
}

module.exports = { likeRecentPost };
