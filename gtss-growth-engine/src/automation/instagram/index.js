/**
 * Instagram Automation Module — Index
 * Re-exports the public API of the Instagram automation module so callers that
 * `require('./instagram')` continue to receive the exact same shape.
 *
 * The original instagram.js (~3,072 lines) was split into thematic files
 * inside this directory for maintainability. See individual file headers
 * for detail on each concern.
 *
 * Public API (preserved verbatim from the original module.exports):
 *   - followAccount
 *   - unfollowAccount
 *   - sendDM
 *   - likeRecentPost
 *   - viewStory
 *   - postImage
 *   - postStory
 *   - postCarousel
 *   - checkInbox
 *   - scrapeProfile
 *   - diagnoseCreatePostFlow
 *   - attemptCreatePostClicks
 *   - getSelectorHealthReport (re-exported from ../browserBase)
 */

const { followAccount } = require("./followAccount");
const { unfollowAccount } = require("./unfollowAccount");
const { sendDM } = require("./directMessage");
const { likeRecentPost, viewStory } = require("./storyActions");
const { postImage } = require("./postImage");
const { postStory } = require("./postStory");
const { postCarousel } = require("./postCarousel");
const { checkInbox, scrapeProfile } = require("./inboxProfile");
const {
  diagnoseCreatePostFlow,
  attemptCreatePostClicks,
} = require("./diagnoseCreatePost");
const { getSelectorHealthReport } = require("../browserBase"); // re-exported

module.exports = {
  followAccount,
  unfollowAccount,
  sendDM,
  likeRecentPost,
  viewStory,
  postImage,
  postStory,
  postCarousel,
  checkInbox,
  scrapeProfile,
  diagnoseCreatePostFlow,
  attemptCreatePostClicks,
  getSelectorHealthReport,
};
