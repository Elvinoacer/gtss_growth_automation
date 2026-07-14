/**
 * Instagram Inbox & Profile (checkInbox, scrapeProfile)
 * - checkInbox delegates to the instagramReplyChecker service to scan the
 *   user's inbox for new replies.
 * - scrapeProfile is currently a stub returning { unsupported_operation }.
 * Extracted from the original instagram.js for maintainability.
 */

async function checkInbox() {
  const {
    checkInbox: scanInbox,
  } = require("../../services/instagramReplyChecker");
  return scanInbox();
}

async function scrapeProfile() {
  return { success: false, error: "unsupported_operation" };
}

module.exports = { checkInbox, scrapeProfile };
