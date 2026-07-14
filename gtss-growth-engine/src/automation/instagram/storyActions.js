/**
 * Instagram Story & Like Actions (viewStory, likeRecentPost)
 * viewStory opens a target user's story ring, watches it briefly, then
 * closes the viewer. likeRecentPost opens the most-recent grid post and
 * clicks the Like button if not already liked.
 * Extracted from the original instagram.js for maintainability.
 */

const {
  humanDelay,
  firstVisible,
  checkForInstagramBlock,
  humanMouseMove,
  isInstagramBlocked,
} = require("../browserBase");
const logger = require("../../utils/logger");
const { normalizeInstagramUsername } = require("../../utils/instagramUsername");

const { IG_SELECTORS } = require("./constants");
const { igDelay, safeEmit } = require("./emitter");

/**
 * View a target account's currently-active Instagram story.
 * @param {object} page - Playwright page context
 * @param {object} params - Parameters object
 * @param {string} params.username - Target username
 * @param {function} emitter - Log events emitter callback
 */
async function viewStory(page, { username }, emitter) {
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

    safeEmit(
      emitter,
      "info",
      `Navigating to @${resolvedUsername} to view story`,
    );
    const profileUrl = `https://www.instagram.com/${resolvedUsername}/`;
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);

    // 1. Check for Action blocks
    const blockCheck = await checkForInstagramBlock(page);
    if (blockCheck.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram block detected: ${blockCheck.reason}`,
      );
      return { success: false, error: blockCheck.reason };
    }

    // 2. Scan profile for active story ring
    const ringEl = await firstVisible(page, IG_SELECTORS.storyRing, 3000).catch(
      () => null,
    );
    if (!ringEl) {
      safeEmit(emitter, "info", "No active story found");
      return { success: true, hasStory: false };
    }

    // 3. Move mouse naturally to story ring element and click
    await humanMouseMove(page, ringEl);
    await humanDelay(300, 700);
    await ringEl.click();

    // 4. Wait for story viewer progressbar
    try {
      await page.waitForSelector('div[role="progressbar"]', { timeout: 5000 });
    } catch (err) {
      safeEmit(
        emitter,
        "info",
        "Story viewer did not open within timeout, assuming no active story.",
      );
      return { success: true, hasStory: false };
    }

    // 5. Watch the story for a human-like duration (4-7 seconds)
    safeEmit(emitter, "info", "Watching story...");
    await humanDelay(4000, 7000);

    // 6. Dismiss the story viewer
    const closeBtn = await firstVisible(
      page,
      IG_SELECTORS.storyClose,
      2000,
    ).catch(() => null);
    if (closeBtn) {
      await humanMouseMove(page, closeBtn);
      await humanDelay(300, 600);
      await closeBtn.click();
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }

    // 7. Nairobi afterAction delay
    await igDelay("afterAction");

    safeEmit(
      emitter,
      "done",
      `Successfully watched story for @${resolvedUsername}`,
    );
    return { success: true, hasStory: true };
  } catch (err) {
    logger.error("Instagram viewStory Failed", {
      username,
      error: err.message,
    });
    safeEmit(emitter, "error", `View story action failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Like the most-recent post on a target account's grid.
 * @param {object} page - Playwright page context
 * @param {object} params - Parameters object
 * @param {string} params.username - Target username
 * @param {function} emitter - Log events emitter callback
 */
async function likeRecentPost(page, { username }, emitter) {
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

    safeEmit(
      emitter,
      "info",
      `Navigating to @${resolvedUsername} to like recent post`,
    );
    const profileUrl = `https://www.instagram.com/${resolvedUsername}/`;
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);

    // 1. Check for Action blocks
    const blockCheck = await checkForInstagramBlock(page);
    if (blockCheck.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram block detected: ${blockCheck.reason}`,
      );
      return { success: false, error: blockCheck.reason };
    }

    // 2. Find the first post in the grid
    const posts = page.locator('article a[href*="/p/"]');
    const count = await posts.count().catch(() => 0);
    if (count === 0) {
      safeEmit(emitter, "info", "No posts found");
      return { success: true, noPosts: true };
    }
    const firstPost = posts.first();

    // 3. Hover/move mouse and click first post to open it
    await humanMouseMove(page, firstPost);
    await humanDelay(300, 700);
    await firstPost.click();

    // 4. Wait for post modal/page to load by searching for the Like button
    const likeBtn = await firstVisible(
      page,
      IG_SELECTORS.likeButton,
      5000,
    ).catch(() => null);
    if (!likeBtn) {
      safeEmit(
        emitter,
        "warn",
        "Selector miss: Like button not found after clicking post.",
      );
      return { success: false, error: "selector_miss" };
    }

    // 5. Check if already liked: if svg aria-label is "Unlike" or descendant svg has aria-label="Unlike"
    let isLiked = false;
    const selfLabel = await likeBtn.getAttribute("aria-label").catch(() => "");
    if (selfLabel && selfLabel.toLowerCase() === "unlike") {
      isLiked = true;
    } else {
      const descendantUnlike = await likeBtn
        .$('svg[aria-label="Unlike"]')
        .catch(() => null);
      const descendantUnlikeEl = await likeBtn
        .$('[aria-label="Unlike"]')
        .catch(() => null);
      if (descendantUnlike || descendantUnlikeEl) {
        isLiked = true;
      }
    }

    if (isLiked) {
      safeEmit(emitter, "info", `Post is already liked by us.`);
      await page.keyboard.press("Escape").catch(() => {});
      return { success: true, alreadyLiked: true };
    }

    // 6. Move mouse naturally and click Like
    await humanMouseMove(page, likeBtn);
    await humanDelay(300, 700);
    await likeBtn.click();

    // 7. Nairobi afterAction delay
    await igDelay("afterAction");

    // 8. Close the post modal (Escape key)
    await page.keyboard.press("Escape").catch(() => {});

    safeEmit(
      emitter,
      "done",
      `Successfully liked recent post for @${resolvedUsername}`,
    );
    return { success: true, liked: true };
  } catch (err) {
    logger.error("Instagram likeRecentPost Failed", {
      username,
      error: err.message,
    });
    safeEmit(emitter, "error", `Like recent post failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { viewStory, likeRecentPost };
