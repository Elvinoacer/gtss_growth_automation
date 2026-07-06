/**
 * pipelineHealthService.js — Aggregates operational health metrics per pipeline.
 *
 * Reads from:
 *   - pipeline_schedules (last run, next run, current_state, run_count, etc.)
 *   - pipeline_executions (per-run status, duration, retry_count)
 *   - pipeline_logs (for retry/error counts in a window)
 *
 * Public API:
 *   getHealth(pipelineId)            - full health snapshot for one pipeline
 *   getHealthForAll()                - health for all pipelines
 *   recomputeAggregates(pipelineId)  - recompute stored aggregates (call after each run)
 */

const { getDb } = require("../db/database");

function safeDiv(num, den) {
  if (!den || den === 0) return 0;
  return num / den;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function durationMs(startedAt, finishedAt) {
  const start = parseDate(startedAt);
  const end = parseDate(finishedAt);
  if (!start || !end) return null;
  return Math.max(0, end.getTime() - start.getTime());
}

/**
 * Recompute and persist aggregate health columns on pipeline_schedules.
 *
 * Reads from pipeline_executions for this pipeline and updates:
 *   total_runs, total_failures, total_retries, consecutive_failures,
 *   avg_duration_ms, last_success_at, last_failure_at, last_error
 *
 * Call this after every execution finishes (success or failure).
 */
function recomputeAggregates(pipelineId) {
  if (!pipelineId) return null;
  const db = getDb();

  const stats = db
    .prepare(
      `SELECT
         COUNT(*) AS total_runs,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS total_failures,
         COALESCE(SUM(retry_count), 0) AS total_retries,
         AVG(CASE WHEN duration_ms IS NOT NULL AND status IN ('completed','failed','stopped') THEN duration_ms ELSE NULL END) AS avg_duration_ms
       FROM pipeline_executions
       WHERE pipeline_id = ?`,
    )
    .get(pipelineId);

  // Consecutive failures = walk back from most recent execution; count failures
  // until we hit a non-failure.
  const recent = db
    .prepare(
      `SELECT status FROM pipeline_executions
       WHERE pipeline_id = ?
       ORDER BY started_at DESC, id DESC
       LIMIT 50`,
    )
    .all(pipelineId);

  let consecutiveFailures = 0;
  for (const row of recent) {
    if (row.status === "failed") consecutiveFailures += 1;
    else break;
  }

  const lastSuccess = db
    .prepare(
      `SELECT finished_at, started_at FROM pipeline_executions
       WHERE pipeline_id = ? AND status = 'completed'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(pipelineId);

  const lastFailure = db
    .prepare(
      `SELECT finished_at, started_at, error_message FROM pipeline_executions
       WHERE pipeline_id = ? AND status = 'failed'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(pipelineId);

  const avgDuration = stats.avg_duration_ms
    ? Math.round(stats.avg_duration_ms)
    : null;

  db.prepare(
    `UPDATE pipeline_schedules
     SET total_runs = ?,
         total_failures = ?,
         total_retries = ?,
         consecutive_failures = ?,
         avg_duration_ms = ?,
         last_success_at = ?,
         last_failure_at = ?,
         last_error = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(
    stats.total_runs || 0,
    stats.total_failures || 0,
    stats.total_retries || 0,
    consecutiveFailures,
    avgDuration,
    lastSuccess?.finished_at || lastSuccess?.started_at || null,
    lastFailure?.finished_at || lastFailure?.started_at || null,
    lastFailure?.error_message || null,
    pipelineId,
  );

  return {
    pipeline_id: pipelineId,
    total_runs: stats.total_runs || 0,
    total_failures: stats.total_failures || 0,
    total_retries: stats.total_retries || 0,
    consecutive_failures: consecutiveFailures,
    avg_duration_ms: avgDuration,
    last_success_at: lastSuccess?.finished_at || lastSuccess?.started_at || null,
    last_failure_at: lastFailure?.finished_at || lastFailure?.started_at || null,
    last_error: lastFailure?.error_message || null,
  };
}

/**
 * Compute additional rolling-window metrics (last 24h) by reading pipeline_logs.
 * Cheap to call; meant for live UI display.
 */
function getRollingStats(pipelineId) {
  const db = getDb();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const logStats = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS errors,
         SUM(CASE WHEN level = 'retry' THEN 1 ELSE 0 END) AS retries,
         SUM(CASE WHEN level = 'success' THEN 1 ELSE 0 END) AS successes
       FROM pipeline_logs
       WHERE pipeline_id = ? AND created_at >= ?`,
    )
    .get(pipelineId, since);

  const execStats = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
         AVG(CASE WHEN duration_ms IS NOT NULL AND status IN ('completed','failed','stopped') THEN duration_ms ELSE NULL END) AS avg_duration
       FROM pipeline_executions
       WHERE pipeline_id = ? AND started_at >= ?`,
    )
    .get(pipelineId, since);

  const completed24h = execStats.completed || 0;
  const failed24h = execStats.failed || 0;
  const total24h = execStats.total || 0;
  const successRate = safeDiv(completed24h, total24h);
  const failureRate = safeDiv(failed24h, total24h);

  return {
    window: "24h",
    executions_total: total24h,
    executions_completed: completed24h,
    executions_failed: failed24h,
    executions_running: execStats.running || 0,
    success_rate: successRate,
    failure_rate: failureRate,
    avg_duration_ms: execStats.avg_duration ? Math.round(execStats.avg_duration) : null,
    logs_total: logStats.total || 0,
    logs_errors: logStats.errors || 0,
    logs_retries: logStats.retries || 0,
    logs_successes: logStats.successes || 0,
  };
}

/**
 * Compute the next scheduled run time (as stored in DB) and a short human
 * description for UI display.
 */
function getNextRun(pipelineId) {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT next_run_at, last_run_at, cron, enabled FROM pipeline_schedules WHERE id = ?",
    )
    .get(pipelineId);
  if (!row) return null;

  return {
    next_run_at: row.next_run_at || null,
    last_run_at: row.last_run_at || null,
    cron: row.cron,
    enabled: Boolean(row.enabled),
  };
}

/**
 * Build a full health snapshot for a single pipeline.
 */
function getHealth(pipelineId) {
  if (!pipelineId) return null;
  const db = getDb();

  // Recompute aggregates first so the persisted columns are accurate.
  try {
    recomputeAggregates(pipelineId);
  } catch (_) {}

  const row = db
    .prepare(
      `SELECT id, name, enabled, cron,
              current_state, current_execution_id,
              last_run_at, next_run_at, last_status, last_error,
              last_success_at, last_failure_at,
              run_count, total_runs, total_failures, total_retries,
              consecutive_failures, avg_duration_ms
       FROM pipeline_schedules
       WHERE id = ?`,
    )
    .get(pipelineId);

  if (!row) return null;

  const rolling = getRollingStats(pipelineId);

  // "uptime" = time since last_success_at, if any (otherwise null)
  const lastSuccessDate = parseDate(row.last_success_at);
  const uptimeMs = lastSuccessDate
    ? Date.now() - lastSuccessDate.getTime()
    : null;

  return {
    pipeline_id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    cron: row.cron,
    current_state: row.current_state || "idle",
    current_execution_id: row.current_execution_id || null,
    last_run_at: row.last_run_at,
    next_run_at: row.next_run_at,
    last_status: row.last_status,
    last_error: row.last_error,
    last_success_at: row.last_success_at,
    last_failure_at: row.last_failure_at,
    run_count: row.run_count || 0,
    total_runs: row.total_runs || 0,
    total_failures: row.total_failures || 0,
    total_retries: row.total_retries || 0,
    consecutive_failures: row.consecutive_failures || 0,
    avg_duration_ms: row.avg_duration_ms || null,
    uptime_ms: uptimeMs,
    success_rate_24h: rolling.success_rate,
    failure_rate_24h: rolling.failure_rate,
    executions_24h: rolling.executions_total,
    executions_completed_24h: rolling.executions_completed,
    executions_failed_24h: rolling.executions_failed,
    executions_running_24h: rolling.executions_running,
    avg_duration_ms_24h: rolling.avg_duration_ms,
    logs_24h: rolling.logs_total,
    log_errors_24h: rolling.logs_errors,
    log_retries_24h: rolling.logs_retries,
    log_successes_24h: rolling.logs_successes,
    healthy: isHealthy(row, rolling),
  };
}

function isHealthy(row, rolling) {
  // Healthy = enabled AND (no consecutive failures) AND (success rate over 50% in last 24h if any runs)
  if (!row.enabled) return true; // disabled pipelines are considered "healthy" (not failing)
  if ((row.consecutive_failures || 0) >= 3) return false;
  if (rolling.executions_total > 0 && rolling.success_rate < 0.5) return false;
  return true;
}

function getHealthForAll() {
  const db = getDb();
  const rows = db
    .prepare("SELECT id FROM pipeline_schedules ORDER BY id")
    .all();
  return rows.map((row) => getHealth(row.id)).filter(Boolean);
}

module.exports = {
  getHealth,
  getHealthForAll,
  recomputeAggregates,
  getRollingStats,
  getNextRun,
  isHealthy,
};
