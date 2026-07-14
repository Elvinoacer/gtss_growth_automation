/**
 * Module export surface test for src/automation/instagram.
 *
 * Verifies the Instagram module exports all 10 outreach functions used by
 * the executor + platform adapter.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { instagram } = require("./_helpers");

test("Instagram module exports all 10 outreach functions", () => {
  const expected = [
    "followAccount",
    "unfollowAccount",
    "sendDM",
    "likeRecentPost",
    "viewStory",
    "postImage",
    "postStory",
    "postCarousel",
    "checkInbox",
    "scrapeProfile",
  ];
  for (const name of expected) {
    assert.equal(typeof instagram[name], "function", `Missing export: ${name}`);
  }
});
