const express = require("express");
const { renderPage } = require("./pageRenderer");
const { getDb } = require("../db/database");
const {
  generateMessages,
  generateFollowUp,
  generateAllMessages,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
  CHAR_LIMITS,
} = require("../services/messageService");
const { broadcast } = require("../services/socketService");

const router = express.Router();

// ---------------------------------------------------------------------------
// Page render
// ---------------------------------------------------------------------------

router.get("/messages", (req, res) => {
  renderPage(res, {
    title: "Messages",
    primaryHeading: "Outreach workspace",
    primaryCopy:
      "Draft, personalize, approve, and track direct messages across supported platforms.",
  });
});

// ---------------------------------------------------------------------------
// API: Generate messages for a single lead
// ---------------------------------------------------------------------------

router.post("/api/messages/generate", async (req, res) => {
  try {
    const { leadId, platform, productPitch, tone } = req.body;
    if (!leadId) return res.status(400).json({ error: "leadId is required" });

    const db = getDb();

    // Check for existing pending messages
    const existing = db
      .prepare(
        `SELECT * FROM messages
       WHERE lead_id = ? AND status = 'pending' AND is_follow_up = 0
       ORDER BY generated_at DESC`,
      )
      .all(leadId);

    if (existing.length >= 2) {
      const varA = existing.find((m) => m.variant === "A") || existing[0];
      const varB = existing.find((m) => m.variant === "B") || existing[1];
      return res.json({
        variantA: { id: varA.id, body: varA.body },
        variantB: varB ? { id: varB.id, body: varB.body } : null,
        cached: true,
      });
    }

    const result = await generateMessages(
      leadId,
      platform || null,
      null,
      tone || "friendly",
    );

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// API: Generate messages for ALL qualified leads (background job)
// ---------------------------------------------------------------------------

let nextJobId = 1;

router.post("/api/messages/generate-all", (req, res) => {
  const { productPitch, tone } = req.body || {};
  const jobId = `msg-${nextJobId++}`;

  const db = getDb();
  const pendingCount = db
    .prepare(
      `SELECT COUNT(*) AS c FROM leads l
     WHERE l.status = 'qualified'
       AND NOT EXISTS (
         SELECT 1 FROM messages m
         WHERE m.lead_id = l.id AND m.status IN ('pending', 'approved')
       )`,
    )
    .get().c;

  if (pendingCount === 0) {
    return res.json({
      jobId: null,
      message: "No qualified leads without messages",
    });
  }

  setImmediate(() => {
    generateAllMessages(jobId, productPitch, tone).catch((error) => {
      emitJobEvent(jobId, { type: "error", jobId, message: error.message });
      closeJobStream(jobId);
    });
  });

  return res.status(202).json({ jobId, pendingCount });
});

// ---------------------------------------------------------------------------
// API: SSE stream
// ---------------------------------------------------------------------------

router.get("/api/messages/stream/:jobId", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  registerJobStream(req.params.jobId, res);
});

// ---------------------------------------------------------------------------
// API: List messages (with lead data)
// ---------------------------------------------------------------------------

router.get("/api/messages", (req, res) => {
  const db = getDb();
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = (page - 1) * limit;

  const where = [];
  const params = {};

  // Status filter
  const status = req.query.status || "all";
  if (status === "pending") {
    where.push("m.status = 'pending' AND m.is_follow_up = 0");
  } else if (status === "approved") {
    where.push("m.status = 'approved'");
  } else if (status === "sent") {
    where.push("m.status = 'sent'");
  } else if (status === "follow_up") {
    where.push("m.is_follow_up = 1");
  } else if (status === "skipped") {
    where.push("m.status = 'skipped'");
  }

  // Platform filter
  if (req.query.platform) {
    where.push("m.platform = @platform");
    params.platform = req.query.platform;
  }

  // Search by lead name
  if (req.query.search) {
    where.push("l.name LIKE @search");
    params.search = `%${req.query.search}%`;
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const total = db
    .prepare(
      `SELECT COUNT(*) AS c FROM messages m
     JOIN leads l ON l.id = m.lead_id
     ${whereClause}`,
    )
    .get(params).c;

  const messages = db
    .prepare(
      `SELECT m.*,
            l.name AS lead_name,
            l.role AS lead_role,
            l.company AS lead_company,
            l.location AS lead_location,
            l.platform AS lead_platform,
            l.lead_score,
            l.score_reason,
            l.notes AS lead_notes,
            l.profile_url,
            l.website AS lead_website
     FROM messages m
     JOIN leads l ON l.id = m.lead_id
     ${whereClause}
     ORDER BY m.generated_at DESC
     LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset });

  return res.json({ messages, total, page, limit });
});

// ---------------------------------------------------------------------------
// API: Stats
// ---------------------------------------------------------------------------

router.get("/api/messages/stats", (req, res) => {
  const db = getDb();

  const pending = db
    .prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE status = 'pending' AND is_follow_up = 0",
    )
    .get().c;

  const approved = db
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE status = 'approved'")
    .get().c;

  const sent = db
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE status = 'sent'")
    .get().c;

  const skipped = db
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE status = 'skipped'")
    .get().c;

  const unscoredQualified = db
    .prepare(
      "SELECT COUNT(*) AS c FROM leads WHERE status = 'qualified' AND lead_score IS NULL",
    )
    .get().c;

  // Follow-ups due: leads messaged ≥ N days ago with no reply
  const followUpDays = (() => {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'follow_up_days'")
      .get();
    return row ? Number(row.value) || 5 : 5;
  })();

  const followUps = db
    .prepare(
      `SELECT COUNT(DISTINCT m.lead_id) AS c
     FROM messages m
     JOIN leads l ON l.id = m.lead_id
     WHERE m.status = 'sent'
       AND m.is_follow_up = 0
       AND l.status NOT IN ('replied', 'meeting_booked', 'converted')
       AND datetime(COALESCE(m.sent_at, m.approved_at), '+' || @days || ' days') <= datetime('now')
       AND (m.snooze_until IS NULL OR datetime(m.snooze_until) <= datetime('now'))`,
    )
    .get({ days: followUpDays }).c;

  return res.json({
    pending,
    approved,
    sent,
    skipped,
    followUps,
    unscored_qualified: unscoredQualified,
    charLimits: CHAR_LIMITS,
  });
});

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
  const variant = String(req.body?.variant || "").toUpperCase() === "A" ? "A" : "B";

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
  const promoteLeadStmt = db.prepare(
    "UPDATE leads SET status = 'message_approved', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'qualified'",
  );

  // Find every pending, non-follow-up message of the requested variant.
  const targets = db
    .prepare(
      `SELECT id, lead_id, variant, is_follow_up FROM messages
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

// ---------------------------------------------------------------------------
// API: Regenerate messages for a lead
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// API: Character limits
// ---------------------------------------------------------------------------

router.get("/api/messages/char-limits", (req, res) => {
  return res.json(CHAR_LIMITS);
});

module.exports = router;
