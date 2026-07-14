/**
 * Inbox & scrape profile tests.
 *
 * Verifies:
 *  - checkInbox delegates to instagramReplyChecker and reports counts
 *  - scrapeProfile reports an unsupported_operation result (per current scope)
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { instagram } = require("./_helpers");

test("Inbox helpers delegate to the working reply checker or report unsupported operations", async () => {
  const replyChecker = require("../../src/services/instagramReplyChecker");
  const originalCheckInbox = replyChecker.checkInbox;
  replyChecker.checkInbox = async () => ({
    success: true,
    primaryUnreadCount: 0,
    requestsCount: 0,
  });

  try {
    const inboxResult = await instagram.checkInbox();
    assert.equal(inboxResult.success, true);
    assert.equal(typeof inboxResult.primaryUnreadCount, "number");
    assert.equal(typeof inboxResult.requestsCount, "number");
  } finally {
    replyChecker.checkInbox = originalCheckInbox;
  }

  const scrapeResult = await instagram.scrapeProfile();
  assert.deepEqual(scrapeResult, {
    success: false,
    error: "unsupported_operation",
  });
});
