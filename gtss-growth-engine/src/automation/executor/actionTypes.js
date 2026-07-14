/**
 * Executor — Action-Type Helpers + Per-Platform Outreach Mode
 *
 * Pure helpers for classifying a queued message into one of the supported
 * action types and for resolving the per-platform outreach mode
 * (connect_first vs dm_first etc.).
 *
 *   - normalizeQueuedActionType(actionType) : map variant spellings to canonical names
 *   - determineActionType(message)          : infer the action type for a queued message
 *   - getLinkedInOutreachMode()             : "connect_first" | "dm_first" | "dm_only"
 *   - getXOutreachMode()                    : "follow_first" | "dm_first" | "dm_only"
 *   - getSettingValue(key)                  : read a row from the `settings` table
 *   - isTruthyConfig(value)                 : "1"/"true"/"yes"/"on" → true
 *
 * Extracted from the original automation/executor.js for maintainability.
 */

const { getDb } = require('../../db/database');

function getSettingValue(key) {
  return getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key)
    ?.value;
}

function isTruthyConfig(value) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(value || '')
      .trim()
      .toLowerCase(),
  );
}

function getLinkedInOutreachMode() {
  const configured =
    process.env.LINKEDIN_OUTREACH_MODE ||
    (isTruthyConfig(process.env.LINKEDIN_DIRECT_DM_FIRST)
      ? 'dm_first'
      : null) ||
    getSettingValue('linkedin_outreach_mode');

  if (configured === 'dm_only' || configured === 'dm_first') return configured;
  return 'connect_first';
}

function getXOutreachMode() {
  const configured =
    process.env.X_OUTREACH_MODE || getSettingValue('x_outreach_mode');

  if (configured === 'dm_only' || configured === 'dm_first') return configured;
  return 'follow_first';
}

function normalizeQueuedActionType(actionType) {
  const normalized = String(actionType || '')
    .trim()
    .toLowerCase();

  if (['connect', 'connection', 'connections'].includes(normalized)) {
    return 'connect';
  }
  if (['dm', 'dms', 'direct_message', 'message'].includes(normalized)) {
    return 'dm';
  }
  if (['follow', 'follows'].includes(normalized)) return 'follow';
  if (normalized === 'instagram_dm') return 'instagram_dm';
  if (normalized === 'instagram_follow') return 'instagram_follow';
  if (normalized === 'instagram_like') return 'instagram_like';
  if (normalized === 'instagram_story_view') return 'instagram_story_view';
  if (normalized === 'instagram_warmup_advance') {
    return 'instagram_warmup_advance';
  }

  return '';
}

function determineActionType(message) {
  const explicitActionType = normalizeQueuedActionType(message.action_type);
  if (explicitActionType) return explicitActionType;

  if (message.is_follow_up) return 'dm';

  if (message.platform === 'linkedin') {
    return 'dm';
  }

  if (message.platform === 'x') {
    const outreachMode = getXOutreachMode();
    if (outreachMode === 'dm_only' || outreachMode === 'dm_first') return 'dm';

    // Check if a follow was already sent to this lead
    const db = getDb();
    const priorFollow = db
      .prepare(
        `
      SELECT id FROM touchpoints
      WHERE lead_id = ? AND type = 'follows' AND outcome = 'sent'
      LIMIT 1
    `,
      )
      .get(message.lead_id);

    return priorFollow ? 'dm' : 'follow';
  }

  return 'dm';
}

module.exports = {
  normalizeQueuedActionType,
  determineActionType,
  getLinkedInOutreachMode,
  getXOutreachMode,
  getSettingValue,
  isTruthyConfig,
};
