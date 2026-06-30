/**
 * Social outreach connection invite queue processor.
 *
 * Implements human-like micro-delays, platform warmup rates, idempotency rules,
 * transactional DM job promotions, and isolated exception catcher scopes.
 *
 * Guarantees that a failure in one job will never interrupt the wider batch,
 * and SQLite write locks or Playwright crashes will never abort the main runner process.
 */

const { getDb } = require("../db/database");
const platformAdapter = require("./platformAdapter");
const platformPolicies = require("../config/platformPolicies");
const limits = require("../config/limits");
const { getContext } = require("../services/contextService");

// ── GLOBAL STOP FLAG (shared with executor.js via stopConnectionQueue()) ──────
// Mirrors dmQueue.js — lets the automation page's stop button halt the cron
// connection queue too.
let CONNECTION_QUEUE_STOPPED = false;

function stopConnectionQueue() {
  CONNECTION_QUEUE_STOPPED = true;
}
function resetConnectionQueueStopFlag() {
  CONNECTION_QUEUE_STOPPED = false;
}
function isConnectionQueueStopped() {
  return CONNECTION_QUEUE_STOPPED;
}
const {
  calculateBackoffDelay,
  recordCampaignEvent,
  getNextDayBusinessHourWindow,
  queueLog,
} = require("./utils/campaignUtils");
const { sendNotification } = require("../services/notificationService");

// ── SCHEMA AUTO-UPGRADE (DEFENSIVE STARTUP INITIALIZATION) ───────────────────
const db = getDb();
try {
  const connCols = db
    .prepare("PRAGMA table_info(connection_jobs)")
    .all()
    .map((c) => c.name);
  if (!connCols.includes("retry_count")) {
    db.exec(
      "ALTER TABLE connection_jobs ADD COLUMN retry_count INTEGER DEFAULT 0",
    );
  }
  if (!connCols.includes("next_retry_at")) {
    db.exec("ALTER TABLE connection_jobs ADD COLUMN next_retry_at TEXT");
  }
} catch (err) {
  console.error(
    "[CONNECTION-QUEUE] Defensively handled schema migration error on startup:",
    err.message,
  );
}

/**
 * Checks if current hour is within target platform policy operational window.
 *
 * @param {object} policy - Target platform policy configuration
 * @returns {boolean} True if inside the active hours
 */
function isWithinActiveWindow(policy) {
  if (!policy || !policy.activeWindow) return true;
  const currentHour = new Date().getHours();
  return (
    currentHour >= policy.activeWindow.startHour &&
    currentHour < policy.activeWindow.endHour
  );
}

/**
 * Helper delay function.
 *
 * @param {number} ms - Milliseconds to sleep
 */
/**
 * Interruptible sleep. Resolves early if the global CONNECTION_QUEUE_STOPPED
 * flag is set, so the stop button on the automation page can halt the
 * cron-triggered connection queue without waiting for the full cooldown.
 *
 * @param {number} ms - Milliseconds to sleep
 */
async function sleep(ms) {
  const stepMs = 500;
  let elapsed = 0;
  while (elapsed < ms) {
    if (CONNECTION_QUEUE_STOPPED) return;
    const waitMs = Math.min(stepMs, ms - elapsed);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    elapsed += waitMs;
  }
}

/**
 * Promotes related DM jobs for Instagram, X, and Facebook once connection/follow is verified.
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

/**
 * Main connection queue processing loop context.
 *
 * @param {object} page - Playwright page context
 * @param {object} [options={}] - Optional processing overrides (e.g. custom delays for testing)
 * @returns {Promise<object>} Analytical report of processed batch items
 */
async function processConnectionQueue(page, options = {}) {
  // Reset the stop flag at the START of each run so a previous stop doesn't
  // permanently disable future cron runs.
  resetConnectionQueueStopFlag();

  const report = {
    processed: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    blocked: 0,
    sessionExpired: 0,
  };

  const maxRetries = options.maxRetries || 5;
  const expiredPlatforms = new Set();

  queueLog(
    "info",
    "connection_queue",
    "SYSTEM",
    "Executing connection queue processing loop...",
  );

  let eligibleJobs = [];
  try {
    eligibleJobs = db
      .prepare(
        `
      SELECT cj.*, c.platform, c.name as campaign_name, c.created_at as campaign_created_at,
             l.profile_url, l.name as lead_name, l.x_handle, l.ig_username, l.status as lead_status
      FROM connection_jobs cj
      JOIN campaigns c ON cj.campaign_id = c.id
      JOIN leads l ON cj.lead_id = l.id
      WHERE (cj.status = 'pending' OR (cj.status = 'failed' AND cj.retry_count < ? AND (cj.next_retry_at IS NULL OR datetime(cj.next_retry_at) <= datetime('now'))))
        AND c.status = 'active'
      ORDER BY cj.created_at ASC
    `,
      )
      .all(maxRetries);
  } catch (err) {
    queueLog(
      "error",
      "connection_queue",
      "SYSTEM",
      `Failed to query eligible jobs: ${err.message}`,
    );
    return report;
  }

  if (eligibleJobs.length === 0) {
    queueLog(
      "info",
      "connection_queue",
      "SYSTEM",
      "No eligible connection jobs found.",
    );
    return report;
  }

  queueLog(
    "info",
    "connection_queue",
    "SYSTEM",
    `Found ${eligibleJobs.length} eligible connection jobs for active campaigns.`,
  );

  for (const job of eligibleJobs) {
    if (CONNECTION_QUEUE_STOPPED) {
      queueLog(
        "info",
        "connection_queue",
        "SYSTEM",
        "Connection queue stopped by user (stop button on automation page).",
      );
      break;
    }
    // Isolated nested exception handling to keep queue running no matter what
    try {
      const normPlatform = String(job.platform).toLowerCase().trim();
      const policy = platformPolicies[normPlatform];
      const platformLimits = limits[normPlatform];

      if (!policy || !platformLimits) {
        queueLog(
          "warn",
          "connection_queue",
          job.id,
          `Skipping job due to unsupported platform configurations: ${job.platform}`,
        );
        continue;
      }

      // Early out if session expired for this platform during this batch run
      if (expiredPlatforms.has(normPlatform)) {
        try {
          db.prepare(
            `
            UPDATE connection_jobs 
            SET status = 'pending', next_retry_at = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
          `,
          ).run(getNextDayBusinessHourWindow(normPlatform), job.id);
        } catch (err) {
          queueLog(
            "error",
            "connection_queue",
            job.id,
            `Failed to postpone job after session expiration skip: ${err.message}`,
          );
        }
        queueLog(
          "info",
          "connection_queue",
          job.id,
          `Postponed job: Platform '${normPlatform}' session is already known to be expired in this batch.`,
        );
        report.sessionExpired++;
        continue;
      }

      // ── 1. REAL-TIME CAMPAIGN STATUS VERIFICATION ──────────────────────────
      let campaignRow;
      try {
        campaignRow = db
          .prepare("SELECT status FROM campaigns WHERE id = ?")
          .get(job.campaign_id);
      } catch (err) {
        queueLog(
          "error",
          "connection_queue",
          job.id,
          `Failed to query campaign status: ${err.message}`,
        );
        continue;
      }

      if (!campaignRow || campaignRow.status !== "active") {
        queueLog(
          "info",
          "connection_queue",
          job.id,
          `Skipping job since campaign is no longer active (Status: ${campaignRow ? campaignRow.status : "deleted"}).`,
        );
        continue;
      }

      // ── 2. ACTIVE WINDOW HOUR COMPLIANCE ──────────────────────────────────
      if (!isWithinActiveWindow(policy)) {
        const nextWindow = getNextDayBusinessHourWindow(normPlatform);
        try {
          db.prepare(
            `
            UPDATE connection_jobs 
            SET next_retry_at = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
          `,
          ).run(nextWindow, job.id);
          queueLog(
            "info",
            "connection_queue",
            job.id,
            `Postponed job to next business hour window (Snoozed until: ${nextWindow}).`,
          );
        } catch (err) {
          queueLog(
            "error",
            "connection_queue",
            job.id,
            `DB update failed during active window snooze: ${err.message}`,
          );
        }
        continue;
      }

      // ── 3. DAILY LIMIT & WARMUP CALCULATOR ─────────────────────────────────
      let limitToday =
        platformLimits.connections || platformLimits.follows || 15;
      if (policy.warmup?.enabled) {
        const campaignStart = new Date(job.campaign_created_at);
        const diffDays = Math.floor(
          (Date.now() - campaignStart) / (24 * 60 * 60 * 1000),
        );
        limitToday = Math.min(
          policy.warmup.startDailyCount +
            diffDays * policy.warmup.dailyIncrement,
          limitToday,
        );
      }

      // Query daily connection actions count performed today
      let todayActionsCount = 0;
      try {
        const countRow = db
          .prepare(
            `
          SELECT COUNT(*) as count 
          FROM daily_actions 
          WHERE platform = ? 
            AND action_type = 'connection' 
            AND outcome = 'sent'
            AND date(performed_at) = date('now')
        `,
          )
          .get(normPlatform);
        todayActionsCount = countRow ? countRow.count : 0;
      } catch (err) {
        queueLog(
          "error",
          "connection_queue",
          job.id,
          `Failed to query daily_actions count: ${err.message}`,
        );
      }

      if (todayActionsCount >= limitToday) {
        const nextWindow = getNextDayBusinessHourWindow(normPlatform);
        try {
          db.prepare(
            `
            UPDATE connection_jobs 
            SET next_retry_at = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
          `,
          ).run(nextWindow, job.id);

          recordCampaignEvent(
            db,
            job.campaign_id,
            job.lead_id,
            "limit_reached",
            {
              platform: job.platform,
              daily_limit: limitToday,
            },
          );

          queueLog(
            "info",
            "connection_queue",
            job.id,
            `Daily outreach rate limit met for campaign (${todayActionsCount}/${limitToday}). Snoozed until tomorrow.`,
          );
        } catch (err) {
          queueLog(
            "error",
            "connection_queue",
            job.id,
            `Failed to record limit_reached event: ${err.message}`,
          );
        }
        continue;
      }

      // ── 4. CONCURRENCY JOB LOCKING (RUNNING STATE) ─────────────────────────
      try {
        db.prepare(
          "UPDATE connection_jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        ).run(job.id);
      } catch (err) {
        queueLog(
          "error",
          "connection_queue",
          job.id,
          `Database lock write failed, skipping item to prevent concurrent clashes: ${err.message}`,
        );
        continue;
      }

      report.processed++;
      queueLog(
        "info",
        "connection_queue",
        job.id,
        `Processing connection job for lead ${job.lead_id} (${job.profile_url}).`,
      );

      // ── 5. BROWSER OUTREACH EXECUTION via platformAdapter ───────────────────
      const friendlyDefaultMessage = `Hi ${job.lead_name || "there"}, I'd love to connect!`;
      let res;
      try {
        res = await platformAdapter.runConnectionAction(
          job.platform,
          page,
          job,
          friendlyDefaultMessage,
          (type, msg) => {
            queueLog(type, "connection_queue", job.id, `[ADAPTER LOG] ${msg}`);
          },
        );
      } catch (err) {
        res = {
          outcome: "failed",
          error: `Uncaught adapter crash: ${err.message}`,
          metadata: {},
          retryable: true,
        };
      }

      // ── 6. NORMALIZED OUTCOME MAPPING & PERSISTENCE ─────────────────────────
      try {
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
      } catch (err) {
        queueLog(
          "error",
          "connection_queue",
          job.id,
          `Failed to persist transaction outcomes in database: ${err.message}`,
        );
      }

      // ── 7. HUMAN-LIKE INTER-ACTION DELAY ──────────────────────────────────
      if (options.skipDelays) {
        continue;
      }
      const minSec = policy.delays?.actionMinSeconds || 20;
      const maxSec = policy.delays?.actionMaxSeconds || 60;
      const randomDelay =
        Math.floor(Math.random() * (maxSec - minSec + 1) + minSec) * 1000;

      queueLog(
        "info",
        "connection_queue",
        job.id,
        `Simulating human browser delay: sleeping for ${(randomDelay / 1000).toFixed(1)} seconds.`,
      );
      await sleep(randomDelay);
    } catch (err) {
      queueLog(
        "error",
        "connection_queue",
        job.id,
        `Uncaught isolated item execution exception: ${err.message}`,
      );
    }
  }

  queueLog(
    "info",
    "connection_queue",
    "SYSTEM",
    `Connection queue batch finished: ${JSON.stringify(report)}`,
  );
  return report;
}

module.exports = {
  processConnectionQueue,
  stopConnectionQueue,
  resetConnectionQueueStopFlag,
  isConnectionQueueStopped,
};
