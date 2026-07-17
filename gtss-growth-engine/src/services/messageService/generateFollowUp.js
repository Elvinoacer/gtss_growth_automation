/**
 * messageService/generateFollowUp.js
 *
 * Generate a brief, non-pushy follow-up message for a lead that already
 * received an outreach message. Calls Gemini with the original message
 * body + the number of days since it was sent, asks for ≤300 chars back.
 *
 * Falls back to a hardcoded template-fallback body if Gemini fails (so
 * the follow-up queue never deadlocks on a transient AI outage). The
 * fallback row is stamped generated_by='template-fallback'.
 *
 * Returns { id, body } on success, plus generatedBy: 'template-fallback'
 * on the fallback path (so callers can tell which path produced the row).
 */

const { getDb } = require("../../db/database");
const { getPrimaryPlatform } = require("../platformCatalog");
const { callGeminiText, unwrapGeminiText } = require("../aiService");
const logger = require("../../utils/logger");
const {
  getCharLimit,
  getFirstName,
  stripCodeFences,
  sanitizeOutreachBody,
} = require("./templates");

async function generateFollowUp(leadId) {
  const db = getDb();
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  if (!lead) throw new Error(`Lead ${leadId} not found`);
  const resolvedPlatform = lead.platform || getPrimaryPlatform();

  const originalMsg = db
    .prepare(
      `SELECT * FROM messages
     WHERE lead_id = ? AND is_follow_up = 0 AND status IN ('sent', 'approved')
     ORDER BY generated_at DESC LIMIT 1`,
    )
    .get(leadId);

  const daysSince = originalMsg
    ? Math.floor(
        (Date.now() -
          new Date(
            originalMsg.sent_at ||
              originalMsg.approved_at ||
              originalMsg.generated_at,
          ).getTime()) /
          86400000,
      )
    : 7;

  const prompt = `Generate a brief, non-pushy follow-up for ${resolvedPlatform}.
Name: ${lead.name}. Sent ${daysSince} days ago.
Original: "${originalMsg ? originalMsg.body.slice(0, 100) : ""}"
Rules: plain text only; never use placeholder tokens like [link], [url], or (link).
Return ONLY the message body (max 300 chars).`;

  try {
    const generation = await callGeminiText(prompt);
    const body = unwrapGeminiText(generation);
    logger.db("info", "outreach", "message_follow_up", "Gemini follow-up response received", {
      leadId,
      source: generation.source || "unknown",
      model: generation.model,
    });
    let cleanBody = sanitizeOutreachBody(
      stripCodeFences(body).replace(/^["']|["']$/g, ""),
    );

    // Strict character limit enforcement for follow-up DMs
    const limit = getCharLimit(resolvedPlatform, "dm");
    if (cleanBody.length > limit) {
      cleanBody = cleanBody.slice(0, limit);
    }

    const result = db
      .prepare(
        `INSERT INTO messages (lead_id, platform, body, variant, is_follow_up, status, generated_at)
       VALUES (?, ?, ?, 'A', 1, 'pending', CURRENT_TIMESTAMP)`,
      )
      .run(leadId, resolvedPlatform, cleanBody);

    return { id: result.lastInsertRowid, body: cleanBody };
  } catch (error) {
    logger.warn(
      "MESSAGES",
      `Gemini follow-up failed for lead ${leadId}, using template fallback`,
      { error: error.message },
    );
    const fallbackBody = `Hi ${getFirstName(lead.name)}, just following up on my earlier message. Would love to connect and share how Restaurant Manager could help your business. Are you available for a quick chat?`.slice(0, 300);
    const result = db
      .prepare(
        `INSERT INTO messages (lead_id, platform, body, variant, is_follow_up, status, generated_by, generated_at)
       VALUES (?, ?, ?, 'A', 1, 'pending', 'template-fallback', CURRENT_TIMESTAMP)`,
      )
      .run(leadId, resolvedPlatform, fallbackBody);

    return { id: result.lastInsertRowid, body: fallbackBody, generatedBy: "template-fallback" };
  }
}

module.exports = { generateFollowUp };
