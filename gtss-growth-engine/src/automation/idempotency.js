const crypto = require('crypto');
const { getDb, normalizeActionType } = require('../db/database');

function getTtlHours() {
  return Number(process.env.ACTION_IDEMPOTENCY_TTL_HOURS || 24 * 7);
}

function normalizeTarget(action) {
  return String(action.profile_url || action.lead_id || action.message_id || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/\/$/, '');
}

function createActionFingerprint(action, actionType) {
  const normalizedActionType = normalizeActionType(actionType);
  const target = normalizeTarget(action);
  const seed = `${action.platform}:${normalizedActionType}:${target}`;
  return crypto.createHash('sha256').update(seed).digest('hex');
}

function pruneExpiredFingerprints() {
  getDb().prepare(`DELETE FROM action_fingerprints WHERE expires_at <= datetime('now')`).run();
}

function reserveAction(action, actionType) {
  pruneExpiredFingerprints();
  const normalizedActionType = normalizeActionType(actionType);
  const target = normalizeTarget(action);
  const fingerprint = createActionFingerprint(action, normalizedActionType);
  const ttlHours = getTtlHours();

  const existing = getDb().prepare(`
    SELECT fingerprint, expires_at
    FROM action_fingerprints
    WHERE fingerprint = ? AND expires_at > datetime('now')
  `).get(fingerprint);

  if (existing) {
    return {
      reserved: false,
      fingerprint,
      reason: `Duplicate action reserved until ${existing.expires_at}`
    };
  }

  getDb().prepare(`
    INSERT INTO action_fingerprints (
      fingerprint, platform, action_type, target, message_id, lead_id, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))
  `).run(
    fingerprint,
    action.platform,
    normalizedActionType,
    target,
    action.message_id || null,
    action.lead_id || null,
    `+${ttlHours} hours`
  );

  return { reserved: true, fingerprint };
}

function releaseActionFingerprint(fingerprint) {
  if (!fingerprint) return;
  getDb().prepare(`DELETE FROM action_fingerprints WHERE fingerprint = ?`).run(fingerprint);
}

module.exports = {
  createActionFingerprint,
  reserveAction,
  releaseActionFingerprint,
  pruneExpiredFingerprints
};
