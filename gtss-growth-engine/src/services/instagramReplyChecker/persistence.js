/**
 * instagramReplyChecker/persistence.js — reply touchpoint recording.
 *
 * After the inbox / message-request scanners detect a tracked lead's reply
 * and extract the bubble text, this module writes the touchpoint row,
 * transitions the lead to status='replied', then fans out to the email +
 * Slack notification channels in parallel via Promise.allSettled (so a
 * failing channel never breaks the touchpoint write).
 *
 * Extracted from the original instagramReplyChecker.js for maintainability.
 */

const { getDb } = require("../../db/database");
const logger = require("../../utils/logger");
const { sendReplyEmail, sendSlackNotification } = require("./notifications");

/**
 * Handle database log recording and trigger email dispatch for a lead reply.
 *
 * @param {number} leadId - The lead database ID.
 * @param {string} replyText - The reply content text.
 * @param {string} source - The source flow ('primary_inbox' or 'message_requests').
 */
async function updateLeadReply(leadId, replyText, source) {
  const db = getDb();

  // 1. Insert into touchpoints mapping source & timestamps
  db.prepare(
    `
    INSERT INTO touchpoints (lead_id, type, platform, notes, source, sent_at, created_at)
    VALUES (?, 'reply', 'instagram', ?, ?, datetime('now'), datetime('now'))
  `,
  ).run(leadId, replyText, source);

  // 2. Transition lead record status and update timestamps
  db.prepare(
    `
    UPDATE leads
    SET status = 'replied', replied_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `,
  ).run(leadId);

  // Retrieve full lead info for alert dispatching
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  if (!lead) {
    logger.warn(
      "INSTAGRAM_REPLY_CHECKER",
      `Lead ID ${leadId} not found in database for alert dispatching.`,
    );
    return;
  }

  // 3. Dispatch Nodemailer HTML alert and Slack webhook alert in parallel
  await Promise.allSettled([
    sendReplyEmail(lead, replyText, source),
    sendSlackNotification(lead, replyText, source),
  ]);
}

module.exports = {
  updateLeadReply,
};
