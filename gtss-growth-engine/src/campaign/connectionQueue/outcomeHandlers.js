/**
 * Connection Queue — Outcome Mapping & Persistence
 *
 * Handles Phase 6 of processConnectionQueue: takes the result struct
 * returned by platformAdapter.runConnectionAction and persists the
 * appropriate state changes to the database, depending on which outcome
 * branch fired:
 *
 *   - "sent"             → mark connection_jobs 'sent', insert daily_actions row,
 *                          record connection_sent event, promote related DM job
 *   - "skipped"          → mark connection_jobs 'accepted' (already connected
 *                          at send time — NOT "they accepted our invite"),
 *                          record connection_skipped event, force-promote DM
 *   - "session_required" → postpone job to next business-hour window, add platform
 *                          to expiredPlatforms Set (skip rest of batch for this
 *                          platform), record session_expired event, email notify
 *   - "blocked"          → mark 'failed' + snooze to next window, record
 *                          captcha_detected event
 *   - else (failure)     → if retry_count+1 >= maxRetries: terminal failure (cascade
 *                          to pending DM jobs as failed); else retryable failure
 *                          with progressive backoff
 *
 * Mutates `report` (counter bumps) and `expiredPlatforms` (Set add) in place
 * so the caller sees the side effects.
 *
 * Extracted from the original connectionQueue.js for maintainability.
 */

const { getContext } = require("../../services/contextService");
const { sendNotification } = require("../../services/notificationService");
const {
  calculateBackoffDelay,
  recordCampaignEvent,
  getNextDayBusinessHourWindow,
  queueLog,
} = require("../utils/campaignUtils");
const { promoteRelatedDmJob } = require("./promoteDmJob");

/**
 * Persist the outcome of one connection attempt.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {object} job - The connection_jobs row currently being processed
 * @param {object} res - The result struct from platformAdapter.runConnectionAction
 * @param {object} policy - Target platform policy
 * @param {object} report - Mutable report counters (success/failed/skipped/blocked/sessionExpired)
 * @param {Set<string>} expiredPlatforms - Mutable Set of platforms known to have expired sessions this batch
 * @param {number} maxRetries - Cap after which a retryable failure becomes terminal
 */
function handleConnectionOutcome(db, job, res, policy, report, expiredPlatforms, maxRetries) {
  const normPlatform = String(job.platform).toLowerCase().trim();

  if (res.outcome === "sent") {
    db.transaction(() => {
      // Update Connection Job Status
      db.prepare(
        `
        UPDATE connection_jobs
        SET status = 'sent', error_message = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      ).run(job.id);

      // Record inside daily_actions
      db.prepare(
        `
        INSERT INTO daily_actions (platform, action_type, lead_id, outcome, campaign_id)
        VALUES (?, 'connection', ?, 'sent', ?)
      `,
      ).run(normPlatform, job.lead_id, job.campaign_id);

      // Record Campaign Event
      recordCampaignEvent(
        db,
        job.campaign_id,
        job.lead_id,
        "connection_sent",
        {
          platform: job.platform,
          metadata: res.metadata,
        },
      );

      // Promote DM Jobs (X and Instagram follows are immediate)
      promoteRelatedDmJob(db, job, policy);
    })();

    queueLog(
      "info",
      "connection_queue",
      job.id,
      "Successfully sent connection invite.",
    );
    report.success++;
  } else if (res.outcome === "skipped") {
    db.transaction(() => {
      // Update Connection Job Status as accepted (since they are already connected!)
      db.prepare(
        `
        UPDATE connection_jobs
        SET status = 'accepted', error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      ).run(res.error || "Bypassed / Already connected", job.id);

      // Record Campaign Event
      recordCampaignEvent(
        db,
        job.campaign_id,
        job.lead_id,
        "connection_skipped",
        {
          reason: res.error || "Already connected",
          metadata: res.metadata,
        },
      );

      // Promote DM Job with forceImmediate = true (already connected targets are ready for messaging!)
      promoteRelatedDmJob(db, job, policy, true);
    })();

    queueLog(
      "info",
      "connection_queue",
      job.id,
      `Connection skipped / bypassed (Reason: ${res.error || "Already connected"}). Promoted DM.`,
    );
    report.skipped++;
  } else if (res.outcome === "session_required") {
    expiredPlatforms.add(normPlatform);
    db.prepare(
      `
      UPDATE connection_jobs
      SET status = 'pending', next_retry_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    ).run(getNextDayBusinessHourWindow(normPlatform), job.id);

    recordCampaignEvent(
      db,
      job.campaign_id,
      job.lead_id,
      "session_expired",
      {
        error: res.error,
      },
    );

    // Async session expiry email notification (Gracefully isolated)
    const ctx = getContext();
    sendNotification(
      `${ctx.ctx_biz_name} Session Expired - ${normPlatform}`,
      `The connection queue worker detected that the session for platform '${normPlatform}' has expired or is invalid.\n\nError: ${res.error || "No error details available."}\n\nPlease check the automation settings dashboard to re-authenticate.`,
    ).catch((err) => {
      console.error(
        "[CAMPAIGN-OBSERVABILITY] Failed to send session expiry notification: ",
        err.message,
      );
    });

    queueLog(
      "warn",
      "connection_queue",
      job.id,
      "Platform session validation expired. Postponing job.",
    );
    report.sessionExpired++;
  } else if (res.outcome === "blocked") {
    // Automation block detected
    const nextWindow = getNextDayBusinessHourWindow(normPlatform);
    db.prepare(
      `
      UPDATE connection_jobs
      SET status = 'failed', next_retry_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    ).run(nextWindow, job.id);

    recordCampaignEvent(
      db,
      job.campaign_id,
      job.lead_id,
      "captcha_detected",
      {
        error: res.error,
      },
    );

    queueLog(
      "error",
      "connection_queue",
      job.id,
      `Automation limit or captcha active (Error: ${res.error}). Snoozed.`,
    );
    report.blocked++;
  } else {
    // General interaction failures
    const newRetryCount = (job.retry_count || 0) + 1;
    if (newRetryCount >= maxRetries) {
      // Terminal failure - execute in a transaction to cascade to related pending DM jobs
      db.transaction(() => {
        db.prepare(
          `
          UPDATE connection_jobs
          SET status = 'failed', retry_count = ?, error_message = ?, next_retry_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
        ).run(
          newRetryCount,
          res.error || "Interaction failure cap reached",
          job.id,
        );

        db.prepare(
          `
          UPDATE dm_jobs
          SET status = 'failed', error_message = 'Connection failed terminally', updated_at = CURRENT_TIMESTAMP
          WHERE campaign_id = ? AND lead_id = ? AND status = 'pending'
        `,
        ).run(job.campaign_id, job.lead_id);

        recordCampaignEvent(
          db,
          job.campaign_id,
          job.lead_id,
          "connection_failed_terminal",
          {
            error: res.error || "Max retries hit",
          },
        );
      })();

      queueLog(
        "error",
        "connection_queue",
        job.id,
        `Terminal invite failure (Cascaded to DM job): ${res.error || "Max retries hit"}`,
      );
      report.failed++;
    } else {
      // Retryable failure - apply progressive backoff
      const backoffTime = calculateBackoffDelay(newRetryCount);
      db.prepare(
        `
        UPDATE connection_jobs
        SET status = 'failed', retry_count = ?, error_message = ?, next_retry_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      ).run(
        newRetryCount,
        res.error || "Interaction timeout",
        backoffTime,
        job.id,
      );

      recordCampaignEvent(
        db,
        job.campaign_id,
        job.lead_id,
        "connection_failed_retryable",
        {
          error: res.error || "Temporary timeout",
          next_attempt: backoffTime,
        },
      );

      queueLog(
        "warn",
        "connection_queue",
        job.id,
        `Retryable invite failure: ${res.error}. Scheduled retry at: ${backoffTime}`,
      );
      report.failed++;
    }
  }
}

module.exports = {
  handleConnectionOutcome,
};
