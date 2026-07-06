/**
 * pipelines.js — Pipeline Manager API Routes
 *
 * Endpoints (existing):
 *   GET    /api/pipelines                  — List all pipeline schedules (with runtime state)
 *   PATCH  /api/pipelines/:id              — Update a pipeline schedule (cron, enabled, limits)
 *   POST   /api/pipelines/:id/run          — Trigger a manual run now
 *   GET    /api/pipelines/:id/history      — Recent pipeline runs (legacy, kept for compat)
 *   POST   /api/pipelines/:id/pause        — Pause the pipeline
 *   POST   /api/pipelines/:id/resume       — Resume the pipeline
 *   POST   /api/pipelines/:id/stop         — Stop the active execution
 *
 * Endpoints (new in pipelines overhaul):
 *   POST   /api/pipelines/:id/restart               — Stop current (if any) and start a fresh run
 *   POST   /api/pipelines/:id/retry-stage           — Retry a specific failed stage of the active execution
 *   POST   /api/pipelines/:id/resume-from-checkpoint — Resume the active execution from the last successful checkpoint
 *   GET    /api/pipelines/:id/executions            — List recent executions (with state, progress, errors)
 *   GET    /api/pipelines/:id/executions/:eid       — Get a single execution detail (with checkpoints & recent logs)
 *   GET    /api/pipelines/:id/logs                  — Searchable / filterable structured logs
 *   GET    /api/pipelines/:id/health                — Pipeline health snapshot (success rate, uptime, etc.)
 *   GET    /api/pipelines/:id/checkpoints           — List checkpoints for the active or specified execution
 *   GET    /api/pipelines/health                    — Health snapshot for all pipelines
 */

const express = require('express');
const { getDb } = require('../db/database');
const {
  syncFromDb,
  runPipelineWithLifecycle,
  isPipelinePaused,
} = require('../jobs/pipelineScheduler');
const cronRegistry = require('../jobs/cronRegistry');
const cron = require('node-cron');
const logger = require('../utils/logger');
const jobRegistry = require('../jobs/jobRegistry');
const { logActivity } = require('../services/auditService');
const pipelineState = require('../services/pipelineStateService');
const pipelineLogger = require('../services/pipelineLogger');
const checkpointService = require('../services/pipelineCheckpoint');
const { getHealth, getHealthForAll } = require('../services/pipelineHealthService');

const router = express.Router();

const ALLOWED_CONTENT_PLATFORMS = new Set(['instagram', 'linkedin', 'x', 'facebook']);
const ALLOWED_OUTREACH_PLATFORMS = new Set(['instagram', 'linkedin', 'x', 'facebook']);

const PIPELINE_STAGES = {
  outreach: ['discovery', 'qualification', 'messages', 'send'],
  content: ['image_gen', 'caption_gen', 'post_record', 'publish'],
  dm_check: ['scan'],
};

function parseJsonObject(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch (_) {
    return fallback;
  }
}

function parseBoolean(value) {
  if (value === undefined) return undefined;
  if (value === true || value === 1 || value === 'true') return true;
  if (value === false || value === 0 || value === 'false') return false;
  return Boolean(value);
}

function getPipelineActiveJobs(id) {
  return jobRegistry
    .listActiveJobs()
    .filter((job) => job.pipelineId === id)
    .map((job) => ({
      jobId: job.jobId,
      type: job.type,
      stage: job.stage || null,
      message: job.message || null,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt || null,
    }));
}

function buildRuntimeState(row, paused) {
  const activeJobs = getPipelineActiveJobs(row.id);
  const activeExec = pipelineState.getActiveExecution(row.id);
  const isRunning = activeJobs.length > 0 || Boolean(activeExec);
  const stateFromDb = row.current_state || row.last_status || 'idle';
  let state;
  if (paused && !isRunning) state = 'paused';
  else if (isRunning) state = activeExec?.status || row.last_status || 'running';
  else state = row.enabled ? stateFromDb : 'disabled';
  if (state === 'idle' && row.last_status === 'failed') state = 'failed';
  if (state === 'idle' && row.last_status === 'completed') state = 'completed';

  const currentJob = activeJobs[0] || null;
  return {
    state,
    active_jobs: activeJobs,
    active_job_count: activeJobs.length,
    active_execution_id: activeExec?.id || row.current_execution_id || null,
    current_stage: activeExec?.current_stage || currentJob?.stage || null,
    current_message: activeExec?.current_message || currentJob?.message || null,
    progress: activeExec?.progress || 0,
    completed_steps: activeExec?.completed_steps || 0,
    total_steps: activeExec?.total_steps || 0,
    can_run: Boolean(row.enabled) && !paused && !isRunning,
    can_pause: Boolean(row.enabled) && !paused,
    can_resume: Boolean(paused) || (isRunning && (activeExec?.status === 'paused')),
    can_stop: isRunning,
    can_restart: true,
  };
}

function broadcastPipelineStatus(id, overrides = {}) {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM pipeline_schedules WHERE id = ?').get(id);
    if (!row) return;
    const paused = isPipelinePaused(id);
    const { broadcast } = require('../services/socketService');
    broadcast('pipeline:status', {
      id,
      status: row.last_status || 'idle',
      last_run_at: row.last_run_at,
      ...buildRuntimeState(row, paused),
      ...overrides,
    });
  } catch (_) {}
}

function normalizeLimits(id, limits) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    return {};
  }

  const next = { ...limits };
  for (const key of [
    'max_leads_per_keyword',
    'max_dms_per_run',
    'max_connections_per_run',
    'max_posts_per_run',
  ]) {
    if (next[key] !== undefined) {
      const numeric = Number(next[key]);
      if (!Number.isFinite(numeric) || numeric < 1) {
        throw new Error(`${key} must be a positive number`);
      }
      next[key] = Math.floor(numeric);
    }
  }

  if (id === 'content') {
    if (next.topic !== undefined) {
      next.topic = String(next.topic).trim();
    }
    if (next.style !== undefined) {
      next.style = String(next.style).trim() || 'photorealistic';
    }
    if (next.platforms !== undefined) {
      if (!Array.isArray(next.platforms)) {
        throw new Error('platforms must be an array');
      }
      next.platforms = next.platforms
        .map((platform) => String(platform).trim().toLowerCase())
        .filter((platform) => ALLOWED_CONTENT_PLATFORMS.has(platform));
      if (next.platforms.length === 0) {
        throw new Error('Select at least one content platform');
      }
    }
  }
  if (id === 'outreach') {
    if (next.platforms !== undefined) {
      if (!Array.isArray(next.platforms)) {
        throw new Error('platforms must be an array');
      }
      next.platforms = next.platforms
        .map((platform) => String(platform).trim().toLowerCase())
        .filter((platform) => ALLOWED_OUTREACH_PLATFORMS.has(platform));
      if (next.platforms.length === 0) {
        throw new Error('Select at least one outreach platform');
      }
    }
  }
  if (id === 'dm_check') {
    for (const key of ['active_hours_start', 'active_hours_end']) {
      if (next[key] !== undefined) next[key] = Number(next[key]);
    }
    if (next.platforms !== undefined && !Array.isArray(next.platforms)) {
      throw new Error('platforms must be an array');
    }
    if (Array.isArray(next.platforms)) {
      next.platforms = next.platforms.map((platform) => String(platform).trim().toLowerCase()).filter(Boolean);
    }
    if (next.timezone !== undefined) next.timezone = String(next.timezone).trim() || 'UTC';
    if (next.prompt !== undefined) next.prompt = String(next.prompt);
  }

  return next;
}

// ── GET /api/pipelines ── List all pipeline schedules
router.get('/', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM pipeline_schedules ORDER BY id').all();
  const activeCrons = cronRegistry.listAll();

  const result = rows.map(row => {
    const limits = parseJsonObject(row.limits_json);
    const paused = isPipelinePaused(row.id);
    return {
      ...row,
      limits,
      paused,
      stages: PIPELINE_STAGES[row.id] || [],
      ...buildRuntimeState(row, paused),
      is_registered: activeCrons.some(c => c.id === `pipeline:${row.id}`),
    };
  });

  res.json({ pipelines: result });
});

router.get('/active', (_req, res) => {
  res.json({ jobs: jobRegistry.listActiveJobs() });
});

// ── GET /api/pipelines/health ── Health snapshot for all pipelines
router.get('/health', (req, res) => {
  try {
    const all = getHealthForAll();
    res.json({ pipelines: all });
  } catch (err) {
    logger.error('PIPELINES-API', 'Failed to load health', err);
    res.status(500).json({ error: err.message, pipelines: [] });
  }
});

// ── PATCH /api/pipelines/:id ── Update a pipeline schedule
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { enabled, cron: cronExpr, limits } = req.body;
  const db = getDb();

  const row = db.prepare('SELECT * FROM pipeline_schedules WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });

  const nextCron = cronExpr !== undefined ? String(cronExpr).trim() : row.cron;
  if (!cron.validate(nextCron)) {
    return res.status(400).json({ error: `Invalid cron expression: ${nextCron}` });
  }

  let mergedLimits;
  try {
    mergedLimits = {
      ...parseJsonObject(row.limits_json),
      ...normalizeLimits(id, limits),
    };
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const nextEnabled =
    enabled !== undefined ? parseBoolean(enabled) : Boolean(row.enabled);

  if (nextEnabled && id === 'content') {
    if (!mergedLimits.topic || !String(mergedLimits.topic).trim()) {
      return res.status(400).json({
        error: 'A content topic is required before enabling the Auto-Content Pipeline',
      });
    }
  }

  db.prepare(`
    UPDATE pipeline_schedules
    SET enabled = ?, cron = ?, limits_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(nextEnabled ? 1 : 0, nextCron, JSON.stringify(mergedLimits), id);

  await syncFromDb();

  const updated = db.prepare('SELECT * FROM pipeline_schedules WHERE id = ?').get(id);
  const updatedLimits = parseJsonObject(updated.limits_json);
  const paused = isPipelinePaused(id);

  res.json({
    ok: true,
    pipeline: {
      ...updated,
      limits: updatedLimits,
      paused,
      stages: PIPELINE_STAGES[id] || [],
      ...buildRuntimeState(updated, paused),
      is_registered: cronRegistry.isRegistered(`pipeline:${id}`),
    },
  });
});

// ── POST /api/pipelines/:id/run ── Trigger a manual run now
router.post('/:id/run', async (req, res) => {
  const { id } = req.params;
  const db = getDb();
  const row = db.prepare('SELECT * FROM pipeline_schedules WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });

  let limits = {};
  limits = {
    ...parseJsonObject(row.limits_json),
    ...normalizeLimits(id, req.body?.limits || {}),
  };
  const keywords = Array.isArray(req.body?.keywords)
    ? req.body.keywords.map((keyword) => String(keyword).trim()).filter(Boolean)
    : [];

  if (isPipelinePaused(id)) {
    return res.status(409).json({ error: 'Pipeline is paused. Resume it before running manually.' });
  }
  if (pipelineState.getActiveExecution(id)) {
    return res.status(409).json({
      error: 'Pipeline is already running. Wait for it to finish or stop it first.',
      execution_id: pipelineState.getActiveExecution(id)?.id,
    });
  }

  if (id === 'content' && (!limits.topic || !String(limits.topic).trim())) {
    return res.status(400).json({
      error: 'A content topic is required before running the Auto-Content Pipeline',
    });
  }

  // Respond immediately; run in background via the lifecycle service
  res.json({ ok: true, message: `Pipeline "${row.name}" triggered manually` });

  setImmediate(async () => {
    try {
      const execId = await runPipelineWithLifecycle(id, 'manual', limits, {
        keywords,
        force: true,
      });
      logger.info('PIPELINES-API', `Manual run of "${id}" started as execution ${execId}`);
    } catch (err) {
      logger.error('PIPELINES-API', `Manual run of "${id}" failed`, err);
      broadcastPipelineStatus(id, {
        status: 'failed',
        state: 'failed',
        error: err.message,
      });
    }
  });
});

// ── POST /api/pipelines/:id/restart ── Stop current (if any) and start fresh
router.post('/:id/restart', async (req, res) => {
  const { id } = req.params;
  const db = getDb();
  const row = db.prepare('SELECT * FROM pipeline_schedules WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });

  if (isPipelinePaused(id)) {
    return res.status(409).json({ error: 'Pipeline is paused. Resume it before restarting.' });
  }

  // If there's an active execution, attempt a graceful stop first. If the
  // grace period elapses without the runner noticing the abort flag (i.e.,
  // the runner is truly stuck), we force-clear the execution so the new run
  // can start. Previously, a stuck execution would block restart forever —
  // now restart is always able to recover.
  const active = pipelineState.getActiveExecution(id);
  if (active) {
    pipelineState.requestStop(id);
    // Brief grace period for the runner to notice the abort flag.
    await new Promise((r) => setTimeout(r, 600));
    const stillActive = pipelineState.getActiveExecution(id);
    if (stillActive && stillActive.id === active.id) {
      logger.warn('PIPELINES-API', `Restart of "${id}": stuck execution ${active.id} did not respond to stop — force-clearing.`);
      pipelineState.forceClearExecution(id, `restart (stuck execution did not respond to stop)`);
    }
  }

  // Clear any checkpoints for the previous execution so the new run starts fresh
  if (active) {
    try { checkpointService.clearCheckpoints(active.id); } catch (_) {}
  }

  let limits = {
    ...parseJsonObject(row.limits_json),
    ...normalizeLimits(id, req.body?.limits || {}),
  };
  const keywords = Array.isArray(req.body?.keywords)
    ? req.body.keywords.map((keyword) => String(keyword).trim()).filter(Boolean)
    : [];

  if (id === 'content' && (!limits.topic || !String(limits.topic).trim())) {
    return res.status(400).json({
      error: 'A content topic is required before restarting the Auto-Content Pipeline',
    });
  }

  // Make sure the schedule-level pause flag is cleared (restart implies resume)
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, 'false')
     ON CONFLICT(key) DO UPDATE SET value = 'false'`,
  ).run(`pipeline_${id}_paused`);

  res.json({ ok: true, message: `Pipeline "${row.name}" restarting` });

  setImmediate(async () => {
    try {
      const execId = await runPipelineWithLifecycle(id, 'manual', limits, { keywords, force: true });
      logger.info('PIPELINES-API', `Restart of "${id}" started as execution ${execId}`);
    } catch (err) {
      logger.error('PIPELINES-API', `Restart of "${id}" failed`, err);
      broadcastPipelineStatus(id, { status: 'failed', state: 'failed', error: err.message });
    }
  });
});

// ── POST /api/pipelines/:id/retry-stage ── Retry a specific failed stage
// Body: { stage: "discovery" | "send" | "publish" | ... } OR { executionId: "..." }
// If no executionId provided, uses the most recent failed execution for this pipeline.
//
// If no `stage` is provided AND the execution has no recorded `failed_stage`,
// we default to the FIRST stage of the pipeline (i.e., start over). This
// fixes the previous behavior of returning 400 "specify stage in the reset
// body" — which left the user with no way to retry a stuck execution that
// never recorded a failed_stage because it died mid-stage.
router.post('/:id/retry-stage', async (req, res) => {
  const { id } = req.params;
  const db = getDb();
  const row = db.prepare('SELECT * FROM pipeline_schedules WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });

  const stage = req.body?.stage ? String(req.body.stage) : null;
  let executionId = req.body?.executionId ? String(req.body.executionId) : null;

  if (!executionId) {
    // Find the most recent failed execution for this pipeline
    const recent = db
      .prepare(
        `SELECT id FROM pipeline_executions
         WHERE pipeline_id = ? AND status = 'failed'
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(id);
    if (!recent) {
      return res.status(404).json({
        error: 'No failed execution found to retry. Run the pipeline first.',
      });
    }
    executionId = recent.id;
  }

  const exec = db
    .prepare('SELECT * FROM pipeline_executions WHERE id = ?')
    .get(executionId);
  if (!exec) {
    return res.status(404).json({ error: `Execution ${executionId} not found` });
  }
  if (exec.pipeline_id !== id) {
    return res.status(400).json({ error: 'Execution does not belong to this pipeline' });
  }
  if (exec.status === 'running' || exec.status === 'paused') {
    return res.status(409).json({
      error: `Execution is currently ${exec.status}. Stop it first before retrying.`,
    });
  }
  if (pipelineState.getActiveExecution(id)) {
    // If there's a stuck "running" execution in memory, refuse to start a
    // retry on top of it — the user should force-clear it first. We point
    // them at the right endpoint so they don't have to guess.
    return res.status(409).json({
      error: 'Another execution is already running. Stop it or use POST /api/pipelines/:id/force-clear to clear a stuck state.',
      hint: 'force_clear',
    });
  }

  // Determine the stage to retry:
  //  1. If a stage is provided in the body, use it.
  //  2. Otherwise, use the failed_stage recorded on the execution row.
  //  3. If neither is set (the runner died before recording a failed_stage),
  //     fall back to the FIRST stage of the pipeline — i.e., retry from the
  //     beginning. This is the fix for the "we need to specify stage in the
  //     reset body" dead-end.
  const orderedStages = PIPELINE_STAGES[id] || [];
  let failedStage = stage || exec.failed_stage;
  if (!failedStage) {
    failedStage = orderedStages[0] || null;
  }
  if (!failedStage) {
    // Pipeline has no defined stages (e.g., dm_check has only 'scan' but
    // we couldn't find it). Just bail with a clearer message.
    return res.status(400).json({
      error: 'Could not determine which stage to retry. Pass "stage" in the request body.',
    });
  }

  // Clear the failed checkpoint so the runner will re-run that stage
  try {
    db.prepare(
      'DELETE FROM pipeline_checkpoints WHERE execution_id = ? AND stage = ?',
    ).run(executionId, failedStage);
  } catch (_) {}

  // Reset the execution row back to 'retrying' state
  db.prepare(
    `UPDATE pipeline_executions
     SET status = 'retrying',
         state = 'retrying',
         error_message = NULL,
         stack_trace = NULL,
         failed_stage = NULL,
         retry_count = retry_count + 1,
         finished_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(executionId);

  // Re-arm the in-memory flags
  pipelineState.STATES; // ensure enum loaded
  // Trick: directly set the in-memory maps since we are resuming an existing execution
  // (createExecution would refuse because pipelineId is no longer in ACTIVE_EXECUTIONS,
  //  so we re-add it manually here.)
  const internalState = pipelineState;
  // Use the public API: re-arm the abort/pause flags via transitionExecution
  try {
    internalState.transitionExecution(executionId, internalState.STATES.RUNNING);
  } catch (_) {}
  // ACTIVE_EXECUTIONS map is internal — we need a different approach: use runPipelineWithLifecycle
  // but pass the existing executionId via a private hook.

  // Re-load limits from the schedule
  let limits = parseJsonObject(row.limits_json);
  const keywords = Array.isArray(req.body?.keywords)
    ? req.body.keywords.map((k) => String(k).trim()).filter(Boolean)
    : [];

  // Mark the schedule as running again
  db.prepare(
    `UPDATE pipeline_schedules
     SET current_state = 'running',
         current_execution_id = ?,
         last_status = 'running',
         last_run_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(executionId, id);

  logActivity({
    activityType: 'pipeline_retry',
    entityType: 'pipeline',
    entityId: executionId,
    actor: 'manual',
    status: 'running',
    summary: `Retrying stage "${failedStage}" of pipeline ${id} (execution ${executionId})`,
    details: { stage: failedStage, executionId },
  });

  pipelineLogger.log({
    pipelineId: id,
    executionId,
    level: 'info',
    stage: 'retry',
    message: `Retrying stage "${failedStage}"`,
    context: { stage: failedStage },
    source: 'user',
  });

  res.json({
    ok: true,
    message: `Retrying stage "${failedStage}" of pipeline "${row.name}"`,
    execution_id: executionId,
    stage: failedStage,
  });

  // Actually run the pipeline with resumeFrom=failedStage, reusing the existing executionId.
  // We bypass runPipelineWithLifecycle's createExecution call by injecting the execution
  // directly into the runner.
  setImmediate(async () => {
    // Manually mark this pipeline as having an active execution so canStart() returns false
    // for any concurrent calls.
    // We do this by reusing the createExecution path with the same id — but createExecution
    // would refuse. Instead we set ACTIVE_EXECUTIONS via the public canStart workaround:
    // pretend the execution is new by transitioning it to RUNNING (already done above) and
    // then call the runner directly.
    try {
      const RUNNER = require('../jobs/pipelineScheduler').__getRunner(id);
      if (!RUNNER) throw new Error(`No runner for pipeline ${id}`);
      // Use a tiny shim that re-enters the active-execution map
      // (we rely on transitionExecution above having set status='running' on the row,
      //  and on the runner using executionId for state lookups).
      // To make pipelineState.getActiveExecution return this exec, we need to register it:
      // We expose that via a private call:
      if (typeof internalState.__setActive === 'function') {
        internalState.__setActive(id, executionId);
      }
      await RUNNER(limits, {
        trigger: 'retry',
        executionId,
        resumeFrom: failedStage,
        keywords,
      });
      try { pipelineState.markExecutionCompleted(executionId); } catch (_) {}
    } catch (err) {
      logger.error('PIPELINES-API', `Retry of stage "${failedStage}" failed`, err);
      try { pipelineState.markExecutionFailed(executionId, err, err.failedStage || failedStage); } catch (_) {}
      broadcastPipelineStatus(id, { status: 'failed', state: 'failed', error: err.message });
    }
  });
});

// ── POST /api/pipelines/:id/resume-from-checkpoint ── Resume from the last successful checkpoint
//
// Body: { executionId?: string, force?: boolean }
//
// If `force: true` is passed AND there's a stuck "running" execution in
// memory that doesn't appear to be making progress, we will force-clear it
// first (see forceClearExecution) and then resume. This fixes the previous
// "Another execution is already running" dead-end where the user could not
// recover from a stuck pipeline without restarting the server.
router.post('/:id/resume-from-checkpoint', async (req, res) => {
  const { id } = req.params;
  const db = getDb();
  const row = db.prepare('SELECT * FROM pipeline_schedules WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });

  let executionId = req.body?.executionId ? String(req.body.executionId) : null;
  const force = Boolean(req.body?.force);

  if (!executionId) {
    const recent = db
      .prepare(
        `SELECT id FROM pipeline_executions
         WHERE pipeline_id = ? AND status IN ('failed', 'stopped')
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(id);
    if (!recent) {
      return res.status(404).json({
        error: 'No failed/stopped execution found to resume.',
      });
    }
    executionId = recent.id;
  }

  const exec = db
    .prepare('SELECT * FROM pipeline_executions WHERE id = ?')
    .get(executionId);
  if (!exec) return res.status(404).json({ error: `Execution ${executionId} not found` });
  if (exec.pipeline_id !== id) {
    return res.status(400).json({ error: 'Execution does not belong to this pipeline' });
  }

  // Check for a stuck "active" execution that would block the resume.
  const activeExec = pipelineState.getActiveExecution(id);
  if (activeExec) {
    if (!force) {
      // Surface a helpful hint instead of just refusing — the user almost
      // always wants to clear the stuck state and proceed.
      return res.status(409).json({
        error: `Pipeline is already running (execution ${activeExec.id}). Re-send this request with { "force": true } in the body to clear the stuck state and resume, or use POST /api/pipelines/${id}/force-clear.`,
        hint: 'force_clear',
        active_execution_id: activeExec.id,
      });
    }
    // Force-clear the stuck execution, then proceed with the resume.
    pipelineState.forceClearExecution(id, `resume-from-checkpoint (forced by user)`);
  }

  const orderedStages = PIPELINE_STAGES[id] || [];
  const resumeStage = checkpointService.getResumeStage(executionId, orderedStages);
  if (!resumeStage) {
    return res.status(400).json({
      error: 'All stages already have completed checkpoints. Use "Run Now" to start a fresh run.',
    });
  }

  // Reset execution row
  db.prepare(
    `UPDATE pipeline_executions
     SET status = 'running',
         state = 'running',
         error_message = NULL,
         stack_trace = NULL,
         failed_stage = NULL,
         resumed_at = CURRENT_TIMESTAMP,
         finished_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(executionId);

  db.prepare(
    `UPDATE pipeline_schedules
     SET current_state = 'running',
         current_execution_id = ?,
         last_status = 'running',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(executionId, id);

  // Clear paused flag
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, 'false')
     ON CONFLICT(key) DO UPDATE SET value = 'false'`,
  ).run(`pipeline_${id}_paused`);

  const limits = parseJsonObject(row.limits_json);
  const keywords = Array.isArray(req.body?.keywords)
    ? req.body.keywords.map((k) => String(k).trim()).filter(Boolean)
    : [];

  pipelineLogger.log({
    pipelineId: id,
    executionId,
    level: 'info',
    stage: 'resume',
    message: `Resuming execution from stage "${resumeStage}"`,
    context: { resumeFrom: resumeStage },
    source: 'user',
  });

  res.json({
    ok: true,
    message: `Resuming pipeline "${row.name}" from stage "${resumeStage}"`,
    execution_id: executionId,
    resume_from: resumeStage,
  });

  setImmediate(async () => {
    try {
      const RUNNER = require('../jobs/pipelineScheduler').__getRunner(id);
      if (!RUNNER) throw new Error(`No runner for pipeline ${id}`);
      if (typeof pipelineState.__setActive === 'function') {
        pipelineState.__setActive(id, executionId);
      }
      await RUNNER(limits, {
        trigger: 'resume',
        executionId,
        resumeFrom: resumeStage,
        keywords,
      });
      try { pipelineState.markExecutionCompleted(executionId); } catch (_) {}
    } catch (err) {
      logger.error('PIPELINES-API', `Resume-from-checkpoint of ${id} failed`, err);
      try { pipelineState.markExecutionFailed(executionId, err, err.failedStage || null); } catch (_) {}
      broadcastPipelineStatus(id, { status: 'failed', state: 'failed', error: err.message });
    }
  });
});

function setPauseFlag(id, paused) {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(`pipeline_${id}_paused`, paused ? 'true' : 'false');
  logActivity({
    activityType: 'user_action',
    entityType: 'pipeline',
    entityId: id,
    actor: 'manual',
    status: paused ? 'paused' : 'resumed',
    summary: `Pipeline ${id} ${paused ? 'paused' : 'resumed'}`,
  });
}

router.post('/:id/pause', (req, res) => {
  const { id } = req.params;
  const row = getDb().prepare('SELECT id FROM pipeline_schedules WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });
  const result = pipelineState.requestPause(id);
  if (!result.ok) return res.status(400).json({ error: 'Cannot pause pipeline' });
  getDb().prepare(`UPDATE pipeline_schedules SET last_status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  broadcastPipelineStatus(id, { status: 'paused', state: 'paused' });
  res.json({ ok: true, paused: true, state: 'paused', ...result });
});

router.post('/:id/resume', (req, res) => {
  const { id } = req.params;
  const row = getDb().prepare('SELECT id FROM pipeline_schedules WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });
  const result = pipelineState.requestResume(id);
  if (!result.ok) return res.status(400).json({ error: 'Cannot resume pipeline' });
  getDb().prepare(`UPDATE pipeline_schedules SET last_status = COALESCE(NULLIF(last_status, 'paused'), 'idle'), updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  broadcastPipelineStatus(id, { status: 'resumed' });
  res.json({ ok: true, paused: false, state: 'resumed', ...result });
});

router.post('/:id/stop', (req, res) => {
  const { id } = req.params;
  const result = pipelineState.requestStop(id);
  const stopped = result.stopped || 0;
  if (stopped > 0) {
    getDb().prepare(`UPDATE pipeline_schedules SET last_status = 'stopped', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  }
  logActivity({
    activityType: 'user_action',
    entityType: 'pipeline',
    entityId: id,
    actor: 'manual',
    status: stopped > 0 ? 'success' : 'skipped',
    summary: `Stop requested for pipeline ${id}`,
    details: { stopped },
  });
  broadcastPipelineStatus(id, { status: stopped > 0 ? 'stopped' : 'idle', state: stopped > 0 ? 'stopped' : 'idle' });
  res.json({ ok: true, stopped, message: stopped > 0 ? 'Stop requested for active run.' : 'No active run to stop.' });
});

// ── POST /api/pipelines/:id/force-clear ── Force-clear a stuck execution
//
// Use this when a pipeline shows "Running" forever but no real progress is
// being made (the runner died without ever calling markExecutionFailed or
// markExecutionCompleted — e.g., an unhandled rejection inside a long
// browser automation step, an OOM kill, or a sync crash).
//
// This is the user-facing escape hatch that the previous "Retry Failed Step"
// and "Resume from Checkpoint" buttons needed but didn't have. It:
//   - Marks the active execution as 'failed' with a clear error_message.
//   - Clears the in-memory ACTIVE_EXECUTIONS / ABORT_FLAGS / PAUSE_FLAGS.
//   - Resets the schedule-level state to 'idle'.
//
// After this returns, the user can immediately Run / Retry / Resume.
router.post('/:id/force-clear', (req, res) => {
  const { id } = req.params;
  const reason = req.body?.reason ? String(req.body.reason) : 'manual';
  const row = getDb().prepare('SELECT id FROM pipeline_schedules WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });

  const result = pipelineState.forceClearExecution(id, reason);

  logActivity({
    activityType: 'user_action',
    entityType: 'pipeline',
    entityId: id,
    actor: 'manual',
    status: result.cleared > 0 ? 'success' : 'skipped',
    summary: `Force-clear requested for pipeline ${id} (cleared ${result.cleared} execution(s))`,
    details: {
      cleared: result.cleared,
      previousStatus: result.previousStatus || null,
      executionId: result.executionId || null,
      reason,
    },
  });

  broadcastPipelineStatus(id, {
    status: result.cleared > 0 ? 'failed' : 'idle',
    state: result.cleared > 0 ? 'failed' : 'idle',
    forced: result.cleared > 0,
  });

  res.json({
    ok: true,
    cleared: result.cleared || 0,
    execution_id: result.executionId || null,
    previous_status: result.previousStatus || null,
    message: result.cleared > 0
      ? `Cleared stuck execution ${result.executionId} (was ${result.previousStatus}). You can now Run / Retry / Resume.`
      : 'Pipeline state reset to idle.',
  });
});

// ── GET /api/pipelines/:id/executions ── List recent executions
router.get('/:id/executions', (req, res) => {
  const { id } = req.params;
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM pipeline_executions
       WHERE pipeline_id = ?
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(id, limit);

  const result = rows.map((row) => {
    let metadata = null;
    try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null; } catch (_) {}
    return {
      ...row,
      metadata,
    };
  });

  res.json({ executions: result });
});

// ── GET /api/pipelines/:id/executions/:eid ── Get a single execution detail
router.get('/:id/executions/:eid', (req, res) => {
  const { id, eid } = req.params;
  const db = getDb();
  const exec = db
    .prepare('SELECT * FROM pipeline_executions WHERE id = ? AND pipeline_id = ?')
    .get(String(eid), String(id));
  if (!exec) return res.status(404).json({ error: 'Execution not found' });

  let metadata = null;
  try { metadata = exec.metadata_json ? JSON.parse(exec.metadata_json) : null; } catch (_) {}

  const checkpoints = checkpointService.getCheckpoints(exec.id);
  const { logs } = pipelineLogger.query({
    executionId: exec.id,
    limit: Number(req.query.logLimit) || 200,
  });

  res.json({
    execution: { ...exec, metadata },
    checkpoints,
    logs,
  });
});

// ── GET /api/pipelines/:id/logs ── Searchable / filterable structured logs
router.get('/:id/logs', (req, res) => {
  const { id } = req.params;
  const filters = {
    pipelineId: id,
    level: req.query.level,
    levels: req.query.levels,
    stage: req.query.stage,
    search: req.query.search,
    since: req.query.since,
    until: req.query.until,
    source: req.query.source,
    browserEvent: req.query.browserEvent,
    executionId: req.query.executionId,
    limit: Number(req.query.limit) || 200,
    offset: Number(req.query.offset) || 0,
  };

  try {
    const result = pipelineLogger.query(filters);
    const counts = pipelineLogger.countByLevel({
      pipelineId: id,
      since: req.query.since,
      executionId: req.query.executionId,
    });
    res.json({ ...result, counts });
  } catch (err) {
    logger.error('PIPELINES-API', `Failed to query logs for ${id}`, err);
    res.status(500).json({ error: err.message, logs: [], total: 0, counts: {} });
  }
});

// ── GET /api/pipelines/:id/health ── Pipeline health snapshot
router.get('/:id/health', (req, res) => {
  try {
    const health = getHealth(req.params.id);
    if (!health) return res.status(404).json({ error: 'Pipeline not found' });
    res.json({ health });
  } catch (err) {
    logger.error('PIPELINES-API', `Failed to load health for ${req.params.id}`, err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/pipelines/:id/checkpoints ── List checkpoints
router.get('/:id/checkpoints', (req, res) => {
  const { id } = req.params;
  const executionId = req.query.executionId
    ? String(req.query.executionId)
    : pipelineState.getActiveExecution(id)?.id;

  if (!executionId) {
    return res.json({ checkpoints: [] });
  }
  const checkpoints = checkpointService.getCheckpoints(executionId);
  res.json({ checkpoints, execution_id: executionId });
});

// ── GET /api/pipelines/:id/history ── Legacy: recent pipeline runs (kept for compat)
router.get('/:id/history', (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const limit = Math.min(Number(req.query.limit) || 20, 100);

  if (id === 'outreach') {
    const runs = db.prepare(`
      SELECT id, trigger, mode, status, started_at, finished_at, stages_json
      FROM pipeline_runs
      ORDER BY started_at DESC
      LIMIT ?
    `).all(limit).map(run => {
      try { run.stages = JSON.parse(run.stages_json || '{}'); } catch (_) { run.stages = {}; }
      return run;
    });
    return res.json({ runs });
  }

  if (id === 'content') {
    const posts = db.prepare(`
      SELECT id, platforms, body, status, created_at, published_at, last_error
      FROM posts
      WHERE media_path LIKE '/uploads/auto-%'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
    return res.json({ runs: posts });
  }

  if (id === 'dm_check') {
    const rows = db.prepare(`
      SELECT job_id AS id,
             MIN(created_at) AS started_at,
             MAX(created_at) AS finished_at,
             MAX(CASE WHEN level = 'error' THEN message ELSE NULL END) AS last_error,
             CASE
               WHEN SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) > 0 THEN 'failed'
               ELSE 'completed'
             END AS status
      FROM pipeline_events
      WHERE job_type = 'dm_check' AND job_id IS NOT NULL
      GROUP BY job_id
      ORDER BY finished_at DESC
      LIMIT ?
    `).all(limit);
    return res.json({ runs: rows });
  }

  res.json({ runs: [] });
});

module.exports = router;
