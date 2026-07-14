/**
 * likeRecentPost tests.
 *
 * Verifies:
 *  - no-posts state handled gracefully (noPosts:true)
 *  - happy-path: clicks first grid post + Like svg, presses Escape to close modal
 *  - already-liked state detected (Unlike svg) — Like click skipped
 *  - selector_miss error when Like button is not found on the post modal
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { instagram, createMockPage } = require("./_helpers");

test("likeRecentPost handles no posts state gracefully", async () => {
  const noPostsPage = createMockPage({
    url: "https://www.instagram.com/no_posts_user/",
    visibleSelectors: [], // No grid posts
  });

  const result = await instagram.likeRecentPost(noPostsPage, {
    username: "no_posts_user",
  });
  assert.equal(result.success, true);
  assert.equal(result.noPosts, true);
});

test("likeRecentPost clicks to like post and closes modal", async () => {
  const likePage = createMockPage({
    url: "https://www.instagram.com/fresh_post_user/",
    visibleSelectors: ['article a[href*="/p/"]', 'svg[aria-label="Like"]'],
  });

  const result = await instagram.likeRecentPost(likePage, {
    username: "fresh_post_user",
  });
  assert.equal(result.success, true);
  assert.equal(result.liked, true);

  // Assert clicked the first post and the Like button, and pressed Escape to close modal
  assert.ok(likePage.clicks.includes('article a[href*="/p/"]'));
  assert.ok(likePage.clicks.includes('svg[aria-label="Like"]'));
  assert.ok(likePage.clicks.includes("Escape"));
});

test("likeRecentPost detects already-liked state and skips click", async () => {
  const alreadyLikedPage = createMockPage({
    url: "https://www.instagram.com/liked_post_user/",
    visibleSelectors: [
      'article a[href*="/p/"]',
      'svg[aria-label="Unlike"]', // Already liked!
    ],
  });

  const result = await instagram.likeRecentPost(alreadyLikedPage, {
    username: "liked_post_user",
  });
  assert.equal(result.success, true);
  assert.equal(result.alreadyLiked, true);

  // Assert clicked the first post, did NOT click the Like button, but pressed Escape to close
  assert.ok(alreadyLikedPage.clicks.includes('article a[href*="/p/"]'));
  assert.ok(!alreadyLikedPage.clicks.includes('svg[aria-label="Like"]'));
  assert.ok(!alreadyLikedPage.clicks.includes('svg[aria-label="Unlike"]'));
  assert.ok(alreadyLikedPage.clicks.includes("Escape"));
});

test("likeRecentPost returns selector_miss if like button is not found", async () => {
  const selectorMissPage = createMockPage({
    url: "https://www.instagram.com/miss_user/",
    visibleSelectors: [
      'article a[href*="/p/"]',
      // No like button selector!
    ],
  });

  const result = await instagram.likeRecentPost(selectorMissPage, {
    username: "miss_user",
  });
  assert.equal(result.success, false);
  assert.equal(result.error, "selector_miss");
});
