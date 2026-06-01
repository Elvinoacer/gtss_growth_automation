/**
 * monitoring.js - Monitoring API endpoints
 *
 * Improvements:
 * - Status derived from full event history
 * - Explicit lifecycle event support
 * - Accurate stats (not limited to 400 jobs)
 * - Better error handling
 * - Duration calculation
 */

const express = require("express");
const { getDb } = require("../db/database");
const jobRegistry = require("../jobs/jobRegistry");

const router = express.Router();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function parseContextJson(value) {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

/**
 * Determines job status using ALL events for the job,
 * not just the latest event.
 */
function deriveJobStatus(events) {
  if (!events || !events.length) {
    return "running";
  }

  let status = "running";

  for (const event of events) {
    const stage = normalize(event.stage);
    const level = normalize(event.level);

    const isCompleted =
      stage === "completed" ||
      stage === "complete" ||
      stage === "done" ||
      stage === "finished";
    const isRetrying =
      stage === "retry" || stage === "retrying" || level === "retry";
    const isFailed =
      stage === "failed" || stage === "error" || level === "error";

    if (isCompleted) {
      status = "completed";
    } else if (isRetrying) {
      status = "retrying";
    } else if (isFailed) {
      status = "failed";
    }
  }

  return status;
}

function humanizeStage(stage) {
  const label = String(stage || "waiting").replace(/_/g, " ");
  const stageMap = {
    image_gen: "Generating or saving the AI image",
    caption_gen: "Writing platform captions",
    publish: "Publishing to social platforms",
    prompt_generating: "Asking Gemini to refine the image prompt",
    prompt_ready: "Prompt is ready for Gemini Web",
    gemini_web_text: "Waiting for Gemini Web text",
    discovery: "Finding leads",
    qualification: "Scoring leads",
    messages: "Generating outreach messages",
    send: "Sending outreach",
  };
  return stageMap[stage] || label.charAt(0).toUpperCase() + label.slice(1);
}

function buildHumanSummary(job) {
  const type = String(job.job_type || job.type || "job").replace(/_/g, " ");
  const stage = humanizeStage(job.stage);
  const platform = job.context?.platform || job.platform;
  const base = `${type}: ${stage}`;
  const bits = [];
  if (platform) bits.push(`platform ${platform}`);
  if (job.context?.postId || job.context?.post_id) bits.push(`post #${job.context.postId || job.context.post_id}`);
  if (job.context?.leadId || job.context?.lead_id) bits.push(`lead #${job.context.leadId || job.context.lead_id}`);
  return bits.length ? `${base} (${bits.join(", ")})` : base;
}

function calculateDuration(startedAt, lastEventAt) {
  const start = new Date(startedAt).getTime();
  const end = new Date(lastEventAt).getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }

  return Math.max(0, end - start);
}

/* -------------------------------------------------------------------------- */
/* Job Snapshot Loader                                                        */
/* -------------------------------------------------------------------------- */

function loadJobSnapshots(limit = 120) {
  const db = getDb();

  const jobs = db
    .prepare(
      `
      SELECT
        job_id,
        job_type,
        MIN(created_at) AS started_at,
        MAX(created_at) AS last_event_at
      FROM pipeline_events
      WHERE job_id IS NOT NULL
      GROUP BY job_id, job_type
      ORDER BY last_event_at DESC
      LIMIT ?
    `,
    )
    .all(limit);

  const eventStmt = db.prepare(`
    SELECT *
    FROM pipeline_events
    WHERE job_id = ?
      AND job_type = ?
    ORDER BY id ASC
  `);

  return jobs.map((job) => {
    const events = eventStmt.all(job.job_id, job.job_type);

    const lastEvent = events[events.length - 1];

    const snapshot = {
      job_id: job.job_id,
      job_type: job.job_type,

      started_at: job.started_at,
      last_event_at: job.last_event_at,

      duration_ms: calculateDuration(job.started_at, job.last_event_at),

      status: deriveJobStatus(events),

      stage: lastEvent?.stage || null,
      level: lastEvent?.level || null,
      message: lastEvent?.message || null,

      context: parseContextJson(lastEvent?.context_json),
    };
    snapshot.human_summary = buildHumanSummary(snapshot);
    return snapshot;
  });
}

/* -------------------------------------------------------------------------- */
/* GET /api/monitoring/jobs                                                   */
/* -------------------------------------------------------------------------- */

router.get("/jobs", (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 120, 1000);

    const jobs = loadJobSnapshots(limit);
    const seen = new Set(jobs.map((job) => `${job.job_type}:${job.job_id}`));
    for (const active of jobRegistry.listActiveJobs()) {
      const jobType = active.type || active.pipelineId || 'active';
      const key = `${jobType}:${active.jobId}`;
      if (seen.has(key)) continue;
      const activeSnapshot = {
        job_id: active.jobId,
        job_type: jobType,
        started_at: active.startedAt,
        last_event_at: active.updatedAt || active.startedAt,
        duration_ms: calculateDuration(active.startedAt, active.updatedAt || new Date().toISOString()),
        status: active.aborted ? 'failed' : 'running',
        stage: active.stage || 'running',
        level: 'info',
        message: active.message || 'Active job is currently running.',
        context: { pipelineId: active.pipelineId, platform: active.platform },
      };
      activeSnapshot.human_summary = buildHumanSummary(activeSnapshot);
      jobs.unshift(activeSnapshot);
    }

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
    console.error("[MONITORING] Failed to load jobs:", err);

    res.status(500).json({
      running: [],
      completed: [],
      failed: [],
      retrying: [],
    });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/monitoring/jobs/:jobId                                            */
/* -------------------------------------------------------------------------- */

router.get("/jobs/:jobId", (req, res) => {
  const jobId = String(req.params.jobId);
  const jobType = req.query.jobType ? String(req.query.jobType) : null;

  const limit = Math.min(Number(req.query.limit) || 500, 2000);

  try {
    const db = getDb();

    let rows;

    if (jobType) {
      rows = db
        .prepare(
          `
          SELECT *
          FROM pipeline_events
          WHERE job_id = ?
            AND job_type = ?
          ORDER BY id ASC
          LIMIT ?
        `,
        )
        .all(jobId, jobType, limit);
    } else {
      rows = db
        .prepare(
          `
          SELECT *
          FROM pipeline_events
          WHERE job_id = ?
          ORDER BY id ASC
          LIMIT ?
        `,
        )
        .all(jobId, limit);
    }

    const events = rows.map((row) => ({
      id: row.id,
      job_id: row.job_id,
      job_type: row.job_type,
      stage: row.stage,
      level: row.level,
      message: row.message,
      context: parseContextJson(row.context_json),
      created_at: row.created_at,
    }));

    res.json({
      jobId,
      jobType,
      status: deriveJobStatus(rows),
      event_count: events.length,
      events,
    });
  } catch (err) {
    console.error("[MONITORING] Failed to load job timeline:", err);

    res.status(500).json({
      jobId,
      jobType,
      status: "unknown",
      event_count: 0,
      events: [],
    });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/monitoring/errors                                                 */
/* -------------------------------------------------------------------------- */

router.get("/errors", (req, res) => {
  const jobType = req.query.jobType ? String(req.query.jobType) : null;

  const limit = Math.min(Number(req.query.limit) || 100, 1000);

  try {
    const db = getDb();

    let rows;

    if (jobType) {
      rows = db
        .prepare(
          `
          SELECT *
          FROM pipeline_events
          WHERE LOWER(level) = 'error'
            AND job_type = ?
          ORDER BY id DESC
          LIMIT ?
        `,
        )
        .all(jobType, limit);
    } else {
      rows = db
        .prepare(
          `
          SELECT *
          FROM pipeline_events
          WHERE LOWER(level) = 'error'
          ORDER BY id DESC
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

    res.json({
      count: errors.length,
      errors,
    });
  } catch (err) {
    console.error("[MONITORING] Failed to load errors:", err);

    res.status(500).json({
      count: 0,
      errors: [],
    });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/monitoring/stats                                                  */
/* -------------------------------------------------------------------------- */

router.get("/stats", (req, res) => {
  try {
    const db = getDb();

    const rows = db
      .prepare(
        `
        SELECT
          job_id,
          job_type
        FROM pipeline_events
        WHERE job_id IS NOT NULL
          AND created_at >= datetime('now', '-24 hours')
        GROUP BY job_id, job_type
      `,
      )
      .all();

    const stats = {
      running: 0,
      completed: 0,
      failed: 0,
      retrying: 0,
    };

    const eventStmt = db.prepare(`
      SELECT *
      FROM pipeline_events
      WHERE job_id = ?
        AND job_type = ?
      ORDER BY id ASC
    `);

    for (const job of rows) {
      const events = eventStmt.all(job.job_id, job.job_type);

      const status = deriveJobStatus(events);

      if (stats[status] !== undefined) {
        stats[status]++;
      }
    }

    res.json({
      period: "24h",
      total: stats.running + stats.completed + stats.failed + stats.retrying,
      stats,
    });
  } catch (err) {
    console.error("[MONITORING] Failed to compute stats:", err);

    res.status(500).json({
      period: "24h",
      total: 0,
      stats: {
        running: 0,
        completed: 0,
        failed: 0,
        retrying: 0,
      },
    });
  }
});

module.exports = router;
