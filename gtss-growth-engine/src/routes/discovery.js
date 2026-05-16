const express = require('express');
const fs = require('fs');
const path = require('path');
const { renderPage } = require('./pageRenderer');
const { getDb } = require('../db/database');
const { keywordsFilePath } = require('../config/pipelineConfig');
const {
  discoverLeads,
  listDiscoverySources,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
  stopDiscovery
} = require('../services/discoveryService');

const router = express.Router();

router.get('/', (req, res) => {
  renderPage(res, {
    title: 'Discovery',
    primaryHeading: 'Find prospects',
    primaryCopy: 'Collect and normalize leads from LinkedIn, X, Instagram, and Facebook.'
  });
});

router.get('/config', (req, res) => {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'discovery_max_leads'").get();
  res.json({ maxLeads: row ? Number(row.value) : 20 });
});

router.post('/config', (req, res) => {
  const maxLeads = Number(req.body.maxLeads);
  if (!Number.isInteger(maxLeads) || maxLeads < 1 || maxLeads > 100) {
    return res.status(400).json({ error: 'maxLeads must be between 1 and 100' });
  }
  getDb().prepare(`
    INSERT INTO settings (key, value) VALUES ('discovery_max_leads', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(maxLeads));
  res.json({ success: true });
});

router.post('/start', (req, res) => {
  const { keyword, platforms, maxLeads } = req.body;
  const selectedPlatforms = Array.isArray(platforms) ? platforms : [];
  const parsedMaxLeads = Number(maxLeads);
  const validPlatforms = listDiscoverySources();

  if (!keyword || !String(keyword).trim()) {
    return res.status(400).json({ error: 'Keyword is required' });
  }

  if (selectedPlatforms.length === 0) {
    return res.status(400).json({ error: 'At least one platform is required' });
  }

  if (selectedPlatforms.some((platform) => !validPlatforms.includes(platform))) {
    return res.status(400).json({ error: 'Unsupported platform selected' });
  }

  if (!Number.isInteger(parsedMaxLeads) || parsedMaxLeads < 1 || parsedMaxLeads > 100) {
    return res.status(400).json({ error: 'maxLeads must be between 1 and 100' });
  }

  const run = getDb()
    .prepare(
      `INSERT INTO discovery_runs (keyword, platforms, leads_found, status)
       VALUES (?, ?, 0, 'running')`
    )
    .run(String(keyword).trim(), JSON.stringify(selectedPlatforms));

  const jobId = run.lastInsertRowid;

  setImmediate(() => {
    discoverLeads(String(keyword).trim(), selectedPlatforms, parsedMaxLeads, jobId)
      .catch((error) => {
        getDb().prepare('UPDATE discovery_runs SET status = ? WHERE id = ?').run('failed', jobId);
        emitJobEvent(jobId, { type: 'error', jobId, message: error.message });
        closeJobStream(jobId);
      });
  });

  return res.status(202).json({ jobId });
});

router.get('/stream/:jobId', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  registerJobStream(req.params.jobId, res);
});

router.post('/stop/:jobId', (req, res) => {
  const result = getDb()
    .prepare("UPDATE discovery_runs SET status = 'stopping' WHERE id = ? AND status = 'running'")
    .run(req.params.jobId);

  stopDiscovery(req.params.jobId);
  return res.json({ stopped: result.changes > 0 });
});

router.get('/results', (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = (page - 1) * limit;
  const where = ["status = 'discovered'"];
  const params = {};

  if (req.query.platform) {
    where.push('platform = @platform');
    params.platform = req.query.platform;
  }

  if (req.query.keyword) {
    where.push('source_keyword LIKE @keyword');
    params.keyword = `%${req.query.keyword}%`;
  }

  if (req.query.dateFrom) {
    where.push('DATE(created_at) >= DATE(@dateFrom)');
    params.dateFrom = req.query.dateFrom;
  }

  if (req.query.dateTo) {
    where.push('DATE(created_at) <= DATE(@dateTo)');
    params.dateTo = req.query.dateTo;
  }

  const whereSql = where.join(' AND ');
  const total = getDb()
    .prepare(`SELECT COUNT(*) AS total FROM leads WHERE ${whereSql}`)
    .get(params).total;
  const leads = getDb()
    .prepare(
      `SELECT *
       FROM leads
       WHERE ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset });

  res.json({
    page,
    limit,
    total,
    leads
  });
});

router.post('/add-to-queue', (req, res) => {
  const leadIds = sanitizeLeadIds(req.body.leadIds);
  if (leadIds.length === 0) {
    return res.status(400).json({ error: 'leadIds is required' });
  }

  const updated = updateLeadStatuses(leadIds, 'pending_qualification');
  return res.json({ updated });
});

router.post('/dismiss', (req, res) => {
  const leadIds = sanitizeLeadIds(req.body.leadIds);
  if (leadIds.length === 0) {
    return res.status(400).json({ error: 'leadIds is required' });
  }

  const updated = updateLeadStatuses(leadIds, 'dismissed');
  return res.json({ updated });
});

router.get('/history', (req, res) => {
  const runs = getDb()
    .prepare('SELECT * FROM discovery_runs ORDER BY run_at DESC, id DESC')
    .all()
    .map((run) => ({
      ...run,
      platforms: parseJsonArray(run.platforms)
    }));

  res.json({ runs });
});

router.post('/history/:id/rerun', (req, res) => {
  const run = getDb()
    .prepare('SELECT * FROM discovery_runs WHERE id = ?')
    .get(req.params.id);

  if (!run) {
    return res.status(404).json({ error: 'Discovery run not found' });
  }

  const platforms = parseJsonArray(run.platforms);
  const created = getDb()
    .prepare(
      `INSERT INTO discovery_runs (keyword, platforms, leads_found, status)
       VALUES (?, ?, 0, 'running')`
    )
    .run(run.keyword, JSON.stringify(platforms));
  const jobId = created.lastInsertRowid;
  const maxLeads = Number(req.body.maxLeads) || 50;

  setImmediate(() => {
    discoverLeads(run.keyword, platforms, Math.min(Math.max(maxLeads, 1), 100), jobId)
      .catch((error) => {
        getDb().prepare('UPDATE discovery_runs SET status = ? WHERE id = ?').run('failed', jobId);
        emitJobEvent(jobId, { type: 'error', jobId, message: error.message });
        closeJobStream(jobId);
      });
  });

  return res.status(202).json({ jobId });
});

function sanitizeLeadIds(leadIds) {
  if (!Array.isArray(leadIds)) {
    return [];
  }

  return [...new Set(leadIds.map(Number).filter(Number.isInteger))];
}

function updateLeadStatuses(leadIds, status) {
  const update = getDb().prepare(
    `UPDATE leads
     SET status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  );
  const transaction = getDb().transaction((ids) => {
    let updated = 0;
    ids.forEach((id) => {
      updated += update.run(status, id).changes;
    });
    return updated;
  });

  return transaction(leadIds);
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Keyword Management
// ---------------------------------------------------------------------------

function resolveKeywordsPath() {
  return path.resolve(keywordsFilePath());
}

function readKeywordsFile() {
  const filePath = resolveKeywordsPath();
  try {
    if (!fs.existsSync(filePath)) {
      return { version: 1, keywords: [], platforms: ['linkedin', 'facebook'], maxLeadsPerKeyword: 10 };
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { version: 1, keywords: [], platforms: ['linkedin', 'facebook'], maxLeadsPerKeyword: 10 };
  }
}

function writeKeywordsFile(data) {
  const filePath = resolveKeywordsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// GET /api/discovery/keywords — returns keywords.json contents
router.get('/keywords', (req, res) => {
  res.json(readKeywordsFile());
});

// POST /api/discovery/keywords — replaces full keywords config
router.post('/keywords', (req, res) => {
  const { keywords, platforms, maxLeadsPerKeyword } = req.body;

  if (!Array.isArray(keywords) || keywords.length === 0) {
    return res.status(400).json({ error: 'keywords must be a non-empty array' });
  }

  const sanitizedKeywords = keywords
    .map(k => String(k || '').trim())
    .filter(Boolean);

  if (sanitizedKeywords.length === 0) {
    return res.status(400).json({ error: 'At least one non-empty keyword is required' });
  }

  const config = readKeywordsFile();
  config.keywords = sanitizedKeywords;
  if (Array.isArray(platforms) && platforms.length > 0) {
    config.platforms = platforms.map(p => String(p).trim().toLowerCase());
  }
  if (typeof maxLeadsPerKeyword === 'number' && maxLeadsPerKeyword >= 1 && maxLeadsPerKeyword <= 100) {
    config.maxLeadsPerKeyword = maxLeadsPerKeyword;
  }
  config.version = (config.version || 0) + 1;

  writeKeywordsFile(config);
  res.json({ success: true, config });
});

// POST /api/discovery/keywords/add — appends a single keyword
router.post('/keywords/add', (req, res) => {
  const keyword = String(req.body.keyword || '').trim();
  if (!keyword) {
    return res.status(400).json({ error: 'keyword is required' });
  }

  const config = readKeywordsFile();
  if (config.keywords.includes(keyword)) {
    return res.status(409).json({ error: 'Keyword already exists', config });
  }

  config.keywords.push(keyword);
  config.version = (config.version || 0) + 1;
  writeKeywordsFile(config);
  res.json({ success: true, config });
});

// DELETE /api/discovery/keywords/:idx — removes keyword at index
router.delete('/keywords/:idx', (req, res) => {
  const idx = Number(req.params.idx);
  const config = readKeywordsFile();

  if (!Number.isInteger(idx) || idx < 0 || idx >= config.keywords.length) {
    return res.status(400).json({ error: `Invalid index: ${req.params.idx}. Must be 0-${config.keywords.length - 1}` });
  }

  const removed = config.keywords.splice(idx, 1)[0];
  config.version = (config.version || 0) + 1;
  writeKeywordsFile(config);
  res.json({ success: true, removed, config });
});

module.exports = router;
