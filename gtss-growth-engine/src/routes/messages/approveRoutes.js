/**
 * messages/approveRoutes.js — Message approve / bulk-approve / skip routes.
 *
 * Routes:
 *   PATCH /api/messages/:id/approve      (approve a single pending message,
 *                                         skip its sibling variant, promote
 *                                         lead to 'message_approved')
 *   POST  /api/messages/bulk-approve     (bulk-approve all pending messages
 *                                         of a given variant "A" or "B";
 *                                         wrapped in a transaction)
 *   PATCH /api/messages/:id/skip         (skip a message + its sibling
 *                                         variant + deprioritize the lead)
 *
 * All three routes broadcast a `messages:mutation` Socket.IO event so any
 * open Messages tab can re-fetch.
 *
 * Original routes/messages.js was 561 lines; this is one of its thematic
 * splits. Relative require paths were updated for the new directory depth.
 */

const { getDb } = require("../../db/database");
const { broadcast } = require("../../services/socketService");

module.exports = function registerApproveRoutes(router) {
  // ---------------------------------------------------------------------------
  // API: Approve a message
  // ---------------------------------------------------------------------------
  router.patch("/api/messages/:id/approve", (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const { body } = req.body;

    const msg = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    if (!msg) return res.status(404).json({ error: "Message not found" });
    if (msg.status !== "pending")
      return res
        .status(400)
        .json({ error: "Only pending messages can be approved" });

    db.prepare(
      `UPDATE messages
     SET body = ?, status = 'approved', approved_by = 'founder', approved_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    ).run(body || msg.body, id);

    // A newly approved message replaces any older, unsent approval for this
    // same outreach. Without this, the Automation queue can see both an old
    // template fallback and the founder-selected Gemini message.
    db.prepare(
      `UPDATE messages
       SET status = 'skipped'
       WHERE lead_id = ?
         AND COALESCE(platform, '') = COALESCE(?, '')
         AND COALESCE(is_follow_up, 0) = COALESCE(?, 0)
         AND id != ?
         AND status = 'approved'`,
    ).run(msg.lead_id, msg.platform, msg.is_follow_up, id);

    db.prepare(
      "UPDATE leads SET status = 'message_approved', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'qualified'",
    ).run(msg.lead_id);

    // Skip the other variant for this lead
    db.prepare(
      `UPDATE messages
     SET status = 'skipped'
     WHERE lead_id = ? AND id != ? AND status = 'pending' AND is_follow_up = ?`,
    ).run(msg.lead_id, id, msg.is_follow_up);

    broadcast("messages:mutation", {
      type: "approved",
      messageId: id,
      leadId: msg.lead_id,
    });
    return res.json({ success: true, id });
  });

  // ---------------------------------------------------------------------------
  // API: Bulk-approve all pending messages of a given variant ("A" or "B")
  //
  // Body: { variant: "A" | "B" }
  //
  // For every lead that currently has BOTH a pending variant-A and a pending
  // variant-B message (is_follow_up = 0), this approves the chosen variant and
  // skips the sibling. Leads that only have ONE pending variant get that one
  // approved. Already-approved / sent / skipped messages are left untouched.
  //
  // This is the backend that powers the "Approve All A" / "Approve All B"
  // buttons on the Messages page.
  // ---------------------------------------------------------------------------
  router.post("/api/messages/bulk-approve", (req, res) => {
    const db = getDb();
    const variant = String(req.body && req.body.variant || "").toUpperCase() === "A" ? "A" : "B";

    // Lock the leads table briefly so concurrent approvals don't race.
    const approveStmt = db.prepare(
      `UPDATE messages
     SET status = 'approved', approved_by = 'founder', approved_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'pending'`,
    );
    const skipSiblingStmt = db.prepare(
      `UPDATE messages
     SET status = 'skipped'
     WHERE lead_id = ? AND id != ? AND status = 'pending' AND is_follow_up = ?`,
    );
    const retirePriorApprovalStmt = db.prepare(
      `UPDATE messages
       SET status = 'skipped'
       WHERE lead_id = ?
         AND COALESCE(platform, '') = COALESCE(?, '')
         AND COALESCE(is_follow_up, 0) = COALESCE(?, 0)
         AND id != ?
         AND status = 'approved'`,
    );
    const promoteLeadStmt = db.prepare(
      "UPDATE leads SET status = 'message_approved', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'qualified'",
    );

    // Find every pending, non-follow-up message of the requested variant.
    const targets = db
      .prepare(
        `SELECT id, lead_id, platform, variant, is_follow_up FROM messages
       WHERE status = 'pending' AND is_follow_up = 0 AND variant = ?`,
      )
      .all(variant);

    let approved = 0;
    const approvedIds = [];
    const approvedLeadIds = new Set();

    const tx = db.transaction(() => {
      for (const msg of targets) {
        // Re-check status inside the transaction in case a prior row in this
        // loop already moved it (shouldn't happen for distinct ids, but be safe).
        const fresh = db.prepare("SELECT status FROM messages WHERE id = ?").get(msg.id);
        if (!fresh || fresh.status !== "pending") continue;

        approveStmt.run(msg.id);
        retirePriorApprovalStmt.run(
          msg.lead_id,
          msg.platform,
          msg.is_follow_up,
          msg.id,
        );
        skipSiblingStmt.run(msg.lead_id, msg.id, msg.is_follow_up);
        promoteLeadStmt.run(msg.lead_id);
        approved += 1;
        approvedIds.push(msg.id);
        approvedLeadIds.add(msg.lead_id);
      }
    });
    tx();

    if (approved > 0) {
      broadcast("messages:mutation", {
        type: "bulk_approved",
        variant,
        count: approved,
        messageIds: approvedIds,
        leadIds: [...approvedLeadIds],
      });
    }

    return res.json({
      success: true,
      variant,
      approved,
      messageIds: approvedIds,
      message:
        approved === 0
          ? `No pending Variant ${variant} messages to approve.`
          : `Approved ${approved} Variant ${variant} message${approved === 1 ? "" : "s"}.`,
    });
  });

  // ---------------------------------------------------------------------------
  // API: Skip a message / deprioritize lead
  // ---------------------------------------------------------------------------
  router.patch("/api/messages/:id/skip", (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);

    const msg = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    if (!msg) return res.status(404).json({ error: "Message not found" });

    db.prepare("UPDATE messages SET status = 'skipped' WHERE id = ?").run(id);

    // Also skip the other variant
    db.prepare(
      `UPDATE messages SET status = 'skipped'
     WHERE lead_id = ? AND status = 'pending' AND is_follow_up = ?`,
    ).run(msg.lead_id, msg.is_follow_up);

    // Deprioritize lead
    db.prepare(
      "UPDATE leads SET status = 'deprioritized', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(msg.lead_id);

    broadcast("messages:mutation", {
      type: "skipped",
      messageId: id,
      leadId: msg.lead_id,
    });
    return res.json({ success: true, id });
  });
};
