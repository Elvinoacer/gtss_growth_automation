/**
 * monitoring.js - Monitoring API endpoints
 */

const express = require("express");
const { getDb } = require("../db/database");

const router = express.Router();

function parseContextJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function deriveStatus(row) {
  const stage = String(row.stage || "").toLowerCase();
  const level = String(row.level || "").toLowerCase();

  if (level === "error" || stage === "error" || stage === "failed")
    return "failed";
  if (level === "retry" || stage === "retry") return "retrying";
  if (
    stage === "complete" ||
    stage === "completed" ||
    stage === "done" ||
    stage === "finished"
  ) {
    return "completed";
  }
  if (stage === "start" || stage === "started" || stage === "running")
    return "running";
  return "running";
}

function loadJobSnapshots(limit) {
  const db = getDb();
  const latestRows = db
    .prepare(
      `
    SELECT pe.*
    FROM pipeline_events pe
    JOIN (
      SELECT job_id, job_type, MAX(id) AS max_id
      FROM pipeline_events
      WHERE job_id IS NOT NULL
      GROUP BY job_id, job_type
    ) latest
    ON pe.id = latest.max_id
    ORDER BY pe.created_at DESC
    LIMIT ?
  `,
    )
    .all(limit);

  const startRows = db
    .prepare(
      `
    SELECT job_id, job_type, MIN(created_at) AS started_at
    FROM pipeline_events
    WHERE job_id IS NOT NULL
    GROUP BY job_id, job_type
  `,
    )
    .all();

  const startMap = new Map();
  startRows.forEach((row) => {
    startMap.set(`${row.job_type}::${row.job_id}`, row.started_at);
  });

  return latestRows.map((row) => {
    const key = `${row.job_type}::${row.job_id}`;
    return {
      job_id: row.job_id,
      job_type: row.job_type,
      stage: row.stage,
      level: row.level,
      message: row.message,
      started_at: startMap.get(key) || row.created_at,
      last_event_at: row.created_at,
      status: deriveStatus(row),
      context: parseContextJson(row.context_json),
    };
  });
}

// GET /api/monitoring/jobs
router.get("/jobs", (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 120, 300);
    const jobs = loadJobSnapshots(limit);

    const buckets = {
      running: [],
      completed: [],
      failed: [],
      retrying: [],
    };

    jobs.forEach((job) => {
      const bucket = buckets[job.status] || buckets.running;
      bucket.push(job);
    });

    res.json(buckets);
  } catch (err) {
    res.json({ running: [], completed: [], failed: [], retrying: [] });
  }
});

// GET /api/monitoring/jobs/:jobId
router.get("/jobs/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const jobType = req.query.jobType ? String(req.query.jobType) : null;
  const limit = Math.min(Number(req.query.limit) || 200, 600);

  try {
    const db = getDb();
    let rows;
    if (jobType) {
      rows = db
        .prepare(
          `
        SELECT * FROM pipeline_events
        WHERE job_id = ? AND job_type = ?
        ORDER BY id DESC
        LIMIT ?
      `,
        )
        .all(jobId, jobType, limit);
    } else {
      rows = db
        .prepare(
          `
        SELECT * FROM pipeline_events
        WHERE job_id = ?
        ORDER BY id DESC
        LIMIT ?
      `,
        )
        .all(jobId, limit);
    }

    const events = rows.reverse().map((row) => ({
      id: row.id,
      job_id: row.job_id,
      job_type: row.job_type,
      stage: row.stage,
      level: row.level,
      message: row.message,
      context: parseContextJson(row.context_json),
      created_at: row.created_at,
    }));

    res.json({ jobId, jobType, events });
  } catch (err) {
    res.json({ jobId, jobType, events: [] });
  }
});

// GET /api/monitoring/errors
router.get("/errors", (req, res) => {
  const jobType = req.query.jobType ? String(req.query.jobType) : null;
  const limit = Math.min(Number(req.query.limit) || 100, 300);

  try {
    const db = getDb();
    let rows;
    if (jobType) {
      rows = db
        .prepare(
          `
        SELECT * FROM pipeline_events
        WHERE level = 'error' AND job_type = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
        )
        .all(jobType, limit);
    } else {
      rows = db
        .prepare(
          `
        SELECT * FROM pipeline_events
        WHERE level = 'error'
        ORDER BY created_at DESC
        LIMIT ?
      `,
        )
        .all(limit);
    }

    const errors = rows.map((row) => ({
      id: row.id,
      job_id: row.job_id,
      job_type: row.job_type,
      stage: row.stage,
      message: row.message,
      context: parseContextJson(row.context_json),
      created_at: row.created_at,
    }));

    res.json({ errors });
  } catch (err) {
    res.json({ errors: [] });
  }
});

// GET /api/monitoring/stats
router.get("/stats", (req, res) => {
  try {
    const jobs = loadJobSnapshots(400);
    const since = Date.now() - 24 * 60 * 60 * 1000;

    const stats = {
      running: 0,
      completed: 0,
      failed: 0,
      retrying: 0,
    };

    jobs.forEach((job) => {
      const startedAt = new Date(job.started_at).getTime();
      if (!Number.isFinite(startedAt) || startedAt < since) return;
      if (stats[job.status] !== undefined) {
        stats[job.status] += 1;
      }
    });

    res.json({ stats });
  } catch (err) {
    res.json({ stats: { running: 0, completed: 0, failed: 0, retrying: 0 } });
  }
});

module.exports = router;
