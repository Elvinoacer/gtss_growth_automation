/**
 * messages/regenerateRoutes.js — POST /api/messages/:id/regenerate.
 *
 * Deletes existing pending variants for the lead and re-runs the message
 * generator. Used by the "Regenerate" button on the Messages page.
 *
 * Original routes/messages.js was 561 lines; this is one of its thematic
 * splits. Relative require paths were updated for the new directory depth.
 */

const { getDb } = require("../../db/database");
const { generateMessages } = require("../../services/messageService");

module.exports = function registerRegenerateRoutes(router) {
  router.post("/api/messages/:id/regenerate", async (req, res) => {
    try {
      const db = getDb();
      const id = Number(req.params.id);

      const msg = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
      if (!msg) return res.status(404).json({ error: "Message not found" });

      // Delete existing pending variants for this lead
      db.prepare(
        `DELETE FROM messages
       WHERE lead_id = ? AND status = 'pending' AND is_follow_up = 0`,
      ).run(msg.lead_id);

      const { productPitch, tone } = req.body || {};
      const result = await generateMessages(
        msg.lead_id,
        msg.platform || null,
        null,
        tone || "friendly",
      );

      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
};
