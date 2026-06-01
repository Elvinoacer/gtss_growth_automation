const express = require("express");
const { getDb } = require("../db/database");

const router = express.Router();

function parseDetails(value) {
  try {
    return JSON.parse(value || "{}");
  } catch (_) {
    return {};
  }
}

function buildFilters(query) {
  const where = [];
  const params = {};
  if (query.type) {
    where.push("activity_type = @type");
    params.type = String(query.type);
  }
  if (query.platform) {
    where.push("platform = @platform");
    params.platform = String(query.platform);
  }
  if (query.status) {
    where.push("status = @status");
    params.status = String(query.status);
  }
  if (query.date_from) {
    where.push("DATE(created_at) >= DATE(@dateFrom)");
    params.dateFrom = String(query.date_from);
  }
  if (query.date_to) {
    where.push("DATE(created_at) <= DATE(@dateTo)");
    params.dateTo = String(query.date_to);
  }
  return { where, params };
}

function normalize(row) {
  return row ? { ...row, details: parseDetails(row.details_json) } : null;
}

router.get("/", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const { where, params } = buildFilters(req.query);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const db = getDb();
  const total = db
    .prepare(`SELECT COUNT(*) AS count FROM audit_log ${whereSql}`)
    .get(params).count;
  const rows = db
    .prepare(
      `SELECT * FROM audit_log ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset })
    .map(normalize);
  res.json({ total, limit, offset, entries: rows });
});

router.get("/entity/:type/:id", (req, res) => {
  const entries = getDb()
    .prepare(
      `SELECT * FROM audit_log
       WHERE entity_type = ? AND entity_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(req.params.type, String(req.params.id))
    .map(normalize);
  res.json({ entries });
});

router.get("/lead/:leadId/journey", (req, res) => {
  const db = getDb();
  const leadId = String(req.params.leadId);
  const entries = db
    .prepare(
      `SELECT * FROM audit_log
       WHERE (entity_type = 'lead' AND entity_id = ?)
          OR details_json LIKE ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(leadId, `%"leadId":${leadId}%`)
    .map(normalize);
  res.json({ leadId, entries });
});

router.get("/export", (req, res) => {
  const { where, params } = buildFilters(req.query);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM audit_log ${whereSql} ORDER BY created_at DESC, id DESC`)
    .all(params);
  const header = [
    "id",
    "activity_type",
    "entity_type",
    "entity_id",
    "platform",
    "actor",
    "status",
    "summary",
    "created_at",
  ];
  const escapeCsv = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const csv = [
    header.join(","),
    ...rows.map((row) => header.map((key) => escapeCsv(row[key])).join(",")),
  ].join("\n");
  res.set("Content-Type", "text/csv");
  res.set("Content-Disposition", "attachment; filename=audit-log.csv");
  res.send(csv);
});

module.exports = router;
