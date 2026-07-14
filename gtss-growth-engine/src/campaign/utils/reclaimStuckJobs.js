/**
 * reclaimStuckJobs.js — Reset campaign queue jobs stuck in `running`.
 *
 * Jobs are marked `running` when a worker picks them up. If the worker is
 * stopped, crashes mid-action, or fails to persist an outcome, the row can
 * stay `running` forever (eligible queries only select pending/failed/
 * scheduled). That makes the campaign look "stuck" and prevents end-to-end
 * progress.
 *
 * Safe to call:
 *   - at the start of each queue run (orphans from a previous interrupted run)
 *   - when the user clicks Stop on the campaign page
 *   - when a campaign is paused (per-campaign reclaim)
 *
 * The single-writer mutex (campaign_queue_lock) guarantees at most one
 * connection/DM queue runner is active, so any `running` row at reclaim
 * time is orphaned (or is the current job being force-stopped).
 */

"use strict";

/**
 * Reclaim connection_jobs and/or dm_jobs stuck in `running`.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {object} [opts]
 * @param {number|null} [opts.campaignId] - If set, only reclaim jobs for this campaign
 * @param {string} [opts.reason] - Stored in error_message for observability
 * @returns {{ connectionJobs: number, dmJobs: number }}
 */
function reclaimStuckRunningJobs(db, opts = {}) {
  if (!db) throw new Error("Database context is required to reclaim stuck jobs.");

  const campaignId = opts.campaignId != null ? Number(opts.campaignId) : null;
  const reason =
    opts.reason ||
    "Reclaimed from stuck running state (stop / pause / queue restart)";

  let connectionJobs = 0;
  let dmJobs = 0;

  if (campaignId != null && Number.isFinite(campaignId)) {
    connectionJobs = db
      .prepare(
        `
        UPDATE connection_jobs
        SET status = 'pending',
            error_message = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE status = 'running' AND campaign_id = ?
      `,
      )
      .run(reason, campaignId).changes;

    dmJobs = db
      .prepare(
        `
        UPDATE dm_jobs
        SET status = 'pending',
            error_message = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE status = 'running' AND campaign_id = ?
      `,
      )
      .run(reason, campaignId).changes;
  } else {
    connectionJobs = db
      .prepare(
        `
        UPDATE connection_jobs
        SET status = 'pending',
            error_message = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE status = 'running'
      `,
      )
      .run(reason).changes;

    dmJobs = db
      .prepare(
        `
        UPDATE dm_jobs
        SET status = 'pending',
            error_message = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE status = 'running'
      `,
      )
      .run(reason).changes;
  }

  return { connectionJobs, dmJobs };
}

/**
 * If a single job is still `running` after outcome handling, reset it to
 * pending so it is not permanently stuck. Used as a per-iteration safety net.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {"connection"|"dm"} kind
 * @param {number} jobId
 * @param {string} [reason]
 * @returns {boolean} true if the job was reclaimed
 */
function reclaimJobIfStillRunning(db, kind, jobId, reason) {
  if (!db || !jobId) return false;
  const table = kind === "dm" ? "dm_jobs" : "connection_jobs";
  const msg =
    reason ||
    "Outcome handler did not finalize status; reclaimed to pending";
  const result = db
    .prepare(
      `
      UPDATE ${table}
      SET status = 'pending',
          error_message = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running'
    `,
    )
    .run(msg, jobId);
  return result.changes > 0;
}

module.exports = {
  reclaimStuckRunningJobs,
  reclaimJobIfStillRunning,
};
