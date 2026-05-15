const express = require('express');
const { renderPage } = require('./pageRenderer');
const { getDb } = require('../db/database');
const { isValidStatusTransition } = require('../utils/validation');
const {
  scoreLeadsBatch,
  registerJobStream,
  emitJobEvent,
  closeJobStream
} = require('../services/qualificationService');

const router = express.Router();

// ---------------------------------------------------------------------------
// Page render
// ---------------------------------------------------------------------------

router.get('/qualification', (req, res) => {
  renderPage(res, {
    title: 'Qualification',
    primaryHeading: 'Score opportunities',
    primaryCopy: 'Review prospect fit, intent signals, company context, and next best actions.'
  });
});

// ---------------------------------------------------------------------------
// API: start batch qualification
// ---------------------------------------------------------------------------

let nextJobId = 1;

router.post('/api/qualification/run', (req, res) => {
  const db = getDb();
  let leadIds = [];

  if (req.body.leadIds && Array.isArray(req.body.leadIds) && req.body.leadIds.length > 0) {
    leadIds = [...new Set(req.body.leadIds.map(Number).filter(Number.isInteger))];
  } else {
    // Qualify all pending leads (discovered or null score)
    const rows = db
      .prepare(
        `SELECT id FROM leads
         WHERE status = 'discovered' OR lead_score IS NULL
         ORDER BY created_at DESC`
      )
      .all();
    leadIds = rows.map((row) => row.id);
  }

  if (leadIds.length === 0) {
    return res.json({ jobId: null, message: 'No leads to qualify' });
  }

  const jobId = `qual-${nextJobId++}`;

  setImmediate(() => {
    scoreLeadsBatch(leadIds, jobId).catch((error) => {
      emitJobEvent(jobId, { type: 'error', jobId, message: error.message });
      closeJobStream(jobId);
    });
  });

  return res.status(202).json({ jobId });
});

// ---------------------------------------------------------------------------
// API: SSE stream
// ---------------------------------------------------------------------------

router.get('/api/qualification/stream/:jobId', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  registerJobStream(req.params.jobId, res);
});

// ---------------------------------------------------------------------------
// API: list leads with scores
// ---------------------------------------------------------------------------

router.get('/api/qualification/leads', (req, res) => {
  const db = getDb();
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = (page - 1) * limit;
  const where = [];
  const params = {};

  const status = req.query.status || 'all';
  if (status === 'pending') {
    where.push("(status = 'discovered' OR lead_score IS NULL)");
  } else if (status === 'qualified' || status === 'approved') {
    where.push("status = 'qualified'");
  } else if (status === 'deprioritized' || status === 'rejected') {
    where.push("status = 'deprioritized'");
  } else if (status === 'dismissed') {
    where.push("status = 'dismissed'");
  } else if (status === 'overridden') {
    where.push("score_reason LIKE '%[manually overridden]%'");
  }

  if (req.query.platform) {
    where.push('platform = @platform');
    params.platform = req.query.platform;
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  // Sort
  let orderSql = 'ORDER BY lead_score DESC NULLS LAST, created_at DESC';
  const sort = req.query.sort || '';
  if (sort === 'score_asc') {
    orderSql = 'ORDER BY lead_score ASC NULLS LAST, created_at DESC';
  } else if (sort === 'name_asc') {
    orderSql = 'ORDER BY name ASC, created_at DESC';
  } else if (sort === 'platform') {
    orderSql = 'ORDER BY platform ASC, created_at DESC';
  } else if (sort === 'date') {
    orderSql = 'ORDER BY created_at DESC';
  }

  const total = db
    .prepare(`SELECT COUNT(*) AS total FROM leads ${whereSql}`)
    .get(params).total;

  const leads = db
    .prepare(
      `SELECT * FROM leads ${whereSql} ${orderSql} LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset });

  res.json({ page, limit, total, leads });
});

// ---------------------------------------------------------------------------
// API: lead stats (counts by status)
// ---------------------------------------------------------------------------

router.get('/api/qualification/stats', (req, res) => {
  const db = getDb();

  const pending = db
    .prepare("SELECT COUNT(*) AS c FROM leads WHERE status = 'discovered' OR lead_score IS NULL")
    .get().c;

  const qualified = db
    .prepare("SELECT COUNT(*) AS c FROM leads WHERE status = 'qualified'")
    .get().c;

  const deprioritized = db
    .prepare("SELECT COUNT(*) AS c FROM leads WHERE status = 'deprioritized'")
    .get().c;

  const overridden = db
    .prepare("SELECT COUNT(*) AS c FROM leads WHERE score_reason LIKE '%[manually overridden]%'")
    .get().c;

  res.json({ pending, qualified, deprioritized, overridden });
});

// ---------------------------------------------------------------------------
// API: override score
// ---------------------------------------------------------------------------

router.patch('/api/qualification/leads/:id/score', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const score = Math.max(0, Math.min(100, Number(req.body.score) || 0));

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  const status = score >= 50 ? 'qualified' : 'deprioritized';
  const reason = (lead.score_reason || '').replace(' [manually overridden]', '') + ' [manually overridden]';

  db.prepare(
    `UPDATE leads
     SET lead_score = ?, score_reason = ?, status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(score, reason, status, id);

  const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  res.json(updated);
});

// ---------------------------------------------------------------------------
// API: update lead status
// ---------------------------------------------------------------------------

router.patch('/api/qualification/leads/:id/status', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const validStatuses = ['qualified', 'deprioritized', 'dismissed'];
  const newStatus = req.body.status;

  if (!validStatuses.includes(newStatus)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  const lead = db.prepare('SELECT status FROM leads WHERE id = ?').get(id);
  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  if (!isValidStatusTransition(lead.status, newStatus)) {
    return res.status(400).json({ error: `Invalid status transition from ${lead.status} to ${newStatus}` });
  }

  const result = db
    .prepare('UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(newStatus, id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  res.json(updated);
});

// ---------------------------------------------------------------------------
// API: update lead notes
// ---------------------------------------------------------------------------

router.patch('/api/leads/:id/notes', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const notes = req.body.notes || '';

  const result = db
    .prepare('UPDATE leads SET notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(notes, id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  res.json({ id, notes });
});

// ---------------------------------------------------------------------------
// API: bulk status update
// ---------------------------------------------------------------------------

router.patch('/api/qualification/leads/bulk/status', (req, res) => {
  const db = getDb();
  const { leadIds, status } = req.body;
  const validStatuses = ['qualified', 'deprioritized', 'dismissed'];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    return res.status(400).json({ error: 'leadIds required' });
  }

  const ids = [...new Set(leadIds.map(Number).filter(Number.isInteger))];
  if (ids.length === 0) {
    return res.status(400).json({ error: 'valid leadIds required' });
  }

  const leads = db
    .prepare(`SELECT id, status FROM leads WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  const invalid = leads.find((lead) => !isValidStatusTransition(lead.status, status));
  if (invalid) {
    return res.status(400).json({ error: `Invalid status transition from ${invalid.status} to ${status}` });
  }

  const update = db.prepare(
    'UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  );

  const transaction = db.transaction((ids) => {
    let updated = 0;
    ids.forEach((id) => {
      updated += update.run(status, id).changes;
    });
    return updated;
  });

  const updated = transaction(ids);
  res.json({ updated });
});

module.exports = router;
