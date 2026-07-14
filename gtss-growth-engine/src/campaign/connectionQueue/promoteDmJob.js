/**
 * Connection Queue — DM Job Promotion
 *
 * Promotes related DM jobs (status: pending → scheduled) once a
 * connection/follow action is verified, so the messaging pipeline can pick
 * them up on the next cron tick.
 *
 * For Instagram, X, and Facebook the promotion is immediate (within
 * policy.delays.actionMinSeconds) because a follow on those platforms is
 * instantaneous. For LinkedIn, the promotion uses the same min-delay window
 * unless `forceImmediate=true` is passed (which is what happens when the
 * connection outcome was "skipped" — i.e. already connected — meaning the
 * target is ready to receive a DM right away).
 *
 * Extracted from the original connectionQueue.js for maintainability.
 */

const {
  recordCampaignEvent,
  queueLog,
} = require("../utils/campaignUtils");

/**
 * Promotes related DM jobs for Instagram, X, and Facebook once
 * connection/follow is verified.
 *
 * @param {object} txDb - Transaction database context
 * @param {object} job - The successful connection job details
 * @param {object} policy - Target platform policy configuration
 * @param {boolean} [forceImmediate=false] - If true, forces immediate DM promotion bypassing platform default delay checks
 */
function promoteRelatedDmJob(txDb, job, policy, forceImmediate = false) {
  const normPlatform = String(job.platform).toLowerCase().trim();
  const isImmediate =
    ["x", "instagram", "facebook"].includes(normPlatform) || forceImmediate;

  if (isImmediate) {
    const minDelaySeconds = policy.delays?.actionMinSeconds || 30;
    const scheduledAt = new Date(
      Date.now() + minDelaySeconds * 1000,
    ).toISOString();

    const stmt = txDb.prepare(`
      UPDATE dm_jobs
      SET status = 'scheduled',
          scheduled_at = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE campaign_id = ? AND lead_id = ? AND status = 'pending'
    `);
    const res = stmt.run(scheduledAt, job.campaign_id, job.lead_id);

    if (res.changes > 0) {
      recordCampaignEvent(txDb, job.campaign_id, job.lead_id, "dm_promoted", {
        reason: `Connection/Follow succeeded or bypassed on ${job.platform}`,
        scheduled_at: scheduledAt,
      });
      queueLog(
        "info",
        "connection_queue",
        job.id,
        `Promoted related pending DM job for lead ${job.lead_id} (Scheduled at: ${scheduledAt}).`,
      );
    }
  }
}

module.exports = {
  promoteRelatedDmJob,
};
