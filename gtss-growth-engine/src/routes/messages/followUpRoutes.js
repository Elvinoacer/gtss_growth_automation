/**
 * messages/followUpRoutes.js — Follow-up related routes.
 *
 * Routes:
 *   GET  /api/messages/follow-ups          (list leads whose follow-up window
 *                                           has opened, with their existing
 *                                           follow-up draft if any)
 *   POST /api/messages/follow-up/:leadId   (generate a follow-up message for
 *                                           a specific lead)
 *   PATCH /api/messages/:id/snooze         (snooze a follow-up for N days)
 *
 * Original routes/messages.js was 561 lines; this is one of its thematic
 * splits. Relative require paths were updated for the new directory depth.
 */

const { getDb } = require("../../db/database");
const { generateFollowUp } = require("../../services/messageService");

module.exports = function registerFollowUpRoutes(router) {
  // ---------------------------------------------------------------------------
  // API: Follow-ups due
  // ---------------------------------------------------------------------------
  router.get("/api/messages/follow-ups", (req, res) => {
    const db = getDb();

    const followUpDays = (() => {
      const row = db
        .prepare("SELECT value FROM settings WHERE key = 'follow_up_days'")
        .get();
      return row ? Number(row.value) || 5 : 5;
    })();

    const leads = db
      .prepare(
        `SELECT DISTINCT l.*,
            m.id AS message_id,
            m.body AS original_message,
            m.platform AS msg_platform,
            m.sent_at,
            m.snooze_until,
            CAST(julianday('now') - julianday(COALESCE(m.sent_at, m.approved_at)) AS INTEGER) AS days_since
     FROM messages m
     JOIN leads l ON l.id = m.lead_id
     WHERE m.status = 'sent'
       AND m.is_follow_up = 0
       AND l.status NOT IN ('replied', 'meeting_booked', 'converted')
       AND datetime(COALESCE(m.sent_at, m.approved_at), '+' || @days || ' days') <= datetime('now')
       AND (m.snooze_until IS NULL OR datetime(m.snooze_until) <= datetime('now'))
     ORDER BY days_since DESC`,
      )
      .all({ days: followUpDays });

    // Attach existing follow-up drafts if they exist
    const result = leads.map((lead) => {
      const followUp = db
        .prepare(
          `SELECT * FROM messages
       WHERE lead_id = ? AND is_follow_up = 1 AND status = 'pending'
       ORDER BY generated_at DESC LIMIT 1`,
        )
        .get(lead.id);

      return { ...lead, followUpDraft: followUp || null };
    });

    return res.json({ leads: result, followUpDays });
  });

  // ---------------------------------------------------------------------------
  // API: Generate follow-up for a specific lead
  // ---------------------------------------------------------------------------
  router.post("/api/messages/follow-up/:leadId", async (req, res) => {
    try {
      const leadId = Number(req.params.leadId);
      const result = await generateFollowUp(leadId);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // API: Snooze follow-up
  // ---------------------------------------------------------------------------
  router.patch("/api/messages/:id/snooze", (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const days = Number(req.body.days) || 3;

    db.prepare(
      `UPDATE messages SET snooze_until = datetime('now', '+' || @days || ' days') WHERE id = ?`,
    ).run({ days }, id);

    return res.json({ success: true, id, snoozedFor: days });
  });
};
