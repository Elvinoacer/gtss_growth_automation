const express = require("express");
const { renderPage } = require("./pageRenderer");
const { getDb } = require("../db/database");
const { isSessionValid } = require("../automation/sessionManager");
const { createBrowser, closeBrowser } = require("../automation/browserBase");
const { getDailyLimits } = require("../db/database");
const { getPlatformCatalog } = require("../services/platformCatalog");
const logger = require("../utils/logger");

const router = express.Router();

// ---------------------------------------------------------------------------
// Page Route
// ---------------------------------------------------------------------------

router.get("/", (req, res) => {
  renderPage(res, {
    title: "Dashboard",
    primaryHeading: "Growth overview",
    primaryCopy:
      "Track prospect discovery, outreach, scheduled content, and automation health from one place.",
  });
});

// ---------------------------------------------------------------------------
// API: Dashboard Stats (single aggregated call)
// ---------------------------------------------------------------------------

router.get("/api/dashboard/stats", (req, res) => {
  try {
    const db = getDb();
    const platformCatalog = getPlatformCatalog();
    const platforms = platformCatalog.keys;
    const dailyLimits = getDailyLimits();
    const now = new Date();
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString();

    // ── Lead counts ──
    const total = db.prepare("SELECT COUNT(*) as c FROM leads").get().c;
    const deltaLastWeek = db
      .prepare("SELECT COUNT(*) as c FROM leads WHERE created_at >= ?")
      .get(weekAgoStr).c;
    const qualified = db
      .prepare(
        "SELECT COUNT(*) as c FROM leads WHERE status IN ('qualified','messaged','replied','meeting_booked','converted')",
      )
      .get().c;
    const messaged = db
      .prepare(
        "SELECT COUNT(*) as c FROM leads WHERE status IN ('messaged','replied','meeting_booked','converted')",
      )
      .get().c;
    const messagedThisWeek = db
      .prepare(
        "SELECT COUNT(*) as c FROM leads WHERE status IN ('messaged','replied','meeting_booked','converted') AND updated_at >= ?",
      )
      .get(weekAgoStr).c;
    const replied = db
      .prepare(
        "SELECT COUNT(*) as c FROM leads WHERE status IN ('replied','meeting_booked','converted')",
      )
      .get().c;
    const meetingsBooked = db
      .prepare(
        "SELECT COUNT(*) as c FROM leads WHERE status = 'meeting_booked'",
      )
      .get().c;
    const converted = db
      .prepare("SELECT COUNT(*) as c FROM leads WHERE status = 'converted'")
      .get().c;
    const replyRate = messaged > 0 ? Math.round((replied / messaged) * 100) : 0;
    const qualifiedPct = total > 0 ? Math.round((qualified / total) * 100) : 0;

    // ── Funnel (all platforms) ──
    const discovered = db
      .prepare("SELECT COUNT(*) as c FROM leads WHERE status = 'discovered'")
      .get().c;
    const funnel = { discovered, qualified, messaged, replied, converted };

    // ── Funnel by platform ──
    const funnelByPlatform = {};
    for (const p of platforms) {
      funnelByPlatform[p] = {
        discovered: db
          .prepare(
            "SELECT COUNT(*) as c FROM leads WHERE platform = ? AND status = 'discovered'",
          )
          .get(p).c,
        qualified: db
          .prepare(
            "SELECT COUNT(*) as c FROM leads WHERE platform = ? AND status IN ('qualified','messaged','replied','meeting_booked','converted')",
          )
          .get(p).c,
        messaged: db
          .prepare(
            "SELECT COUNT(*) as c FROM leads WHERE platform = ? AND status IN ('messaged','replied','meeting_booked','converted')",
          )
          .get(p).c,
        replied: db
          .prepare(
            "SELECT COUNT(*) as c FROM leads WHERE platform = ? AND status IN ('replied','meeting_booked','converted')",
          )
          .get(p).c,
        converted: db
          .prepare(
            "SELECT COUNT(*) as c FROM leads WHERE platform = ? AND status = 'converted'",
          )
          .get(p).c,
      };
    }

    // ── Daily actions ──
    const todayStr = now.toISOString().split("T")[0];
    const dailyActions = {};
    for (const p of platforms) {
      const used = db
        .prepare(
          "SELECT COUNT(*) as c FROM daily_actions WHERE platform = ? AND date(performed_at) = ?",
        )
        .get(p, todayStr).c;
      const connections = db
        .prepare(
          "SELECT COUNT(*) as c FROM daily_actions WHERE platform = ? AND date(performed_at) = ? AND action_type = 'connections'",
        )
        .get(p, todayStr).c;
      const dms = db
        .prepare(
          "SELECT COUNT(*) as c FROM daily_actions WHERE platform = ? AND date(performed_at) = ? AND action_type = 'dms'",
        )
        .get(p, todayStr).c;
      const likes = db
        .prepare(
          "SELECT COUNT(*) as c FROM daily_actions WHERE platform = ? AND date(performed_at) = ? AND action_type = 'likes'",
        )
        .get(p, todayStr).c;
      const limit = Object.values(dailyLimits[p] || {}).reduce(
        (sum, value) => sum + Number(value || 0),
        0,
      );
      dailyActions[p] = { used, limit, byType: { connections, dms, likes } };
    }

    // ── Recent replies ──
    const recentReplies = db
      .prepare(
        `
      SELECT t.lead_id as leadId, l.name, l.platform, l.company, t.notes as messageSnippet, t.sent_at as repliedAt
      FROM touchpoints t
      JOIN leads l ON t.lead_id = l.id
      WHERE t.type = 'reply'
      ORDER BY t.sent_at DESC
      LIMIT 5
    `,
      )
      .all();

    // ── Upcoming posts ──
    const upcomingPosts = db
      .prepare(
        `
      SELECT id, platforms, body, scheduled_at as scheduledAt
      FROM posts
      WHERE status = 'scheduled' AND scheduled_at > datetime('now')
      ORDER BY scheduled_at ASC
      LIMIT 3
    `,
      )
      .all()
      .map((p) => {
        try {
          p.platforms = JSON.parse(p.platforms);
        } catch {
          /* keep */
        }
        p.bodyPreview = (p.body || "").slice(0, 80);
        delete p.body;
        return p;
      });

    // ── Sessions ──
    const sessions = {};
    for (const p of platforms) {
      const row = db
        .prepare(
          "SELECT last_active, is_valid FROM platform_sessions WHERE platform = ?",
        )
        .get(p);
      sessions[p] = {
        valid: row ? Boolean(row.is_valid) && isSessionValid(p) : false,
        lastActive: row ? row.last_active : null,
      };
    }

    // ── Template performance ──
    const templatePerformance = db
      .prepare(
        `
      SELECT m.platform, m.variant as templateName,
             COUNT(*) as sent,
             SUM(CASE WHEN l.status IN ('replied','meeting_booked','converted') THEN 1 ELSE 0 END) as replied
      FROM messages m
      JOIN leads l ON m.lead_id = l.id
      WHERE m.status = 'sent'
      GROUP BY m.platform, m.variant
      ORDER BY replied DESC
    `,
      )
      .all()
      .map((r) => ({
        ...r,
        acceptanceRate: r.sent > 0 ? Math.round((r.replied / r.sent) * 100) : 0,
      }));

    res.json({
      leads: {
        total,
        deltaLastWeek,
        qualified,
        qualifiedPct,
        messaged,
        messagedThisWeek,
        replied,
        replyRate,
        meetingsBooked,
        converted,
      },
      funnel,
      funnelByPlatform,
      dailyActions,
      recentReplies,
      upcomingPosts,
      sessions,
      templatePerformance,
    });
  } catch (error) {
    logger.error("Dashboard stats error", { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// API: CSV Export
// ---------------------------------------------------------------------------

router.get("/api/dashboard/export", (req, res) => {
  const { dataType } = req.query;
  try {
    const db = getDb();
    const dateStr = new Date().toISOString().split("T")[0];
    let rows = [];
    let columns = [];

    switch (dataType) {
      case "leads":
        rows = db.prepare("SELECT * FROM leads ORDER BY created_at DESC").all();
        columns = [
          "id",
          "platform",
          "name",
          "role",
          "company",
          "location",
          "profile_url",
          "website",
          "lead_score",
          "score_reason",
          "status",
          "notes",
          "created_at",
        ];
        break;
      case "touchpoints":
        rows = db
          .prepare(
            "SELECT t.*, l.name as lead_name FROM touchpoints t LEFT JOIN leads l ON t.lead_id = l.id ORDER BY t.sent_at DESC",
          )
          .all();
        columns = [
          "id",
          "lead_id",
          "lead_name",
          "type",
          "platform",
          "outcome",
          "sent_at",
          "notes",
        ];
        break;
      case "messages":
        rows = db
          .prepare(
            "SELECT m.*, l.name as lead_name FROM messages m LEFT JOIN leads l ON m.lead_id = l.id ORDER BY m.generated_at DESC",
          )
          .all();
        columns = [
          "id",
          "lead_id",
          "lead_name",
          "platform",
          "body",
          "variant",
          "status",
          "sent_at",
          "generated_at",
        ];
        break;
      case "posts":
        rows = db.prepare("SELECT * FROM posts ORDER BY created_at DESC").all();
        columns = [
          "id",
          "platforms",
          "body",
          "media_path",
          "scheduled_at",
          "published_at",
          "likes",
          "comments",
          "reach",
          "status",
          "created_at",
        ];
        break;
      default: // 'all' — export leads
        rows = db.prepare("SELECT * FROM leads ORDER BY created_at DESC").all();
        columns = [
          "id",
          "platform",
          "name",
          "role",
          "company",
          "location",
          "profile_url",
          "lead_score",
          "status",
          "created_at",
        ];
    }

    // Build CSV
    const escapeCsv = (val) => {
      if (val === null || val === undefined) return "";
      const str = String(val).replace(/"/g, '""');
      return str.includes(",") || str.includes('"') || str.includes("\n")
        ? `"${str}"`
        : str;
    };

    let csv = columns.join(",") + "\n";
    for (const row of rows) {
      csv += columns.map((col) => escapeCsv(row[col])).join(",") + "\n";
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="gtss-export-${dataType}-${dateStr}.csv"`,
    );
    res.send(csv);
  } catch (error) {
    logger.error("Export error", { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Note: /api/sessions/authenticate/:platform is handled in api.js

module.exports = router;
