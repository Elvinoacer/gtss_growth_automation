/**
 * Instagram Reply Checker — Public API
 *
 * Re-exports the exact module.exports surface of the original
 * instagramReplyChecker.js so that downstream `require("../services/instagramReplyChecker")`
 * (and `require("./instagramReplyChecker")` from sibling services) calls
 * continue to resolve transparently to this directory's index file via
 * Node.js directory-index resolution.
 *
 * Public exports (unchanged from the original):
 *   - updateLeadReply
 *   - checkPrimaryInbox
 *   - checkMessageRequests
 *   - checkInbox
 *   - checkFollowBacks
 *   - isCheckingInbox
 *
 * Downstream callers:
 *   - src/jobs/pipelineScheduler.js: { checkInbox, isCheckingInbox }
 *   - src/jobs/backgroundJobs.js:    { checkFollowBacks }
 *   - src/jobs/scheduledPoster.js:   { isCheckingInbox }
 *   - src/automation/instagram/inboxProfile.js: { checkInbox } (lazy require)
 *   - src/services/replyDetector.js: { checkInbox } (aliased as checkInstagramInbox)
 *   - test/instagramReplyChecker.test.js: updateLeadReply, checkPrimaryInbox,
 *        checkMessageRequests, checkFollowBacks, checkInbox
 *   - test/instagram.test.js: checkInbox (monkey-patched in a stub test)
 */

const { updateLeadReply } = require("./persistence");
const { checkPrimaryInbox, checkMessageRequests } = require("./inboxScanning");
const { checkInbox, isCheckingInbox } = require("./checkInbox");
const { checkFollowBacks } = require("./followBacks");

module.exports = {
  updateLeadReply,
  checkPrimaryInbox,
  checkMessageRequests,
  checkInbox,
  checkFollowBacks,
  isCheckingInbox,
};
