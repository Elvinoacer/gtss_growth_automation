const { getDb } = require('../db/database');
const logger = require('../utils/logger');

function stringifyDetails(details) {
  if (!details || Object.keys(details).length === 0) return null;
  try {
    return JSON.stringify(details);
  } catch (_) {
    return JSON.stringify({ serialization_error: true });
  }
}

function startJob(jobId, details = {}) {
  getDb().prepare(`
    INSERT INTO automation_jobs (id, status, started_at, details_json)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      started_at = COALESCE(automation_jobs.started_at, CURRENT_TIMESTAMP),
      completed_at = NULL,
      details_json = excluded.details_json
  `).run(jobId, 'PENDING', stringifyDetails(details));
}

function updateJobStatus(jobId, status, details = {}) {
  const completedStates = new Set([
    'COMPLETED',
    'FAILED',
    'SOFT_BLOCKED',
    'CAPTCHA_REQUIRED',
    'RATE_LIMITED',
    'MANUAL_INTERVENTION_REQUIRED'
  ]);
  const completedSql = completedStates.has(status) ? 'CURRENT_TIMESTAMP' : 'completed_at';

  getDb().prepare(`
    INSERT INTO automation_jobs (id, status, started_at, completed_at, details_json)
    VALUES (?, ?, CURRENT_TIMESTAMP, ${completedStates.has(status) ? 'CURRENT_TIMESTAMP' : 'NULL'}, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      completed_at = ${completedSql},
      details_json = excluded.details_json
  `).run(jobId, status, stringifyDetails(details));
}

function recordEvent(event) {
  try {
    getDb().prepare(`
      INSERT INTO automation_events (
        job_id, platform, account, action_type, target, message_id, lead_id,
        status, warning_detected, details_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.jobId || null,
      event.platform || null,
      event.account || null,
      event.actionType || null,
      event.target || null,
      event.messageId || null,
      event.leadId || null,
      event.status,
      event.warningDetected ? 1 : 0,
      stringifyDetails(event.details || {})
    );
  } catch (error) {
    logger.warn('JOURNAL', 'Failed to record automation event', { error: error.message, status: event.status });
  }
}

module.exports = {
  startJob,
  updateJobStatus,
  recordEvent
};
