/**
 * Social outreach DM (Direct Message) queue processor.
 *
 * Implements retry schedules, runtime platform policy checks, anti-duplication safety,
 * LinkedIn connection acceptance gates, and multi-table atomic transaction updates.
 *
 * Guarantees that connection queue failures or single-lead interaction errors
 * will never crash the messaging pipeline or general daemon process.
 */

const { getDb } = require("../db/database");
const platformAdapter = require("./platformAdapter");
const platformPolicies = require("../config/platformPolicies");
const limits = require("../config/limits");
const {
  calculateBackoffDelay,
  recordCampaignEvent,
  getNextDayBusinessHourWindow,
  queueLog
} = require("./utils/campaignUtils");
const { sendNotification } = require("../services/notificationService");

// ── SCHEMA AUTO-UPGRADE (DEFENSIVE STARTUP INITIALIZATION) ───────────────────
const db = getDb();
try {
  const dmCols = db.prepare("PRAGMA table_info(dm_jobs)").all().map(c => c.name);
  if (!dmCols.includes("retry_count")) {
    db.exec("ALTER TABLE dm_jobs ADD COLUMN retry_count INTEGER DEFAULT 0");
  }
  if (!dmCols.includes("next_retry_at")) {
    db.exec("ALTER TABLE dm_jobs ADD COLUMN next_retry_at TEXT");
  }
} catch (err) {
  console.error("[DM-QUEUE] Defensively handled schema migration error on startup:", err.message);
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
  return currentHour >= policy.activeWindow.startHour && currentHour < policy.activeWindow.endHour;
}

/**
 * Helper delay function.
 *
 * @param {number} ms - Milliseconds to sleep
 */
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main DM queue processing loop context.
 *
 * @param {object} page - Playwright page context
 * @param {object} [options={}] - Optional processing overrides (e.g. custom delays for testing)
 * @returns {Promise<object>} Analytical report of processed batch items
 */
async function processDmQueue(page, options = {}) {
  const report = {
    processed: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    blocked: 0,
    sessionExpired: 0
  };

  const maxRetries = options.maxRetries || 5;
  const expiredPlatforms = new Set();

  queueLog("info", "dm_queue", "SYSTEM", "Executing DM messaging queue processing loop...");

  let eligibleJobs = [];
  try {
    eligibleJobs = db.prepare(`
      SELECT dj.*, c.platform, c.name as campaign_name, c.created_at as campaign_created_at,
             l.profile_url, l.name as lead_name, l.x_handle, l.ig_username, l.status as lead_status,
             cj.status as connection_job_status
      FROM dm_jobs dj
      JOIN campaigns c ON dj.campaign_id = c.id
      JOIN leads l ON dj.lead_id = l.id
      LEFT JOIN connection_jobs cj ON cj.campaign_id = dj.campaign_id AND cj.lead_id = dj.lead_id
      WHERE (
          (dj.status IN ('pending', 'scheduled') AND (dj.scheduled_at IS NULL OR datetime(dj.scheduled_at) <= datetime('now')))
          OR (dj.status = 'failed' AND dj.retry_count < ? AND (dj.next_retry_at IS NULL OR datetime(dj.next_retry_at) <= datetime('now')))
        )
        AND c.status = 'active'
      ORDER BY dj.created_at ASC
    `).all(maxRetries);
  } catch (err) {
    queueLog("error", "dm_queue", "SYSTEM", `Failed to query eligible DM jobs: ${err.message}`);
    return report;
  }

  if (eligibleJobs.length === 0) {
    queueLog("info", "dm_queue", "SYSTEM", "No eligible DM jobs found.");
    return report;
  }

  queueLog("info", "dm_queue", "SYSTEM", `Found ${eligibleJobs.length} eligible DM jobs for active campaigns.`);

  for (const job of eligibleJobs) {
    // Isolated nested exception handling to guarantee queue survival
    try {
      const normPlatform = String(job.platform).toLowerCase().trim();
      const policy = platformPolicies[normPlatform];
      const platformLimits = limits[normPlatform];

      if (!policy || !platformLimits) {
        queueLog("warn", "dm_queue", job.id, `Skipping job due to unsupported platform configurations: ${job.platform}`);
        continue;
      }

      // Early out if session expired for this platform during this batch run
      if (expiredPlatforms.has(normPlatform)) {
        try {
          db.prepare(`
            UPDATE dm_jobs 
            SET status = 'pending', next_retry_at = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
          `).run(getNextDayBusinessHourWindow(normPlatform), job.id);
        } catch (err) {
          queueLog("error", "dm_queue", job.id, `Failed to postpone job after session expiration skip: ${err.message}`);
        }
        queueLog("info", "dm_queue", job.id, `Postponed job: Platform '${normPlatform}' session is already known to be expired in this batch.`);
        report.sessionExpired++;
        continue;
      }

      // ── 1. RUNTIME CAMPAIGN STATUS RE-VALIDATION ───────────────────────────
      let campaignRow;
      try {
        campaignRow = db.prepare("SELECT status FROM campaigns WHERE id = ?").get(job.campaign_id);
      } catch (err) {
        queueLog("error", "dm_queue", job.id, `Failed to query campaign status: ${err.message}`);
        continue;
      }

      if (!campaignRow || campaignRow.status !== "active") {
        queueLog("info", "dm_queue", job.id, `Skipping job since campaign is no longer active.`);
        continue;
      }

      // ── 2. ACTIVE WINDOW HOUR COMPLIANCE ──────────────────────────────────
      if (!isWithinActiveWindow(policy)) {
        const nextWindow = getNextDayBusinessHourWindow(normPlatform);
        try {
          db.prepare(`
            UPDATE dm_jobs 
            SET next_retry_at = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
          `).run(nextWindow, job.id);
          queueLog("info", "dm_queue", job.id, `Postponed DM job to next business hour window (Snoozed until: ${nextWindow}).`);
        } catch (err) {
          queueLog("error", "dm_queue", job.id, `DB update failed during active window snooze: ${err.message}`);
        }
        continue;
      }

      // ── 3. LINKEDIN CONNECTION GATING (WAITING BEHAVIOR) ────────────────────
      if (normPlatform === "linkedin") {
        const isAccepted = job.connection_job_status === "accepted" || job.lead_status === "replied" || job.lead_status === "messaged";
        if (!isAccepted) {
          // Snooze/postpone by standard check interval (e.g. 6 hours)
          const snoozeIntervalHours = options.snoozeIntervalHours || 6;
          const snoozeUntil = new Date(Date.now() + snoozeIntervalHours * 60 * 60 * 1000).toISOString();
          try {
            db.prepare(`
              UPDATE dm_jobs
              SET scheduled_at = ?, updated_at = CURRENT_TIMESTAMP, status = 'scheduled'
              WHERE id = ?
            `).run(snoozeUntil, job.id);
            queueLog("info", "dm_queue", job.id, `LinkedIn connection invite not accepted yet. Snoozing DM check for ${snoozeIntervalHours} hours.`);
          } catch (err) {
            queueLog("error", "dm_queue", job.id, `Failed to update LinkedIn DM snooze: ${err.message}`);
          }
          continue;
        }
      }

      // ── 4. ANTI-DUPLICATION SPAM PROTECTION ───────────────────────────────
      let isDuplicate = false;
      try {
        // Query touchpoints history for messages sent to this lead
        const existingTouchpoint = db.prepare(`
          SELECT id FROM touchpoints 
          WHERE lead_id = ? 
            AND platform = ? 
            AND type = 'dm' 
            AND outcome = 'sent'
        `).get(job.lead_id, normPlatform);

        // Check if there is already a successfully completed dm_job for this lead
        const existingSuccessfulJob = db.prepare(`
          SELECT id FROM dm_jobs
          WHERE campaign_id = ? AND lead_id = ? AND status = 'sent' AND id != ?
        `).get(job.campaign_id, job.lead_id, job.id);

        if (existingTouchpoint || existingSuccessfulJob) {
          isDuplicate = true;
        }
      } catch (err) {
        queueLog("error", "dm_queue", job.id, `Failed to check anti-duplication records: ${err.message}`);
      }

      if (isDuplicate) {
        try {
          db.prepare(`
            UPDATE dm_jobs 
            SET status = 'sent', error_message = 'Duplicate message blocked', updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
          `).run(job.id);
          
          recordCampaignEvent(db, job.campaign_id, job.lead_id, "dm_skipped", {
            reason: "Anti-duplication check blocked repeated outreach to prevent account spam"
          });
          
          queueLog("warn", "dm_queue", job.id, `Prevented duplicate DM send to lead ${job.lead_id}. Skipping.`);
          report.skipped++;
        } catch (err) {
          queueLog("error", "dm_queue", job.id, `Failed to register skipped duplicate job: ${err.message}`);
        }
        continue;
      }

      // ── 5. DAILY LIMIT & WARMUP CALCULATOR ─────────────────────────────────
      let limitToday = platformLimits.dms || platformLimits.messages || 20;
      if (policy.warmup?.enabled) {
        const campaignStart = new Date(job.campaign_created_at);
        const diffDays = Math.floor((Date.now() - campaignStart) / (24 * 60 * 60 * 1000));
        limitToday = Math.min(
          policy.warmup.startDailyCount + (diffDays * policy.warmup.dailyIncrement),
          limitToday
        );
      }

      // Query daily messaging actions count performed today
      let todayActionsCount = 0;
      try {
        const countRow = db.prepare(`
          SELECT COUNT(*) as count 
          FROM daily_actions 
          WHERE platform = ? 
            AND action_type = 'dm' 
            AND outcome = 'sent'
            AND date(performed_at) = date('now')
        `).get(normPlatform);
        todayActionsCount = countRow ? countRow.count : 0;
      } catch (err) {
        queueLog("error", "dm_queue", job.id, `Failed to query daily_actions count: ${err.message}`);
      }

      if (todayActionsCount >= limitToday) {
        const nextWindow = getNextDayBusinessHourWindow(normPlatform);
        try {
          db.prepare(`
            UPDATE dm_jobs 
            SET next_retry_at = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
          `).run(nextWindow, job.id);
          
          recordCampaignEvent(db, job.campaign_id, job.lead_id, "limit_reached", {
            platform: job.platform,
            daily_limit: limitToday
          });
          
          queueLog("info", "dm_queue", job.id, `Daily outreach rate limit met for campaign (${todayActionsCount}/${limitToday}). Snoozed.`);
        } catch (err) {
          queueLog("error", "dm_queue", job.id, `Failed to record limit_reached event: ${err.message}`);
        }
        continue;
      }

      // ── 6. CONCURRENCY JOB LOCKING (RUNNING STATE) ─────────────────────────
      try {
        db.prepare("UPDATE dm_jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(job.id);
      } catch (err) {
        queueLog("error", "dm_queue", job.id, `Database lock write failed, skipping item to prevent concurrent clashes: ${err.message}`);
        continue;
      }

      // ── 7. TEXT Outreach / MESSAGE BODY GENERATOR ───────────────────────────
      let messageBody = null;
      let messageId = job.message_id;

      try {
        // Query approved templates from messages table
        const approvedMessage = db.prepare(`
          SELECT id, body FROM messages 
          WHERE lead_id = ? AND platform = ? AND status = 'approved' 
          ORDER BY approved_at DESC LIMIT 1
        `).get(job.lead_id, normPlatform);

        if (approvedMessage) {
          messageBody = approvedMessage.body;
          messageId = approvedMessage.id;
          db.prepare("UPDATE dm_jobs SET message_id = ? WHERE id = ?").run(messageId, job.id);
        } else {
          // Generic human outreach template
          messageBody = `Hi ${job.lead_name || "there"}, I wanted to reach out and say hi! Hope you are doing great.`;
        }
      } catch (err) {
        queueLog("error", "dm_queue", job.id, `Failed to check approved templates: ${err.message}`);
        messageBody = `Hi ${job.lead_name || "there"}, I wanted to reach out and say hi! Hope you are doing great.`;
      }

      report.processed++;
      queueLog("info", "dm_queue", job.id, `Processing DM job for lead ${job.lead_id} (${job.profile_url}).`);

      // ── 8. BROWSER OUTREACH EXECUTION via platformAdapter ───────────────────
      let res;
      try {
        res = await platformAdapter.runDmAction(
          job.platform,
          page,
          job,
          messageBody,
          (type, msg) => {
            queueLog(type, "dm_queue", job.id, `[ADAPTER LOG] ${msg}`);
          }
        );
      } catch (err) {
        res = {
          outcome: "failed",
          error: `Uncaught DM adapter crash: ${err.message}`,
          metadata: {},
          retryable: true
        };
      }

      // ── 9. ATOMIC MULTI-TABLE TRANSACTION STATE UPDATE ──────────────────────
      try {
        if (res.outcome === "sent") {
          db.transaction(() => {
            // Update DM Job Status
            db.prepare(`
              UPDATE dm_jobs 
              SET status = 'sent', sent_at = CURRENT_TIMESTAMP, error_message = NULL, updated_at = CURRENT_TIMESTAMP 
              WHERE id = ?
            `).run(job.id);

            // Update Lead Outreach Stage Status
            db.prepare(`
              UPDATE leads 
              SET status = 'messaged', updated_at = CURRENT_TIMESTAMP 
              WHERE id = ?
            `).run(job.lead_id);

            // Register Touchpoints Action Tracking
            db.prepare(`
              INSERT INTO touchpoints (lead_id, type, platform, message_id, outcome, sent_at, notes)
              VALUES (?, 'dm', ?, ?, 'sent', CURRENT_TIMESTAMP, ?)
            `).run(job.lead_id, normPlatform, messageId, messageBody);

            // Record inside daily_actions
            db.prepare(`
              INSERT INTO daily_actions (platform, action_type, lead_id, outcome, campaign_id)
              VALUES (?, 'dm', ?, 'sent', ?)
            `).run(normPlatform, job.lead_id, job.campaign_id);

            // Update original approved message status to 'sent'
            if (messageId) {
              db.prepare(`
                UPDATE messages 
                SET status = 'sent', sent_at = CURRENT_TIMESTAMP 
                WHERE id = ?
              `).run(messageId);
            }

            // Record Campaign Event
            recordCampaignEvent(db, job.campaign_id, job.lead_id, "dm_sent", {
              platform: job.platform,
              message_id: messageId,
              metadata: res.metadata
            });
          })();

          queueLog("info", "dm_queue", job.id, "Successfully sent DM to lead.");
          report.success++;
        }
        else if (res.outcome === "skipped") {
          db.transaction(() => {
            db.prepare(`
              UPDATE dm_jobs 
              SET status = 'sent', error_message = ?, updated_at = CURRENT_TIMESTAMP 
              WHERE id = ?
            `).run(res.error || "Bypassed / Already messaged", job.id);

            db.prepare(`
              INSERT INTO touchpoints (lead_id, type, platform, message_id, outcome, sent_at, notes)
              VALUES (?, 'dm', ?, ?, 'skipped', CURRENT_TIMESTAMP, ?)
            `).run(job.lead_id, normPlatform, messageId, res.error || "Already messaged");

            recordCampaignEvent(db, job.campaign_id, job.lead_id, "dm_skipped", {
              reason: res.error || "Already messaged",
              metadata: res.metadata
            });
          })();

          queueLog("info", "dm_queue", job.id, `DM skipped (Reason: ${res.error || "Already messaged"}).`);
          report.skipped++;
        }
        else if (res.outcome === "session_required") {
          expiredPlatforms.add(normPlatform);
          db.prepare(`
            UPDATE dm_jobs 
            SET status = 'pending', next_retry_at = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
          `).run(getNextDayBusinessHourWindow(normPlatform), job.id);

          recordCampaignEvent(db, job.campaign_id, job.lead_id, "session_expired", {
            error: res.error
          });

          // Async session expiry email notification (Gracefully isolated)
          sendNotification(
            `GTSS Session Expired - ${normPlatform}`,
            `The DM queue worker detected that the session for platform '${normPlatform}' has expired or is invalid.\n\nError: ${res.error || "No error details available."}\n\nPlease check the automation settings dashboard to re-authenticate.`
          ).catch((err) => {
            console.error("[CAMPAIGN-OBSERVABILITY] Failed to send session expiry notification: ", err.message);
          });

          queueLog("warn", "dm_queue", job.id, "Platform session validation expired. Postponing job.");
          report.sessionExpired++;
        }
        else if (res.outcome === "blocked") {
          const nextWindow = getNextDayBusinessHourWindow(normPlatform);
          db.prepare(`
            UPDATE dm_jobs 
            SET status = 'failed', next_retry_at = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
          `).run(nextWindow, job.id);

          recordCampaignEvent(db, job.campaign_id, job.lead_id, "captcha_detected", {
            error: res.error
          });

          queueLog("error", "dm_queue", job.id, `Automation limit or captcha active (Error: ${res.error}). Snoozed.`);
          report.blocked++;
        }
        else {
          // General interaction failures - handled independently from connection queue
          const newRetryCount = (job.retry_count || 0) + 1;
          if (newRetryCount >= maxRetries) {
            // Terminal failure
            db.transaction(() => {
              db.prepare(`
                UPDATE dm_jobs 
                SET status = 'failed', retry_count = ?, error_message = ?, next_retry_at = NULL, updated_at = CURRENT_TIMESTAMP 
                WHERE id = ?
              `).run(newRetryCount, res.error || "Interaction failure cap reached", job.id);

              db.prepare(`
                INSERT INTO touchpoints (lead_id, type, platform, message_id, outcome, sent_at, notes)
                VALUES (?, 'dm', ?, ?, 'failed', CURRENT_TIMESTAMP, ?)
              `).run(job.lead_id, normPlatform, messageId, res.error || "Terminal interactions crash");

              recordCampaignEvent(db, job.campaign_id, job.lead_id, "dm_failed_terminal", {
                error: res.error || "Max retries hit"
              });
            })();

            queueLog("error", "dm_queue", job.id, `Terminal DM failure: ${res.error || "Max retries hit"}`);
            report.failed++;
          } else {
            // Retryable failure - apply progressive backoff
            const backoffTime = calculateBackoffDelay(newRetryCount);
            db.prepare(`
              UPDATE dm_jobs 
              SET status = 'failed', retry_count = ?, error_message = ?, next_retry_at = ?, updated_at = CURRENT_TIMESTAMP 
              WHERE id = ?
            `).run(newRetryCount, res.error || "Interaction timeout", backoffTime, job.id);

            recordCampaignEvent(db, job.campaign_id, job.lead_id, "dm_failed_retryable", {
              error: res.error || "Temporary timeout",
              next_attempt: backoffTime
            });

            queueLog("warn", "dm_queue", job.id, `Retryable DM failure: ${res.error}. Scheduled retry at: ${backoffTime}`);
            report.failed++;
          }
        }
      } catch (err) {
        queueLog("error", "dm_queue", job.id, `Failed to persist transaction outcomes in database: ${err.message}`);
      }

      // ── 10. HUMAN-LIKE INTER-ACTION DELAY ─────────────────────────────────
      if (options.skipDelays) {
        continue;
      }
      const minSec = policy.delays?.actionMinSeconds || 20;
      const maxSec = policy.delays?.actionMaxSeconds || 60;
      const randomDelay = Math.floor(Math.random() * (maxSec - minSec + 1) + minSec) * 1000;

      queueLog("info", "dm_queue", job.id, `Simulating human browser delay: sleeping for ${(randomDelay / 1000).toFixed(1)} seconds.`);
      await sleep(randomDelay);

    } catch (err) {
      queueLog("error", "dm_queue", job.id, `Uncaught isolated item execution exception: ${err.message}`);
    }
  }

  queueLog("info", "dm_queue", "SYSTEM", `DM messaging queue batch finished: ${JSON.stringify(report)}`);
  return report;
}

module.exports = {
  processDmQueue
};
