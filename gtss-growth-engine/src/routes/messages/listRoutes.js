/**
 * messages/listRoutes.js — GET /api/messages (paginated, filtered list with
 * lead data joined) and GET /api/messages/stats (header counters).
 *
 * Original routes/messages.js was 561 lines; this is one of its thematic
 * splits. Relative require paths were updated for the new directory depth.
 */

const { getDb } = require("../../db/database");
const { CHAR_LIMITS } = require("../../services/messageService");
const {
  countFallbackLeads,
  countFallbackMessages,
} = require("../../services/messageService/retireTemplateMessages");

module.exports = function registerListRoutes(router) {
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

    const fallbackLeads = countFallbackLeads(db);
    const fallbackMessages = countFallbackMessages(db);

    return res.json({
      pending,
      approved,
      sent,
      skipped,
      followUps,
      unscored_qualified: unscoredQualified,
      fallback_leads: fallbackLeads,
      fallback_messages: fallbackMessages,
      charLimits: CHAR_LIMITS,
    });
  });
};
