/**
 * Connection Queue — Main Processing Loop
 *
 * Implements human-like micro-delays, platform warmup rates, idempotency
 * rules, transactional DM job promotions, and isolated exception catcher
 * scopes.
 *
 * Guarantees that a failure in one job will never interrupt the wider batch,
 * and SQLite write locks or Playwright crashes will never abort the main
 * runner process.
 *
 * Per-iteration phases:
 *   0. Eligibility query (pending OR retryable-failed jobs in active campaigns)
 *   1. Real-time campaign status re-verification
 *   2. Active-window hour compliance (snooze to next business-hour window)
 *   3. Daily limit + warmup cap calculation
 *   4. Concurrency job locking (running state)
 *   5. Browser outreach execution via platformAdapter
 *   6. Normalized outcome mapping & persistence (delegated to ./outcomeHandlers)
 *   7. Stray-tab cleanup (LinkedIn redirect-tab accumulator guard)
 *   8. Human-like inter-action delay (interruptible)
 *
 * Extracted from the original connectionQueue.js for maintainability.
 */

const { getDb } = require("../../db/database");
const platformAdapter = require("../platformAdapter");
const platformPolicies = require("../../config/platformPolicies");
const limits = require("../../config/limits");
const { closeStrayTabs } = require("../../automation/browserBase");
const {
  recordCampaignEvent,
  getNextDayBusinessHourWindow,
  queueLog,
} = require("../utils/campaignUtils");

const {
  resetConnectionQueueStopFlag,
  isConnectionQueueStopped,
} = require("./stopFlag");
const { isWithinActiveWindow } = require("./activeWindow");
const { sleep } = require("./interruptibleSleep");
const { ensureConnectionJobsSchema } = require("./schemaInit");
const { handleConnectionOutcome } = require("./outcomeHandlers");

// ── SCHEMA AUTO-UPGRADE (DEFENSIVE STARTUP INITIALIZATION) ───────────────────
// Runs at module load, exactly like the original connectionQueue.js top-level
// block. Adds retry_count / next_retry_at columns to connection_jobs if
// missing. Errors are caught + logged inside ensureConnectionJobsSchema() so
// a migration failure can never crash the connection-queue pipeline on
// startup.
const db = getDb();
ensureConnectionJobsSchema(db);

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
    if (isConnectionQueueStopped()) {
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
      let res;
      try {
        res = await platformAdapter.runConnectionAction(
          job.platform,
          page,
          job,
          "",
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
        handleConnectionOutcome(db, job, res, policy, report, expiredPlatforms, maxRetries);
      } catch (err) {
        queueLog(
          "error",
          "connection_queue",
          job.id,
          `Failed to persist transaction outcomes in database: ${err.message}`,
        );
      }

      // ── 7. STRAY-TAB CLEANUP (always, before any continue) ──────────────
      // LinkedIn frequently auto-redirects to /talent/job-posting-redirect/
      // or /job-posting/ when a "Connect" click triggers a Premium upsell or
      // email-required interstitial. The connection queue processes many leads
      // back-to-back; without per-iteration cleanup these redirect tabs
      // accumulate for the entire batch (the "two tabs active, one is
      // /job-posting" symptom). This MUST run before the `continue` below so
      // the skipDelays path still cleans up.
      try {
        const ctx =
          page && page.context && typeof page.context === "function"
            ? page.context()
            : page && page._context
              ? page._context
              : null;
        if (ctx) {
          await closeStrayTabs(ctx, job.platform);
        }
      } catch (cleanupErr) {
        queueLog(
          "warn",
          "connection_queue",
          job.id,
          `Stray-tab cleanup failed: ${cleanupErr.message}`,
        );
      }

      // ── 8. HUMAN-LIKE INTER-ACTION DELAY ──────────────────────────────────
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
};
