/**
 * Executor — Action Outcome Classification + Recording
 *
 * Two responsibilities:
 *
 *   classifyOutcome(outcome, reason)
 *     Map an outcome string (sent / failed / premium_required / ...) to a
 *     fail_category for downstream UI + retry decisions.
 *
 *   recordOutcome(action, actionType, outcomeObj)
 *     Persist the outcome of a single action: writes a touchpoint row,
 *     increments daily action counts ONLY for successful sends (premium
 *     walls / failures do not burn the daily budget), and transitions the
 *     `messages` row to the correct next status (sent / skipped / blocked /
 *     snoozed for retry / blocked with max_retries_exceeded). Also queues
 *     the DM body as a follow-up for LinkedIn-connect / X-follow outcomes.
 *
 *   retryDelayMinutes(retryCount)
 *     Exponential-ish retry delay in minutes, capped at 1440 (24h).
 *
 * Extracted from the original automation/executor.js for maintainability.
 */

const {
  getDb,
  normalizeActionType,
  increment_action_count,
} = require('../../db/database');
const logger = require('../../utils/logger');
const { MAX_AUTO_RETRIES } = require('./state');

function classifyOutcome(outcome, reason) {
  if (outcome === 'sent') return null;
  if (outcome === 'premium_required') return 'premium_required';
  if (outcome === 'not_connected') return 'not_connected';
  if (outcome === 'session_required') return 'session_expired';
  if (outcome === 'limit_reached') return 'rate_limited';
  if (outcome === 'failed') {
    const r = String(reason || '');
    if (/captcha/i.test(r)) return 'captcha';
    // Permanent data / identity gates — not "we tried to send and failed".
    // Block the message so the queue does not re-snooze and retry forever.
    if (
      /relationship metadata|is metadata, not a person|identity guard|lead data is corrupt|pre-navigation identity|pre-flight content guard/i.test(
        r,
      )
    ) {
      return 'invalid_lead';
    }
    return 'send_failed';
  }
  if (
    outcome === 'already_connected' ||
    outcome === 'no_posts' ||
    outcome === 'skipped'
  ) {
    return null;
  }
  return 'unknown';
}

function retryDelayMinutes(retryCount) {
  return Math.min(Math.max(retryCount, 1) * 60, 1440);
}

function recordOutcome(action, actionType, outcomeObj) {
  const db = getDb();
  // Defensive: if a caller ever passes null/undefined (e.g. because
  // runAutomationAction returned undefined, or a future refactor forgets to
  // assign outcomeObj in some branch), fall back to a safe "failed" outcome
  // instead of throwing `TypeError: Cannot destructure property 'outcome' of
  // null` — which would escape recordOutcome and abort the run.
  if (!outcomeObj || typeof outcomeObj !== 'object') {
    logger.warn(
      'EXECUTOR',
      'recordOutcome called with invalid outcomeObj — falling back to \'failed\'',
      {
        messageId: action && action.message_id,
        actionType,
        receivedType: typeof outcomeObj,
      },
    );
    outcomeObj = {
      outcome: 'failed',
      reason: 'Internal: missing or invalid outcome object',
    };
  }
  const { outcome, reason } = outcomeObj;
  const normalizedActionType = normalizeActionType(actionType);
  const failCategory = classifyOutcome(outcome, reason);
  const retryCount = Number(action.retry_count || 0);

  const logLevel = outcome === 'sent' ? 'info' : 'warn';
  logger[logLevel]('EXECUTOR', 'Action outcome classified', {
    messageId: action.message_id,
    leadId: action.lead_id,
    platform: action.platform,
    actionType: normalizedActionType,
    outcome,
    failCategory,
    retryCount,
    reason: String(reason || '').slice(0, 200),
  });

  increment_action_count(
    action.platform,
    normalizedActionType,
    action.lead_id,
    outcome,
    reason || null,
  );

  db.prepare(
    `
    INSERT INTO touchpoints (lead_id, type, platform, message_id, outcome, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    action.lead_id,
    normalizedActionType,
    action.platform,
    action.message_id,
    outcome,
    reason || null,
  );

  if (outcome === 'sent') {
    db.prepare(
      `UPDATE messages
       SET status = 'sent',
           sent_at = CURRENT_TIMESTAMP,
           retry_count = 0,
           last_error = NULL,
           blocked_reason = NULL,
           fail_category = NULL,
           snooze_until = NULL
       WHERE id = ?`,
    ).run(action.message_id);

    // For LinkedIn connect and X follow actions, queue the DM body as a new pending message
    // so it fires once the connection or follow is complete (on the next queue run)
    if (
      normalizedActionType === 'connections' ||
      normalizedActionType === 'follows'
    ) {
      const originalMessage = db
        .prepare(`SELECT * FROM messages WHERE id = ?`)
        .get(action.message_id);
      if (originalMessage) {
        const existing = db
          .prepare(
            `
          SELECT id FROM messages
          WHERE lead_id = ? AND status IN ('pending','approved') AND is_follow_up = 0
          LIMIT 1
        `,
          )
          .get(action.lead_id);

        if (!existing) {
          // Add a 1-hour delay/snooze for X follows to prevent immediate bot-like direct messaging
          const snoozeDelay =
            action.platform === 'x' ? "datetime('now', '+1 hour')" : 'NULL';
          db.prepare(
            `
            INSERT INTO messages (lead_id, platform, body, variant, is_follow_up, status, snooze_until, generated_at)
            VALUES (?, ?, ?, 'A', 0, 'pending', ${snoozeDelay}, CURRENT_TIMESTAMP)
          `,
          ).run(action.lead_id, action.platform, originalMessage.body);
        }
      }
    }

    const lead = db
      .prepare(`SELECT status FROM leads WHERE id = ?`)
      .get(action.lead_id);
    if (
      lead &&
      ['discovered', 'qualified', 'deprioritized', 'scoring_failed'].includes(
        lead.status,
      )
    ) {
      db.prepare(
        `UPDATE leads SET status = 'messaged', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).run(action.lead_id);
    }
  } else if (outcome === 'already_connected' || outcome === 'no_posts') {
    db.prepare(
      `
      UPDATE messages
      SET status = 'skipped',
          last_error = ?,
          blocked_reason = NULL,
          fail_category = NULL,
          snooze_until = NULL
      WHERE id = ?
    `,
    ).run(reason || outcome, action.message_id);
  } else if (outcome === 'skipped') {
    db.prepare(
      `
      UPDATE messages
      SET status = 'approved',
          fail_category = NULL,
          blocked_reason = NULL,
          last_error = ?,
          snooze_until = datetime('now', '+1 hour')
      WHERE id = ?
    `,
    ).run(reason || 'Skipped', action.message_id);
  } else if (
    failCategory === 'premium_required' ||
    failCategory === 'captcha' ||
    failCategory === 'invalid_lead'
  ) {
    // Permanent block: premium walls, captcha, or corrupt lead data
    // (metadata names, identity mismatches). Do not re-queue.
    db.prepare(
      `
      UPDATE messages
      SET status = 'blocked',
          fail_category = ?,
          blocked_reason = ?,
          last_error = ?,
          snooze_until = NULL
      WHERE id = ?
    `,
    ).run(
      failCategory,
      failCategory,
      reason || failCategory,
      action.message_id,
    );
  } else if (failCategory === 'not_connected') {
    db.prepare(
      `
      UPDATE messages
      SET status = 'approved',
          fail_category = ?,
          blocked_reason = NULL,
          last_error = ?,
          snooze_until = datetime('now', '+24 hours')
      WHERE id = ?
    `,
    ).run(failCategory, reason || failCategory, action.message_id);
  } else if (failCategory === 'rate_limited') {
    db.prepare(
      `
      UPDATE messages
      SET status = 'approved',
          fail_category = ?,
          blocked_reason = NULL,
          last_error = ?,
          snooze_until = date('now', 'localtime', '+1 day')
      WHERE id = ?
    `,
    ).run(failCategory, reason || failCategory, action.message_id);
  } else {
    const nextRetryCount = retryCount + 1;
    if (nextRetryCount > MAX_AUTO_RETRIES) {
      db.prepare(
        `
        UPDATE messages
        SET status = 'blocked',
            retry_count = ?,
            fail_category = ?,
            blocked_reason = 'max_retries_exceeded',
            last_error = ?,
            snooze_until = NULL
        WHERE id = ?
      `,
      ).run(
        nextRetryCount,
        failCategory || 'unknown',
        reason || 'Publish failed',
        action.message_id,
      );
    } else {
      db.prepare(
        `
        UPDATE messages
        SET status = 'approved',
            retry_count = ?,
            fail_category = ?,
            blocked_reason = NULL,
            last_error = ?,
            snooze_until = datetime('now', '+' || ? || ' minutes')
        WHERE id = ?
      `,
      ).run(
        nextRetryCount,
        failCategory || 'unknown',
        reason || 'Publish failed',
        retryDelayMinutes(nextRetryCount),
        action.message_id,
      );
    }
  }
}

module.exports = {
  classifyOutcome,
  retryDelayMinutes,
  recordOutcome,
};
