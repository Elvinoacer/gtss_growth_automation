/**
 * massFollowPipeline/recordOutcome.js
 *
 * Stage-2 helper: persist the outcome of a single follow attempt.
 *
 * Updates the target row's status (sent / skipped / failed / pending) and:
 *   - On 'failed' under the retry cap: schedules exponential backoff
 *     (next_retry_at = now + 2^retryCount minutes) and returns the new status
 *     (which is 'pending' so the next run picks it up).
 *   - On 'session_required' or 'blocked': transitions are made but no
 *     daily_actions row is recorded (those don't count against the cap).
 *   - On 'sent' or 'skipped': inserts a daily_actions row (rate-limit counting)
 *     and a touchpoint row if the target has a lead_id. Mirrors
 *     connectionQueue.js — failed attempts don't count against the daily cap.
 *
 * Returns the final status string so the runner can update its summary map.
 */

function recordOutcome(db, target, platform, result) {
  const now = new Date().toISOString();
  const outcome = result.outcome || "failed";
  const errorMessage = result.error || null;

  // 1. Update the target row
  let nextStatus;
  if (outcome === "sent") {
    nextStatus = "sent";
  } else if (outcome === "skipped") {
    nextStatus = "skipped";
  } else if (outcome === "blocked") {
    // Permanent block (suspended / restricted account) — don't retry.
    nextStatus = "failed";
  } else if (outcome === "session_required") {
    // Transient (session expired) — keep pending so the next run retries
    // once the user re-authenticates.
    nextStatus = "pending";
  } else {
    // 'failed' — increment retry_count, schedule backoff if under cap.
    const newRetry = (target.retry_count || 0) + 1;
    const cap = target.max_retries || 3;
    if (newRetry >= cap) {
      nextStatus = "failed";
    } else {
      nextStatus = "pending";
      // Exponential backoff: 2^retry minutes (2, 4, 8, 16…)
      const backoffMs = Math.pow(2, newRetry) * 60 * 1000;
      const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
      db.prepare(
        `UPDATE mass_follow_targets
         SET status = ?, retry_count = ?, next_retry_at = ?,
             attempted_at = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      ).run(nextStatus, newRetry, nextRetryAt, now, errorMessage, target.id);
      return nextStatus;
    }
  }

  db.prepare(
    `UPDATE mass_follow_targets
     SET status = ?, attempted_at = ?,
         sent_at = ?,
         error_message = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(
    nextStatus,
    now,
    outcome === "sent" ? now : null,
    errorMessage,
    target.id,
  );

  // 2. Record a daily_actions row for rate-limit counting (only on sent /
  //    skipped — failed attempts don't count against the daily cap, mirroring
  //    connectionQueue.js behavior).
  if (outcome === "sent" || outcome === "skipped") {
    const actionType = platform === "linkedin" || platform === "facebook"
      ? "connections"
      : "follows";
    db.prepare(
      `INSERT INTO daily_actions (platform, action_type, lead_id, outcome, reason, performed_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    ).run(
      platform,
      actionType,
      target.lead_id || null,
      outcome === "sent" ? "sent" : "skipped",
      errorMessage,
    );
  }

  // 3. Record a touchpoint (mirrors connectionQueue.js pattern)
  if (target.lead_id) {
    db.prepare(
      `INSERT INTO touchpoints (lead_id, type, platform, outcome, sent_at, notes)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
    ).run(
      target.lead_id,
      platform === "linkedin" || platform === "facebook" ? "connection" : "follow",
      platform,
      outcome,
      errorMessage ? String(errorMessage).slice(0, 200) : null,
    );
  }

  return nextStatus;
}

module.exports = { recordOutcome };
