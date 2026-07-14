/**
 * Pipelines Routes — Shared Helpers
 *
 * Constants and helper functions shared across all pipelines route handlers:
 *   - Platform allow-lists and pipeline-stage map
 *   - parseJsonObject / parseBoolean (request body coercion)
 *   - getPipelineActiveJobs (joins jobRegistry + pipelineState)
 *   - buildRuntimeState (the per-pipeline runtime status object the UI consumes)
 *   - broadcastPipelineStatus (pushes a status update over Socket.IO)
 *
 * Extracted from the original routes/pipelines.js for maintainability.
 */

const { getDb } = require('../../db/database');
const { isPipelinePaused } = require('../../jobs/pipelineScheduler');
const jobRegistry = require('../../jobs/jobRegistry');
const pipelineState = require('../../services/pipelineStateService');

const ALLOWED_CONTENT_PLATFORMS = new Set(['instagram', 'linkedin', 'x', 'facebook']);
const ALLOWED_OUTREACH_PLATFORMS = new Set(['instagram', 'linkedin', 'x', 'facebook']);
const ALLOWED_MASS_FOLLOW_PLATFORMS = new Set(['instagram', 'linkedin', 'x', 'facebook']);

const PIPELINE_STAGES = {
  outreach: ['discovery', 'qualification', 'messages', 'send'],
  content: ['image_gen', 'caption_gen', 'post_record', 'publish'],
  dm_check: ['scan'],
  mass_follow: ['select_targets', 'follow', 'report'],
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
    const { broadcast } = require('../../services/socketService');
    broadcast('pipeline:status', {
      id,
      status: row.last_status || 'idle',
      last_run_at: row.last_run_at,
      ...buildRuntimeState(row, paused),
      ...overrides,
    });
  } catch (_) {}
}

module.exports = {
  ALLOWED_CONTENT_PLATFORMS,
  ALLOWED_OUTREACH_PLATFORMS,
  ALLOWED_MASS_FOLLOW_PLATFORMS,
  PIPELINE_STAGES,
  parseJsonObject,
  parseBoolean,
  getPipelineActiveJobs,
  buildRuntimeState,
  broadcastPipelineStatus,
};
