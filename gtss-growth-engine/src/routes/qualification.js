const express = require("express");
const { renderPage } = require("./pageRenderer");
const { getDb } = require("../db/database");
const { isValidStatusTransition } = require("../utils/validation");
const {
  scoreLeadsBatch,
  stopQualificationJob,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
} = require("../services/qualificationService");
const { broadcast } = require("../services/socketService");

const router = express.Router();

// ---------------------------------------------------------------------------
// Page render
// ---------------------------------------------------------------------------

router.get("/qualification", (req, res) => {
  renderPage(res, {
    title: "Qualification",
    primaryHeading: "Score opportunities",
    primaryCopy:
      "Review prospect fit, intent signals, company context, and next best actions.",
  });
});

// ---------------------------------------------------------------------------
// API: start batch qualification
// ---------------------------------------------------------------------------

let nextJobId = 1;

router.post("/api/qualification/run", (req, res) => {
  const db = getDb();
  let leadIds = [];

  if (
    req.body.leadIds &&
    Array.isArray(req.body.leadIds) &&
    req.body.leadIds.length > 0
  ) {
    leadIds = [
      ...new Set(req.body.leadIds.map(Number).filter(Number.isInteger)),
    ];
  } else {
    // Qualify all pending leads (discovered or null score)
    const rows = db
      .prepare(
        `SELECT id FROM leads
         WHERE status = 'discovered' OR lead_score IS NULL
         ORDER BY created_at DESC`,
      )
      .all();
    leadIds = rows.map((row) => row.id);
  }

  if (leadIds.length === 0) {
    return res.json({ jobId: null, message: "No leads to qualify" });
  }

  const jobId = `qual-${nextJobId++}`;

  setImmediate(() => {
    scoreLeadsBatch(leadIds, jobId).catch((error) => {
      emitJobEvent(jobId, { type: "error", jobId, message: error.message });
      closeJobStream(jobId);
    });
  });

  return res.status(202).json({ jobId });
});

router.post("/api/qualification/stop/:jobId", (req, res) => {
  stopQualificationJob(req.params.jobId);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// API: SSE stream
// ---------------------------------------------------------------------------

router.get("/api/qualification/stream/:jobId", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  registerJobStream(req.params.jobId, res);
});

// GET /api/qualification/active — is a qualification batch currently
// running? Backed by qualification_jobs (completed_at IS NULL means still
// in progress), so this survives a refresh and is visible to any other
// tab, unlike the jobId that used to live only in page-local state.
router.get("/api/qualification/active", (req, res) => {
  const job = getDb()
    .prepare(
      `SELECT id, status, started_at FROM qualification_jobs
       WHERE completed_at IS NULL
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get();

  if (!job) {
    return res.json({ active: false });
  }

  return res.json({ active: true, jobId: job.id, status: job.status });
});

// ---------------------------------------------------------------------------
// API: list leads with scores
// ---------------------------------------------------------------------------

router.get("/api/qualification/leads", (req, res) => {
  const db = getDb();
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = (page - 1) * limit;
  const where = [];
  const params = {};

  const status = req.query.status || "all";
  if (status === "pending") {
    where.push("(status = 'discovered' OR lead_score IS NULL)");
  } else if (status === "qualified" || status === "approved") {
    where.push("status = 'qualified'");
  } else if (status === "deprioritized" || status === "rejected") {
    where.push("status = 'deprioritized'");
  } else if (status === "dismissed") {
    where.push("status = 'dismissed'");
  } else if (status === "scoring_failed") {
    where.push("status = 'scoring_failed'");
  } else if (status === "overridden") {
    where.push("score_reason LIKE '%[manually overridden]%'");
  }

  if (req.query.platform) {
    where.push("platform = @platform");
    params.platform = req.query.platform;
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  // Sort
  let orderSql = "ORDER BY lead_score DESC NULLS LAST, created_at DESC";
  const sort = req.query.sort || "";
  if (sort === "score_asc") {
    orderSql = "ORDER BY lead_score ASC NULLS LAST, created_at DESC";
  } else if (sort === "name_asc") {
    orderSql = "ORDER BY name ASC, created_at DESC";
  } else if (sort === "platform") {
    orderSql = "ORDER BY platform ASC, created_at DESC";
  } else if (sort === "date") {
    orderSql = "ORDER BY created_at DESC";
  }

  const total = db
    .prepare(`SELECT COUNT(*) AS total FROM leads ${whereSql}`)
    .get(params).total;

  const leads = db
    .prepare(
      `SELECT * FROM leads ${whereSql} ${orderSql} LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset });

  res.json({ page, limit, total, leads });
});

// ---------------------------------------------------------------------------
// API: lead stats (counts by status)
// ---------------------------------------------------------------------------

router.get("/api/qualification/stats", (req, res) => {
  const db = getDb();

  const pending = db
    .prepare(
      "SELECT COUNT(*) AS c FROM leads WHERE status = 'discovered' OR lead_score IS NULL",
    )
    .get().c;

  const qualified = db
    .prepare("SELECT COUNT(*) AS c FROM leads WHERE status = 'qualified'")
    .get().c;

  const deprioritized = db
    .prepare("SELECT COUNT(*) AS c FROM leads WHERE status = 'deprioritized'")
    .get().c;

  const overridden = db
    .prepare(
      "SELECT COUNT(*) AS c FROM leads WHERE score_reason LIKE '%[manually overridden]%'",
    )
    .get().c;

  const scoring_failed = db
    .prepare("SELECT COUNT(*) AS c FROM leads WHERE status = 'scoring_failed'")
    .get().c;

  res.json({ pending, qualified, deprioritized, overridden, scoring_failed });
});

// ---------------------------------------------------------------------------
// API: override score
// ---------------------------------------------------------------------------

router.patch("/api/qualification/leads/:id/score", (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const score = Math.max(0, Math.min(100, Number(req.body.score) || 0));

  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
  if (!lead) {
    return res.status(404).json({ error: "Lead not found" });
  }

  const status = score >= 50 ? "qualified" : "deprioritized";
  const reason =
    (lead.score_reason || "").replace(" [manually overridden]", "") +
    " [manually overridden]";

  db.prepare(
    `UPDATE leads
     SET lead_score = ?, score_reason = ?, status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(score, reason, status, id);

  const updated = db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
  broadcast('qualification:mutation', { type: 'score_override', lead: updated });
  res.json(updated);
});

// ---------------------------------------------------------------------------
// API: update lead status
// ---------------------------------------------------------------------------

router.patch("/api/qualification/leads/:id/status", (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const validStatuses = ["qualified", "deprioritized", "dismissed", "pending_qualification"];
  const newStatus = req.body.status;

  if (!validStatuses.includes(newStatus)) {
    return res
      .status(400)
      .json({
        error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      });
  }

  const lead = db.prepare("SELECT status FROM leads WHERE id = ?").get(id);
  if (!lead) {
    return res.status(404).json({ error: "Lead not found" });
  }

  if (!isValidStatusTransition(lead.status, newStatus)) {
    return res
      .status(400)
      .json({
        error: `Invalid status transition from ${lead.status} to ${newStatus}`,
      });
  }

  const result = db
    .prepare(
      "UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .run(newStatus, id);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Lead not found" });
  }

  const updated = db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
  broadcast('qualification:mutation', { type: 'status_update', lead: updated });
  res.json(updated);
});

router.post("/api/qualification/leads/bulk/manual-qualify", (req, res) => {
  const db = getDb();
  const { leadIds, all_pending } = req.body || {};

  let ids = [];

  if (all_pending) {
    const rows = db
      .prepare(
        `SELECT id FROM leads
         WHERE status IN ('discovered', 'scoring_failed') OR lead_score IS NULL`,
      )
      .all();
    ids = rows.map((row) => row.id);
  } else if (Array.isArray(leadIds) && leadIds.length > 0) {
    ids = [...new Set(leadIds.map(Number).filter(Number.isInteger))];
  } else {
    return res
      .status(400)
      .json({ error: "Provide leadIds or all_pending: true" });
  }

  if (ids.length === 0) {
    return res.json({ updated: 0, message: "No leads matched" });
  }

  const placeholders = ids.map(() => "?").join(",");
  const candidates = db
    .prepare(
      `SELECT id, status, score_reason FROM leads WHERE id IN (${placeholders})`,
    )
    .all(...ids)
    .filter((lead) => ["discovered", "scoring_failed"].includes(lead.status));

  const update = db.prepare(
    `UPDATE leads
     SET status = 'qualified',
         score_reason = CASE
           WHEN score_reason IS NULL OR TRIM(score_reason) = '' THEN '[manually qualified]'
           WHEN score_reason LIKE '%[manually qualified]%' THEN score_reason
           ELSE score_reason || ' [manually qualified]'
         END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status IN ('discovered', 'scoring_failed')`,
  );

  const transaction = db.transaction((rows) => {
    let updated = 0;
    for (const row of rows) {
      updated += update.run(row.id).changes;
    }
    return updated;
  });

  const updated = transaction(candidates);
  broadcast('qualification:mutation', { type: 'bulk_manual_qualify', count: updated });
  res.json({ updated });
});

router.post("/api/qualification/retry-failed", (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id FROM leads WHERE status = 'scoring_failed' ORDER BY updated_at DESC",
    )
    .all();

  if (rows.length === 0) {
    return res.json({ jobId: null, message: "No failed leads to retry" });
  }

  const leadIds = rows.map((row) => row.id);
  const placeholders = leadIds.map(() => "?").join(",");

  db.prepare(
    `UPDATE leads
     SET status = 'discovered',
         updated_at = CURRENT_TIMESTAMP
     WHERE id IN (${placeholders})`,
  ).run(...leadIds);

  const jobId = `qual-${nextJobId++}`;

  setImmediate(() => {
    scoreLeadsBatch(leadIds, jobId).catch((error) => {
      emitJobEvent(jobId, { type: "error", jobId, message: error.message });
      closeJobStream(jobId);
    });
  });

  return res.status(202).json({ jobId });
});

// ---------------------------------------------------------------------------
// API: update lead notes
// ---------------------------------------------------------------------------

router.patch("/api/leads/:id/notes", (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const notes = req.body.notes || "";

  const result = db
    .prepare(
      "UPDATE leads SET notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .run(notes, id);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Lead not found" });
  }

  res.json({ id, notes });
});

// ---------------------------------------------------------------------------
// API: bulk status update
// ---------------------------------------------------------------------------

router.patch("/api/qualification/leads/bulk/status", (req, res) => {
  const db = getDb();
  const { leadIds, status } = req.body;
  const validStatuses = ["qualified", "deprioritized", "dismissed", "pending_qualification"];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    return res.status(400).json({ error: "leadIds required" });
  }

  const ids = [...new Set(leadIds.map(Number).filter(Number.isInteger))];
  if (ids.length === 0) {
    return res.status(400).json({ error: "valid leadIds required" });
  }

  const leads = db
    .prepare(
      `SELECT id, status FROM leads WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids);
  const invalid = leads.find(
    (lead) => !isValidStatusTransition(lead.status, status),
  );
  if (invalid) {
    return res
      .status(400)
      .json({
        error: `Invalid status transition from ${invalid.status} to ${status}`,
      });
  }

  const update = db.prepare(
    "UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  );

  const transaction = db.transaction((ids) => {
    let updated = 0;
    ids.forEach((id) => {
      updated += update.run(status, id).changes;
    });
    return updated;
  });

  const updated = transaction(ids);
  broadcast('qualification:mutation', { type: 'bulk_status', status, count: updated });
  res.json({ updated });
});

module.exports = router;
