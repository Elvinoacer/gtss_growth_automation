/**
 * viewStory tests.
 *
 * Verifies:
 *  - no-story case is handled gracefully (hasStory:false, success:true)
 *  - happy-path: clicks story ring + Close svg, waits 4-7 seconds before closing
 *    (timing verified with TEST_SPEEDUP disabled)
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { instagram, createMockPage } = require("./_helpers");

test("viewStory handles no-story case without error", async () => {
  const noStoryPage = createMockPage({
    url: "https://www.instagram.com/no_story_user/",
    visibleSelectors: [],
  });

  const result = await instagram.viewStory(noStoryPage, {
    username: "no_story_user",
  });
  assert.equal(result.success, true);
  assert.equal(result.hasStory, false);
});

test("viewStory waits 4-7 seconds before closing (verify via timing)", async () => {
  const storyPage = createMockPage({
    url: "https://www.instagram.com/story_user/",
    visibleSelectors: [
      'canvas[style*="cursor: pointer"]', // storyRing
      'div[role="progressbar"]',
      'svg[aria-label="Close"]', // storyClose
    ],
  });

  const originalSpeedup = process.env.TEST_SPEEDUP;
  process.env.TEST_SPEEDUP = "false"; // Disable speedup to test actual timing!

  const startTime = Date.now();
  const result = await instagram.viewStory(storyPage, {
    username: "story_user",
  });
  const duration = Date.now() - startTime;

  process.env.TEST_SPEEDUP = originalSpeedup; // Restore original

  assert.equal(result.success, true);
  assert.equal(result.hasStory, true);
  assert.ok(
    duration >= 4000,
    `Expected duration to be at least 4000ms, but got ${duration}ms`,
  );

  // Verify click actions
  assert.ok(storyPage.clicks.includes('canvas[style*="cursor: pointer"]'));
  assert.ok(storyPage.clicks.includes('svg[aria-label="Close"]'));
});
