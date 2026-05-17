const express = require("express");
const crypto = require("crypto");
const { renderPage } = require("./pageRenderer");
const { getDb } = require("../db/database");
const { getPlatformKeys } = require("../services/platformCatalog");
const { detectReplies } = require("../services/replyDetector");
const { asyncHandler } = require("../utils/errorHandlers");
const { isValidStatusTransition } = require("../utils/validation");
const logger = require("../utils/logger");
const { broadcast } = require("../services/socketService");

const router = express.Router();
const activeStreams = new Map();

router.get("/crm", (req, res) => {
  renderPage(res, {
    title: "CRM",
    primaryHeading: "Manage relationships",
    primaryCopy:
      "Keep prospect history, notes, statuses, and follow-up context organized.",
  });
});

router.get(
  "/api/crm/leads",
  asyncHandler(async (req, res) => {
    const db = getDb();
    let sql = `
    SELECT l.*, 
           (SELECT body FROM messages WHERE lead_id = l.id ORDER BY generated_at DESC LIMIT 1) AS last_message,
           (SELECT sent_at FROM messages WHERE lead_id = l.id AND status = 'sent' ORDER BY sent_at DESC LIMIT 1) AS last_contacted_at
    FROM leads l
    WHERE l.status IN ('messaged', 'replied', 'meeting_booked', 'converted', 'lost')
  `;
    const leads = db.prepare(sql).all();
    const now = new Date();
    leads.forEach((lead) => {
      if (lead.last_contacted_at) {
        const lastDate = new Date(lead.last_contacted_at);
        lead.days_since_contact = Math.floor(
          (now - lastDate) / (1000 * 60 * 60 * 24),
        );
      } else {
        lead.days_since_contact = 0;
      }
    });
    res.json(leads);
  }),
);

router.patch(
  "/api/crm/leads/:id/status",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status, notes } = req.body;
    const db = getDb();

    const lead = db.prepare("SELECT status FROM leads WHERE id = ?").get(id);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    if (!isValidStatusTransition(lead.status, status)) {
      return res
        .status(400)
        .json({
          error: `Invalid status transition from ${lead.status} to ${status}`,
        });
    }

    db.prepare(
      `UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(status, id);
    db.prepare(
      `
    INSERT INTO touchpoints (lead_id, type, outcome, notes)
    VALUES (?, 'status_change', 'success', ?)
  `,
    ).run(id, `Status changed to ${status}${notes ? ": " + notes : ""}`);

    res.json({ success: true, status });
    broadcast('crm:mutation', { type: 'status_change', leadId: id, status });
  }),
);

router.patch(
  "/api/crm/leads/:id/notes",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { notes } = req.body;
    const db = getDb();
    db.prepare(
      `UPDATE leads SET notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(notes, id);
    res.json({ success: true });
  }),
);

router.get(
  "/api/crm/leads/:id/touchpoints",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const db = getDb();
    const touchpoints = db
      .prepare(
        `
    SELECT t.*, m.body AS message_body 
    FROM touchpoints t
    LEFT JOIN messages m ON t.message_id = m.id
    WHERE t.lead_id = ?
    ORDER BY t.sent_at DESC
  `,
      )
      .all(id);
    res.json(touchpoints);
  }),
);

router.post(
  "/api/crm/leads/:id/book-meeting",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { date, notes } = req.body;
    const db = getDb();

    const lead = db.prepare("SELECT status FROM leads WHERE id = ?").get(id);
    if (!isValidStatusTransition(lead.status, "meeting_booked")) {
      return res
        .status(400)
        .json({ error: "Cannot book meeting for this lead status" });
    }

    db.prepare(
      `UPDATE leads SET status = 'meeting_booked', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(id);
    db.prepare(
      `
    INSERT INTO touchpoints (lead_id, type, outcome, notes)
    VALUES (?, 'meeting_booked', 'success', ?)
  `,
    ).run(id, `Meeting scheduled for ${date}. Notes: ${notes}`);

    res.json({ success: true });
    broadcast('crm:mutation', { type: 'meeting_booked', leadId: id });
  }),
);

router.post("/api/crm/detect-replies", (req, res) => {
  const jobId = crypto.randomUUID();
  res.json({ jobId });
  setTimeout(async () => {
    const sseRes = activeStreams.get(jobId);
    const { broadcast } = require("../services/socketService");
    const emit = (type, message) => {
      const payload = { type, message, timestamp: new Date().toISOString() };
      broadcast('crm:event', payload);
      if (sseRes) {
        sseRes.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };
    let totalReplies = 0;
    try {
      emit("info", "Starting manual reply detection...");
      const platforms = getPlatformKeys();
      for (const platform of platforms) {
        const result = await detectReplies(platform, emit);
        totalReplies += result.repliesFound;
      }
      emit("done", `Detection complete. Found ${totalReplies} new replies!`);
    } catch (err) {
      logger.error("CRM", "Reply detection failed", err);
      emit("error", `Detection failed: ${err.message}`);
    } finally {
      activeStreams.delete(jobId);
      if (sseRes) sseRes.end();
    }
  }, 1000);
});

router.get("/api/crm/reply-stream/:jobId", (req, res) => {
  const { jobId } = req.params;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  activeStreams.set(jobId, res);
  req.on("close", () => activeStreams.delete(jobId));
});

router.get(
  "/api/crm/stats",
  asyncHandler(async (req, res) => {
    const db = getDb();
    const leads = db
      .prepare(
        `SELECT status FROM leads WHERE status IN ('messaged', 'replied', 'meeting_booked', 'converted', 'lost')`,
      )
      .all();
    const total = leads.length;
    const byStatus = {
      messaged: 0,
      replied: 0,
      meeting_booked: 0,
      converted: 0,
      lost: 0,
    };
    leads.forEach((l) => {
      if (byStatus[l.status] !== undefined) byStatus[l.status]++;
    });
    const conversionRate =
      total > 0 ? Math.round((byStatus.converted / total) * 100) : 0;
    res.json({
      total,
      byStatus,
      avgDaysToReply: 2,
      avgDaysToConvert: 14,
      conversionRate,
    });
  }),
);

module.exports = router;
