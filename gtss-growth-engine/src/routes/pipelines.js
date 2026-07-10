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
  runExistingExecution,
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
const ALLOWED_MASS_FOLLOW_PLATFORMS = new Set(['instagram', 'linkedin', 'x', 'facebook', 'tiktok']);

const PIPELINE_STAGES = {
  outreach: ['discovery', 'qualification', 'messages', 'send'],
  content: ['image_gen', 'caption_gen', 'post_record', 'publish'],
  dm_check: ['scan'],
  mass_follow: ['select_targets', 'follow', 'report'],
  tiktok_mass_follow: ['search', 'follow', 'report'],
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

  // "Stuck" detection: the schedule-level state says the pipeline is
  // running/paused/resuming/etc. but there is no in-memory ACTIVE_EXECUTIONS
  // entry and no jobRegistry jobs. This means the runner died without
  // ever finalizing the execution — the UI should proactively show a
  // "Force Clear" hint so the user knows to click it.
  const transientStates = new Set(['running', 'paused', 'resuming', 'stopping', 'retrying']);
  const likelyStuck = !isRunning
    && transientStates.has(state)
    && !activeExec
    && activeJobs.length === 0;

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
    // Manual run is allowed even when the schedule is disabled — the
    // user explicitly clicked Run, so we honor it. Pause + active run
    // still block (the user should Stop or Resume first).
    can_run: !paused && !isRunning,
    // Pause is always available (even for disabled pipelines) so the
    // user can pause a long-running execution that started before the
    // schedule was disabled.
    can_pause: !paused,
    can_resume: Boolean(paused) || (isRunning && (activeExec?.status === 'paused')),
    can_stop: isRunning || likelyStuck,
    can_restart: true,
    can_force_clear: likelyStuck || isRunning,
    likely_stuck: likelyStuck,
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
    'max_follows_per_run',
    'follow_interval_min_seconds',
    'follow_interval_max_seconds',
    'max_retries_per_target',
    'max_scrolls',
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

  if (id === 'mass_follow') {
    if (next.platforms !== undefined) {
      if (!Array.isArray(next.platforms)) {
        throw new Error('platforms must be an array');
      }
      next.platforms = next.platforms
        .map((platform) => String(platform).trim().toLowerCase())
        .filter((platform) => ALLOWED_MASS_FOLLOW_PLATFORMS.has(platform));
      if (next.platforms.length === 0) {
        throw new Error('Select at least one mass-follow platform');
      }
    }
    // follow_interval_min_seconds must not exceed follow_interval_max_seconds
    if (
      next.follow_interval_min_seconds !== undefined &&
      next.follow_interval_max_seconds !== undefined &&
      Number(next.follow_interval_min_seconds) > Number(next.follow_interval_max_seconds)
    ) {
      throw new Error('follow_interval_min_seconds cannot exceed follow_interval_max_seconds');
    }
    for (const key of ['respect_active_window', 'skip_already_following']) {
      if (next[key] !== undefined) {
        next[key] = next[key] === true || next[key] === 'true' || next[key] === 1 || next[key] === '1';
      }
    }
  }

  if (id === 'tiktok_mass_follow') {
    // search_query is the TikTok user-search query (e.g. "restaurant owners").
    // It's required to run the pipeline but may be empty when the schedule
    // is first created — we only validate shape here, not presence.
    if (next.search_query !== undefined) {
      next.search_query = String(next.search_query).trim().slice(0, 200);
    }
    // follow_interval_min_seconds must not exceed follow_interval_max_seconds
    if (
      next.follow_interval_min_seconds !== undefined &&
      next.follow_interval_max_seconds !== undefined &&
      Number(next.follow_interval_min_seconds) > Number(next.follow_interval_max_seconds)
    ) {
      throw new Error('follow_interval_min_seconds cannot exceed follow_interval_max_seconds');
    }
    if (next.respect_active_window !== undefined) {
      next.respect_active_window = next.respect_active_window === true || next.respect_active_window === 'true' || next.respect_active_window === 1 || next.respect_active_window === '1';
    }
    // max_follows_per_run is the user-set follow limit per run. It's already
    // validated as a positive integer above; we just clamp it to a sane
    // ceiling (200) so a typo doesn't request 10,000 follows in one go.
    if (next.max_follows_per_run !== undefined) {
      next.max_follows_per_run = Math.min(200, Math.max(1, next.max_follows_per_run));
    }
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
    return res.status(409).json({
      error: 'Pipeline is paused. Click Resume first, or use Restart to override the pause.',
      hint: 'paused',
    });
  }

  // If there's an active execution that IS genuinely making progress,
  // refuse with a clear error — don't interrupt real work. If the
  // execution is stuck (no progress for >60s), auto-clear it and
  // proceed. The previous behavior always auto-cleared, which could
  // interrupt a runner that was just slow but actually working.
  const active = pipelineState.getActiveExecution(id);
  if (active) {
    if (pipelineState.isExecutionProgressing(id)) {
      return res.status(409).json({
        error: `Pipeline "${id}" is already running (execution ${active.id}). Wait for it to finish, or click Stop / Force Clear first.`,
        hint: 'already_running',
        active_execution_id: active.id,
      });
    }
    logger.warn('PIPELINES-API', `Run of "${id}": auto force-clearing stuck execution ${active.id} before run.`);
    pipelineState.forceClearExecution(id, `run (auto-cleared stale execution)`);
  }

  if (id === 'content' && (!limits.topic || !String(limits.topic).trim())) {
    return res.status(400).json({
      error: 'A content topic is required before running the Auto-Content Pipeline',
    });
  }

  if (id === 'tiktok_mass_follow' && (!limits.search_query || !String(limits.search_query).trim())) {
    return res.status(400).json({
      error: 'A TikTok search query is required before running the TikTok Mass-Follow Pipeline',
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

  // Restart is the user's "I want this pipeline to start over RIGHT NOW"
  // button. It always clears the pause flag and proceeds, even if the
  // pipeline was paused. (Previously, restart refused when paused,
  // forcing the user to click Resume first, then Restart — the exact
  // "buttons don't work" frustration they reported.)
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, 'false')
     ON CONFLICT(key) DO UPDATE SET value = 'false'`,
  ).run(`pipeline_${id}_paused`);

  // If there's an active execution, attempt a graceful stop first. If
  // the runner responds to the abort flag within the grace period, we
  // let it exit cleanly. If not (i.e., the runner is truly stuck), we
  // force-clear the execution so the new run can start.
  //
  // The grace period is 1.5s — long enough for a cooperative runner to
  // notice the abort flag between stages, short enough that the user
  // doesn't think restart is hung. For runners stuck INSIDE a long
  // browser operation, force-clear's jobRegistry.abort() provides the
  // real teeth.
  const active = pipelineState.getActiveExecution(id);
  if (active) {
    pipelineState.requestStop(id);
    // Brief grace period for the runner to notice the abort flag.
    await new Promise((r) => setTimeout(r, 1500));
    const stillActive = pipelineState.getActiveExecution(id);
    if (stillActive && stillActive.id === active.id) {
      logger.warn('PIPELINES-API', `Restart of "${id}": stuck execution ${active.id} did not respond to stop — force-clearing (also kills background jobs and clears pause flag).`);
      pipelineState.forceClearExecution(id, `restart (stuck execution did not respond to stop)`);
    }
    // Clear any checkpoints for the previous execution so the new run
    // starts fresh. (If the execution was force-cleared, this is a
    // no-op for unrelated executions.)
    try { checkpointService.clearCheckpoints(active.id); } catch (_) {}
  } else if (pipelineState.hasStuckDbRow(id)) {
    // Even without an in-memory active execution, the DB may have stale
    // "running" rows that would block createExecution. Sweep them now.
    pipelineState.forceClearExecution(id, `restart (preemptive sweep of stale DB rows)`);
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

  if (id === 'tiktok_mass_follow' && (!limits.search_query || !String(limits.search_query).trim())) {
    return res.status(400).json({
      error: 'A TikTok search query is required before restarting the TikTok Mass-Follow Pipeline',
    });
  }

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
// Body: { stage?: "discovery" | "send" | "publish" | ..., executionId?: "...", force?: boolean }
//
// Behavior:
//   - If no executionId is provided, uses the most recent FAILED execution
//     for this pipeline. Returns 404 if none exists.
//   - If no `stage` is provided AND the execution has no recorded
//     `failed_stage`, defaults to the FIRST stage of the pipeline (i.e.,
//     start over). This fixes the previous "specify stage in the body"
//     dead-end.
//   - If there's a stuck in-memory active execution, it is auto-cleared
//     before the retry proceeds (unless `force: false` is explicitly
//     passed in the body).
router.post('/:id/retry-stage', async (req, res) => {
  const { id } = req.params;
  const db = getDb();
  const row = db.prepare('SELECT * FROM pipeline_schedules WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });

  const stage = req.body?.stage ? String(req.body.stage) : null;
  let executionId = req.body?.executionId ? String(req.body.executionId) : null;

  if (!executionId) {
    // Find the most recent failed execution for this pipeline. We also
    // accept 'stopped' executions because the user may have stopped a
    // run mid-stage and want to retry from that stage.
    const recent = db
      .prepare(
        `SELECT id FROM pipeline_executions
         WHERE pipeline_id = ? AND status IN ('failed', 'stopped')
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(id);
    if (!recent) {
      return res.status(404).json({
        error: 'No failed or stopped execution found to retry. Run the pipeline first.',
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
  // Refuse if the execution is currently running / paused — the user
  // must Stop it first. (We don't auto-clear here because the execution
  // the user wants to retry is the SAME as the active one — clearing it
  // would defeat the purpose of the retry.)
  if (exec.status === 'running' || exec.status === 'paused' || exec.status === 'resuming' || exec.status === 'stopping') {
    return res.status(409).json({
      error: `Execution is currently ${exec.status}. Stop it first before retrying.`,
      hint: 'stop_first',
    });
  }

  // If there's a DIFFERENT in-memory active execution (i.e., the user
  // started a new run while the old failed one was still in the
  // history), auto-clear it before retrying. This is the fix for the
  // "buttons don't work" complaint: previously the user had to click
  // Force Clear first, then click Retry, which was frustrating.
  const activeExec = pipelineState.getActiveExecution(id);
  if (activeExec && activeExec.id !== executionId) {
    if (pipelineState.isExecutionProgressing(id)) {
      return res.status(409).json({
        error: `Another execution is currently running (${activeExec.id}). Stop it first, or use Force Clear.`,
        hint: 'another_running',
        active_execution_id: activeExec.id,
      });
    }
    logger.warn('PIPELINES-API', `Retry-stage for "${id}": auto force-clearing stuck execution ${activeExec.id} before retry.`);
    pipelineState.forceClearExecution(id, `retry-stage (auto-cleared stale execution)`);
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

  // Reset the execution row back to 'retrying' state. The runner will
  // transition it to 'running' once it starts (via runExistingExecution).
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

  // Make sure the schedule-level pause flag is cleared — retry implies
  // the user wants to make progress, not stay paused.
  try {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, 'false')
       ON CONFLICT(key) DO UPDATE SET value = 'false'`,
    ).run(`pipeline_${id}_paused`);
  } catch (_) {}

  // Reload limits from the schedule (merged with any body overrides).
  let limits = {
    ...parseJsonObject(row.limits_json),
    ...normalizeLimits(id, req.body?.limits || {}),
  };
  const keywords = Array.isArray(req.body?.keywords)
    ? req.body.keywords.map((k) => String(k).trim()).filter(Boolean)
    : [];

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

  // Run the existing execution with resumeFrom=failedStage. This uses
  // the public runExistingExecution helper (which handles __setActive
  // and the RUNNING transition internally) instead of the previous
  // private-API dance.
  setImmediate(async () => {
    try {
      await runExistingExecution(id, executionId, 'retry', limits, {
        resumeFrom: failedStage,
        keywords,
      });
      logger.info('PIPELINES-API', `Retry of stage "${failedStage}" for "${id}" completed (execution ${executionId})`);
    } catch (err) {
      logger.error('PIPELINES-API', `Retry of stage "${failedStage}" for "${id}" failed`, err);
      broadcastPipelineStatus(id, { status: 'failed', state: 'failed', error: err.message });
    }
  });
});

// ── POST /api/pipelines/:id/resume-from-checkpoint ── Resume from the last successful checkpoint
//
// Body: { executionId?: string, force?: boolean, limits?: {...}, keywords?: [...] }
//
// Behavior:
//   - If no executionId is provided, uses the most recent FAILED or
//     STOPPED execution. Returns 404 if none exists.
//   - If there's a stuck in-memory active execution that ISN'T making
//     progress, it is auto-cleared before resuming (so the user doesn't
//     need to click Force Clear first). If it IS progressing, we refuse
//     with a 409 and a clear error.
//   - If `force: true` is passed, we always clear the stuck execution
//     (this is the escape hatch the UI uses by default).
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
        error: 'No failed or stopped execution found to resume. Run the pipeline first.',
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
  // Refuse if the target execution is currently running / paused. The
  // user must Stop it first OR use the pause/resume buttons (which operate
  // on the active execution directly).
  if (['running', 'paused', 'resuming', 'stopping'].includes(exec.status)) {
    return res.status(409).json({
      error: `Execution is currently ${exec.status}. Stop it first, or use Pause / Resume to control the active run.`,
      hint: 'stop_first',
    });
  }

  // Check for a stuck in-memory active execution that would block the
  // resume. If it's the SAME as the target execution, we treat it as
  // already-running and refuse. If it's a DIFFERENT execution, we
  // auto-clear it (when stuck) or refuse (when progressing).
  const activeExec = pipelineState.getActiveExecution(id);
  if (activeExec) {
    if (activeExec.id === executionId) {
      return res.status(409).json({
        error: `Execution ${executionId} is already the active execution (status: ${activeExec.status}). Use Pause / Resume / Stop to control it.`,
        hint: 'already_active',
      });
    }
    if (!force && pipelineState.isExecutionProgressing(id)) {
      return res.status(409).json({
        error: `Another execution is currently running (${activeExec.id}) and making progress. Stop it first, or re-send with { "force": true } to clear it and resume.`,
        hint: 'another_running',
        active_execution_id: activeExec.id,
      });
    }
    pipelineState.forceClearExecution(id, `resume-from-checkpoint (cleared stale execution)`);
  }

  const orderedStages = PIPELINE_STAGES[id] || [];
  const resumeStage = checkpointService.getResumeStage(executionId, orderedStages);
  if (!resumeStage) {
    return res.status(400).json({
      error: 'All stages already have completed checkpoints. Use "Run Now" to start a fresh run instead.',
      hint: 'nothing_to_resume',
    });
  }

  // Reset execution row to 'retrying' (the runner will transition it to
  // 'running' via runExistingExecution). Don't set to 'running' here —
  // otherwise the UI shows running with no actual runner attached.
  db.prepare(
    `UPDATE pipeline_executions
     SET status = 'retrying',
         state = 'retrying',
         error_message = NULL,
         stack_trace = NULL,
         failed_stage = NULL,
         resumed_at = CURRENT_TIMESTAMP,
         finished_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(executionId);

  // Clear the schedule-level pause flag — resume implies the user wants
  // to make progress, not stay paused.
  try {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, 'false')
       ON CONFLICT(key) DO UPDATE SET value = 'false'`,
    ).run(`pipeline_${id}_paused`);
  } catch (_) {}

  const limits = {
    ...parseJsonObject(row.limits_json),
    ...normalizeLimits(id, req.body?.limits || {}),
  };
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
      await runExistingExecution(id, executionId, 'resume', limits, {
        resumeFrom: resumeStage,
        keywords,
      });
      logger.info('PIPELINES-API', `Resume-from-checkpoint of "${id}" completed (execution ${executionId})`);
    } catch (err) {
      logger.error('PIPELINES-API', `Resume-from-checkpoint of "${id}" failed`, err);
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
  if (!result.ok) {
    return res.status(400).json({
      error: result.error || 'Cannot pause pipeline',
      hint: 'pause_failed',
    });
  }
  getDb().prepare(`UPDATE pipeline_schedules SET last_status = 'paused', current_state = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  broadcastPipelineStatus(id, { status: 'paused', state: 'paused' });
  res.json({
    ok: true,
    paused: true,
    state: 'paused',
    scheduleLevel: result.scheduleLevel || false,
    executionId: result.executionId || null,
    message: result.scheduleLevel
      ? 'Pipeline paused at the schedule level. No active execution to pause.'
      : `Paused active execution ${result.executionId}. The runner will halt at the next stage boundary.`,
  });
});

router.post('/:id/resume', (req, res) => {
  const { id } = req.params;
  const row = getDb().prepare('SELECT id FROM pipeline_schedules WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });
  const result = pipelineState.requestResume(id);
  if (!result.ok) {
    return res.status(400).json({
      error: result.error || 'Cannot resume pipeline',
      hint: 'resume_failed',
    });
  }
  // Don't overwrite last_status with 'resumed' — that's not a real
  // pipeline state. Either keep the existing last_status (if the
  // schedule-level resume happened with no active execution) or let the
  // runner's transitionExecution handle it (when there IS an active
  // execution).
  if (result.scheduleLevel) {
    getDb().prepare(
      `UPDATE pipeline_schedules
       SET current_state = 'idle',
           last_status = CASE WHEN last_status = 'paused' THEN 'idle' ELSE last_status END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(id);
  }
  broadcastPipelineStatus(id, { status: 'resumed', state: result.scheduleLevel ? 'idle' : 'resuming' });
  res.json({
    ok: true,
    paused: false,
    state: result.scheduleLevel ? 'idle' : 'resuming',
    scheduleLevel: result.scheduleLevel || false,
    executionId: result.executionId || null,
    message: result.scheduleLevel
      ? 'Schedule-level pause cleared. The pipeline will run on its next cron tick, or you can click Run Now.'
      : `Resume requested for execution ${result.executionId}. The runner will continue at the next stage boundary.`,
  });
});

router.post('/:id/stop', (req, res) => {
  const { id } = req.params;
  const row = getDb().prepare('SELECT id FROM pipeline_schedules WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });

  // Capture pre-stop state so we can give a meaningful response message.
  const activeExec = pipelineState.getActiveExecution(id);

  const result = pipelineState.requestStop(id);
  const stopped = result.stopped || 0;

  // Also kill any registered jobRegistry jobs for this pipeline so that
  // any in-flight AbortController-listening browser operations actually
  // receive the abort signal. Previously, requestStop only set the abort
  // flag — which the runner checks cooperatively between stages — but a
  // runner stuck INSIDE a stage (e.g., waiting for a browser selector)
  // never re-checked the flag. Killing the job registry jobs gives the
  // abort real "teeth" for the first time.
  let jobsKilled = 0;
  try { jobsKilled = jobRegistry.stopJobsByPipeline(id); } catch (_) {}

  // Update the schedule-level state. If we actually stopped something,
  // mark it as 'stopped'. If there was nothing to stop, leave the state
  // alone (the user might have clicked Stop on an already-idle pipeline).
  if (stopped > 0) {
    getDb().prepare(
      `UPDATE pipeline_schedules
       SET last_status = 'stopped',
           current_state = 'idle',
           current_execution_id = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(id);
  }

  logActivity({
    activityType: 'user_action',
    entityType: 'pipeline',
    entityId: id,
    actor: 'manual',
    status: stopped > 0 ? 'success' : 'skipped',
    summary: `Stop requested for pipeline ${id}${jobsKilled > 0 ? ` (also killed ${jobsKilled} background job(s))` : ''}`,
    details: { stopped, jobsKilled, sweptDb: result.sweptDb || false, executionId: result.executionId || null },
  });
  broadcastPipelineStatus(id, {
    status: stopped > 0 ? 'stopped' : 'idle',
    state: stopped > 0 ? 'stopped' : 'idle',
    jobsKilled,
  });
  res.json({
    ok: true,
    stopped,
    jobsKilled,
    sweptDb: result.sweptDb || false,
    execution_id: result.executionId || null,
    message: stopped > 0
      ? (result.sweptDb
          ? `Stopped stuck execution ${result.executionId} (no live runner was found — cleared DB state).`
          : `Stop requested for active run${jobsKilled > 0 ? ` and ${jobsKilled} background job(s) killed` : ''}. The runner will halt at the next stage boundary.`)
      : 'No active run to stop. The pipeline is already idle.',
  });
});

// ── POST /api/pipelines/:id/force-clear ── Force-clear a stuck execution
//
// Use this when a pipeline shows "Running" forever but no real progress is
// being made (the runner died without ever calling markExecutionFailed or
// markExecutionCompleted — e.g., an unhandled rejection inside a long
// browser automation step, an OOM kill, or a sync crash).
//
// This is the user-facing escape hatch. It:
//   - Aborts the in-memory runner (sets ABORT_FLAG).
//   - Kills any registered jobRegistry jobs (sends AbortSignal to in-flight
//     browser operations).
//   - Marks ALL stuck DB rows as 'failed' with a clear error_message.
//   - Clears the in-memory ACTIVE_EXECUTIONS / ABORT_FLAGS / PAUSE_FLAGS.
//   - Resets the schedule-level state to 'idle'.
//   - Clears the schedule-level pause flag (so the user can immediately
//     re-Run) — unless the body contains `keep_pause_intent: true`.
//   - Releases the content pipeline DB lock if applicable.
//
// After this returns, the user can immediately Run / Retry / Resume.
router.post('/:id/force-clear', (req, res) => {
  const { id } = req.params;
  const reason = req.body?.reason ? String(req.body.reason) : 'manual';
  const keepPauseIntent = Boolean(req.body?.keep_pause_intent);
  const row = getDb().prepare('SELECT id FROM pipeline_schedules WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Pipeline not found' });

  // Capture pre-clear DB state for the response, so the UI can show the
  // user exactly what was cleared (and confirm the action was effective).
  const db = getDb();
  const preClearStuck = db
    .prepare(
      `SELECT id, status, started_at FROM pipeline_executions
       WHERE pipeline_id = ?
         AND status IN ('running', 'paused', 'resuming', 'stopping', 'retrying')
       ORDER BY started_at DESC`,
    )
    .all(id);

  const result = pipelineState.forceClearExecution(id, reason, { keepPauseIntent });

  logActivity({
    activityType: 'user_action',
    entityType: 'pipeline',
    entityId: id,
    actor: 'manual',
    status: result.cleared > 0 ? 'success' : 'skipped',
    summary: `Force-clear requested for pipeline ${id} (cleared ${result.cleared} execution(s), killed ${result.jobsKilled || 0} job(s))`,
    details: {
      cleared: result.cleared,
      previousStatus: result.previousStatus || null,
      executionId: result.executionId || null,
      jobsKilled: result.jobsKilled || 0,
      reason,
      keepPauseIntent,
      stuckRowsBefore: preClearStuck.map((r) => ({ id: r.id, status: r.status })),
    },
  });

  broadcastPipelineStatus(id, {
    status: result.cleared > 0 ? 'failed' : 'idle',
    state: result.cleared > 0 ? 'failed' : 'idle',
    forced: result.cleared > 0,
    jobsKilled: result.jobsKilled || 0,
  });

  res.json({
    ok: true,
    cleared: result.cleared || 0,
    execution_id: result.executionId || null,
    previous_status: result.previousStatus || null,
    jobs_killed: result.jobsKilled || 0,
    stuck_rows_before: preClearStuck.map((r) => ({ id: r.id, status: r.status })),
    pause_intent_preserved: keepPauseIntent,
    message: result.cleared > 0
      ? `Cleared ${result.cleared} stuck execution(s)${result.jobsKilled ? ` and killed ${result.jobsKilled} background job(s)` : ''}. Previous state: ${result.previousStatus}. You can now Run / Retry / Resume.`
      : `Pipeline state reset to idle (no stuck execution found in DB).${keepPauseIntent ? ' Pause intent preserved.' : ' Pause flag also cleared.'}`,
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

  if (id === 'mass_follow') {
    const rows = db.prepare(`
      SELECT id, trigger, status, current_stage, current_message, progress,
             total_steps, completed_steps, error_message, started_at, finished_at, duration_ms
      FROM pipeline_executions
      WHERE pipeline_id = 'mass_follow'
      ORDER BY started_at DESC
      LIMIT ?
    `).all(limit);
    return res.json({ runs: rows });
  }

  if (id === 'tiktok_mass_follow') {
    const rows = db.prepare(`
      SELECT id, trigger, status, current_stage, current_message, progress,
             total_steps, completed_steps, error_message, started_at, finished_at, duration_ms
      FROM pipeline_executions
      WHERE pipeline_id = 'tiktok_mass_follow'
      ORDER BY started_at DESC
      LIMIT ?
    `).all(limit);
    return res.json({ runs: rows });
  }

  res.json({ runs: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mass-Follow Pipeline — Target management endpoints
//
// The mass_follow pipeline operates on rows in `mass_follow_targets`. These
// endpoints let the user (or the wizard UI) add targets one-by-one or in
// bulk, list/filter them, retry failed ones, and remove them. The pipeline
// itself never modifies which targets exist — it only flips status — so
// these endpoints are the only way the table gets populated.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a (platform, profileUrl) pair for mass-follow. Rejects empty
 * URLs and unsupported platforms. Returns the normalized pair.
 */
function normalizeMassFollowTarget(platform, profileUrl, handle, source) {
  const normPlatform = String(platform || '').trim().toLowerCase();
  if (!ALLOWED_MASS_FOLLOW_PLATFORMS.has(normPlatform)) {
    throw new Error(`Unsupported mass-follow platform: ${platform}`);
  }
  const url = String(profileUrl || '').trim();
  if (!url) {
    throw new Error('profile_url is required');
  }
  // Basic URL sanity check — accept full URLs and bare handles (e.g. @acme).
  if (!/^https?:\/\//i.test(url) && !/^@?[\w.\-]+$/i.test(url)) {
    throw new Error(`Invalid profile_url: ${url}`);
  }
  return {
    platform: normPlatform,
    profile_url: url,
    handle: handle ? String(handle).trim().slice(0, 200) : null,
    source: source ? String(source).trim().slice(0, 50) : 'manual',
  };
}

// ── GET /api/pipelines/mass-follow/targets ── list with optional filters
router.get('/mass-follow/targets', (req, res) => {
  const db = getDb();
  const platform = req.query.platform ? String(req.query.platform).trim().toLowerCase() : null;
  const status = req.query.status ? String(req.query.status).trim().toLowerCase() : null;
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const where = [];
  const args = [];
  if (platform && ALLOWED_MASS_FOLLOW_PLATFORMS.has(platform)) {
    where.push('platform = ?');
    args.push(platform);
  }
  const validStatuses = new Set(['pending', 'running', 'sent', 'accepted', 'skipped', 'failed']);
  if (status && validStatuses.has(status)) {
    where.push('status = ?');
    args.push(status);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT id, platform, profile_url, handle, status, source, campaign_id, lead_id,
              error_message, retry_count, max_retries, next_retry_at, attempted_at, sent_at,
              created_at, updated_at
       FROM mass_follow_targets
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset);

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS count FROM mass_follow_targets ${whereClause}`)
    .get(...args);

  // Summary counts for the UI
  const summary = db
    .prepare(
      `SELECT platform, status, COUNT(*) AS count
       FROM mass_follow_targets
       ${whereClause ? whereClause + ' AND ' : 'WHERE '} 1=1
       GROUP BY platform, status`,
    )
    .all(...args);

  const summaryMap = {};
  for (const row of summary) {
    if (!summaryMap[row.platform]) summaryMap[row.platform] = {};
    summaryMap[row.platform][row.status] = row.count;
  }

  res.json({ targets: rows, total: totalRow ? totalRow.count : 0, summary: summaryMap });
});

// ── POST /api/pipelines/mass-follow/targets ── add one or many targets
//
// Body: { targets: [{ platform, profile_url, handle?, source? }, ...] }
//   OR  { platform, profile_url, handle?, source? }  (single-target shorthand)
//
// Idempotent on (platform, profile_url) — re-adding an existing target is a
// no-op (returns its existing id, not an error). Failed targets that are
// re-added are reset to 'pending' so the next run retries them.
router.post('/mass-follow/targets', (req, res) => {
  const db = getDb();
  let incoming;
  if (Array.isArray(req.body.targets)) {
    incoming = req.body.targets;
  } else if (req.body && req.body.platform && req.body.profile_url) {
    incoming = [req.body];
  } else {
    return res.status(400).json({ error: 'Provide a `targets` array or a single {platform, profile_url} object' });
  }

  const inserted = [];
  const updated = [];
  const errors = [];

  const insertStmt = db.prepare(
    `INSERT INTO mass_follow_targets (platform, profile_url, handle, source, status, max_retries)
     VALUES (?, ?, ?, ?, 'pending', 3)
     ON CONFLICT(platform, profile_url) DO UPDATE SET
       handle = COALESCE(excluded.handle, mass_follow_targets.handle),
       source = COALESCE(excluded.source, mass_follow_targets.source),
       status = CASE WHEN mass_follow_targets.status IN ('sent','accepted') THEN mass_follow_targets.status ELSE 'pending' END,
       error_message = NULL,
       retry_count = 0,
       next_retry_at = NULL,
       updated_at = CURRENT_TIMESTAMP
     RETURNING id, (changes() > 0) AS was_inserted`,
  );

  for (let i = 0; i < incoming.length; i++) {
    const item = incoming[i];
    try {
      const normalized = normalizeMassFollowTarget(
        item.platform,
        item.profile_url,
        item.handle,
        item.source,
      );
      const row = insertStmt.get(
        normalized.platform,
        normalized.profile_url,
        normalized.handle,
        normalized.source,
      );
      if (row && row.was_inserted) {
        inserted.push({ id: row.id, ...normalized });
      } else if (row) {
        updated.push({ id: row.id, ...normalized });
      }
    } catch (err) {
      errors.push({ index: i, input: item, error: err.message });
    }
  }

  logActivity({
    activityType: 'mass_follow_target_added',
    entityType: 'pipeline',
    entityId: 'mass_follow',
    actor: req.user?.id || 'system',
    status: errors.length === 0 ? 'success' : 'partial',
    summary: `Added ${inserted.length} new mass-follow target(s), updated ${updated.length}, ${errors.length} error(s)`,
    details: { inserted: inserted.length, updated: updated.length, errors: errors.length },
  });

  res.status(201).json({
    inserted: inserted.length,
    updated: updated.length,
    errors: errors.length,
    inserted_ids: inserted.map((t) => t.id),
    updated_ids: updated.map((t) => t.id),
    errors_detail: errors,
  });
});

// ── DELETE /api/pipelines/mass-follow/targets/:id ── remove a single target
router.delete('/mass-follow/targets/:id', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid target id' });
  }
  const result = db.prepare('DELETE FROM mass_follow_targets WHERE id = ?').run(id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Target not found' });
  }
  res.json({ deleted: true, id });
});

// ── POST /api/pipelines/mass-follow/targets/:id/retry ── reset a failed target back to pending
router.post('/mass-follow/targets/:id/retry', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid target id' });
  }
  const result = db
    .prepare(
      `UPDATE mass_follow_targets
       SET status = 'pending', retry_count = 0, next_retry_at = NULL,
           error_message = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'failed'`,
    )
    .run(id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Target not found or not in failed status' });
  }
  res.json({ retried: true, id });
});

// ── POST /api/pipelines/mass-follow/targets/clear ── bulk delete by filter
//
// Body: { platform?, status?, older_than_days? }
// Useful for clearing out a stale campaign before re-importing a fresh target list.
router.post('/mass-follow/targets/clear', (req, res) => {
  const db = getDb();
  const platform = req.body?.platform ? String(req.body.platform).trim().toLowerCase() : null;
  const status = req.body?.status ? String(req.body.status).trim().toLowerCase() : null;
  const olderThanDays = Number(req.body?.older_than_days) || 0;

  const where = [];
  const args = [];
  if (platform && ALLOWED_MASS_FOLLOW_PLATFORMS.has(platform)) {
    where.push('platform = ?');
    args.push(platform);
  }
  const validStatuses = new Set(['pending', 'running', 'sent', 'accepted', 'skipped', 'failed']);
  if (status && validStatuses.has(status)) {
    where.push('status = ?');
    args.push(status);
  }
  if (olderThanDays > 0) {
    where.push("datetime(created_at) < datetime('now', ?)");
    args.push(`-${olderThanDays} days`);
  }
  if (where.length === 0) {
    return res.status(400).json({ error: 'Provide at least one filter (platform, status, or older_than_days)' });
  }
  const result = db
    .prepare(`DELETE FROM mass_follow_targets WHERE ${where.join(' AND ')}`)
    .run(...args);
  res.json({ deleted: result.changes });
});

// ─────────────────────────────────────────────────────────────────────────────
// TikTok Mass-Follow Pipeline — search preview endpoint
//
// Lets the user preview what a TikTok user-search query would return
// BEFORE running the full pipeline. Launches a TikTok browser, navigates
// to /search/user?q=<query>, scrapes the visible user cards, and returns
// them as JSON. The browser is closed immediately after — no follows are
// performed. Useful for sanity-checking a query ("restaurant owners" →
// 24 cards) before committing a follow run.
//
// POST /api/pipelines/tiktok-mass-follow/preview-search
//   body: { query: string, max_scrolls?: number, max_cards?: number }
//   → { ok: true, query, cards: [{ username, displayName, profileUrl, followers, likes, followState }] }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/tiktok-mass-follow/preview-search', async (req, res) => {
  const query = String(req.body?.query || '').trim();
  if (!query) {
    return res.status(400).json({ error: 'query is required' });
  }
  const maxScrolls = Math.max(0, Math.min(10, Number(req.body?.max_scrolls) || 2));
  const maxCards = Math.max(1, Math.min(50, Number(req.body?.max_cards) || 20));

  const tiktokSearch = require('../automation/tiktokSearch');
  const browserBase = require('../automation/browserBase');

  let browserState = null;
  try {
    browserState = await browserBase.createBrowser('tiktok', {
      headless: process.env.ALLOW_HEADLESS_SOCIAL === 'true',
    });
    const page = browserState.page;
    const url = tiktokSearch.buildSearchUrl(query);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2500));

    const cards = await tiktokSearch.scrapeUserCards(page, { maxScrolls, maxCards });
    return res.json({
      ok: true,
      query,
      cardCount: cards.length,
      cards: cards.map((c) => ({
        username: c.username,
        displayName: c.displayName,
        profileUrl: c.profileUrl,
        followers: c.followers,
        likes: c.likes,
        followState: c.followState,
      })),
    });
  } catch (err) {
    logger.error('PIPELINES-API', `TikTok search preview failed: ${err.message}`, err);
    return res.status(500).json({ error: err.message });
  } finally {
    if (browserState) {
      try {
        await browserBase.closeBrowser(
          browserState.browser,
          'tiktok',
          browserState.context,
          {
            mode: browserState.mode,
            tracePath: browserState.tracePath,
            shouldCloseBrowser: browserState.shouldCloseBrowser,
            lock: browserState.lock,
          },
        );
      } catch (_) {}
    }
  }
});

module.exports = router;
