/**
 * Executor — Queued-Actions Query
 *
 * getQueuedActions(options) returns the current action queue from the
 * `messages` table joined with `leads`, filtered by platform / action type.
 * Exactly one approved message is selected for each lead/platform/follow-up
 * group. This is important because a template fallback can have been approved
 * before a later Gemini or founder-approved replacement was created.
 * Used by processActionQueue to decide what to run, and by callers
 * (automation routes, sendPipeline) to preview the queue.
 *
 * Extracted from the original automation/executor.js for maintainability.
 */

const { getDb, normalizeActionType } = require('../../db/database');
const {
  normalizeQueuedActionType,
  determineActionType,
} = require('./actionTypes');
const {
  sendableApprovedMessageClause,
  approvedMessagePrioritySql,
} = require('../../services/messageSelectionService');

function getQueuedActions(options = {}) {
  const db = getDb();
  const includeBlocked = options.includeBlocked === true;
  const includeWaiting = options.includeWaiting === true;
  const platforms = Array.isArray(options.platforms)
    ? options.platforms
        .map((platform) => String(platform).trim().toLowerCase())
        .filter(Boolean)
    : [];
  const actionTypes = Array.isArray(options.actionTypes)
    ? options.actionTypes
        .map((actionType) => normalizeQueuedActionType(actionType))
        .filter(Boolean)
    : [];
  const platformClause =
    platforms.length > 0
      ? `AND m.platform IN (${platforms.map(() => '?').join(',')})`
      : '';
  return db
    .prepare(
      `
    WITH ranked_messages AS (
      SELECT
        m.*,
        ROW_NUMBER() OVER (
          PARTITION BY m.lead_id, m.platform, COALESCE(m.is_follow_up, 0)
          ORDER BY
            -- A message explicitly approved in the Messages page is the
            -- operator's choice. Gemini output is next; generic/template
            -- fallbacks can only be used when no better approved row exists.
            ${approvedMessagePrioritySql('m')}
        ) AS selected_rank
      FROM messages m
      WHERE (
        (m.status = 'approved' AND ${sendableApprovedMessageClause('m')})
        ${includeBlocked ? "OR m.status = 'blocked'" : ""}
      )
    )
    SELECT m.id AS message_id, m.platform, m.body, m.variant, m.is_follow_up, m.lead_id,
           m.status, m.snooze_until, m.retry_count, m.last_error, m.blocked_reason, m.fail_category, m.action_type,
           m.generated_by, m.approved_by,
           CASE
             WHEN m.status = 'approved' AND (m.snooze_until IS NULL OR m.snooze_until <= datetime('now')) THEN 1
             ELSE 0
           END AS runnable,
           l.name AS lead_name, l.profile_url, l.status AS lead_status
    FROM ranked_messages m
    JOIN leads l ON m.lead_id = l.id
    WHERE m.selected_rank = 1
      AND (
        (m.status = 'approved' ${includeWaiting ? "" : "AND (m.snooze_until IS NULL OR m.snooze_until <= datetime('now'))"})
        ${includeBlocked ? "OR m.status = 'blocked'" : ""}
      )
    -- Relationship metadata is never an outreach recipient. This also
    -- protects active queues before the server-start data cleanup runs.
    AND LOWER(COALESCE(l.name, '')) NOT LIKE '%mutual%'
    ${platformClause}
    ORDER BY
      CASE
        WHEN m.status = 'approved' AND (m.snooze_until IS NULL OR m.snooze_until <= datetime('now')) THEN 0
        WHEN m.status = 'approved' THEN 1
        WHEN m.status = 'blocked' THEN 2
        ELSE 3
      END,
      m.approved_at ASC
  `,
    )
    .all(...platforms)
    .map((action) => ({
      ...action,
      action_type:
        normalizeQueuedActionType(action.action_type) ||
        determineActionType(action),
      runnable: Boolean(action.runnable),
    }))
    .filter(
      (action) =>
        actionTypes.length === 0 || actionTypes.includes(action.action_type),
    );
}

module.exports = { getQueuedActions };
