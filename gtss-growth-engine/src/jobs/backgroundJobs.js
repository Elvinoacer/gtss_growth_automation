require("dotenv").config();

const { initReplyChecker } = require("./replyChecker");
const { initScheduledPoster } = require("./scheduledPoster");
const { initInstagramWarmupJobs } = require("./instagramWarmupJob");
const { getDb } = require("../db/database");
const { stopAllJobs } = require("../automation/executor");
const browserBase = require("../automation/browserBase");
const logger = require("../utils/logger");

// Campaign Queue Imports
const { processConnectionQueue } = require("../campaign/connectionQueue");
const { processDmQueue } = require("../campaign/dmQueue");
const platformAdapter = require("../campaign/platformAdapter");

// Concurrency mutex and locking flags
let campaignQueueInProgress = false;
let currentPlatform = null;

// Wrap platformAdapter connection/DM actions dynamically to track active platform
const originalRunConnectionAction = platformAdapter.runConnectionAction;
const originalRunDmAction = platformAdapter.runDmAction;

platformAdapter.runConnectionAction = async function (platform, page, ...args) {
  currentPlatform = String(platform).toLowerCase().trim();
  return originalRunConnectionAction.call(this, platform, page, ...args);
};

platformAdapter.runDmAction = async function (platform, page, ...args) {
  currentPlatform = String(platform).toLowerCase().trim();
  return originalRunDmAction.call(this, platform, page, ...args);
};

/**
 * Pre-launch Playwright browser contexts for required campaign outreach platforms.
 *
 * @param {Array<string>} platforms - Platforms needing browser instances in the current run.
 * @returns {Promise<Object>} Map of platform keys to active browser state objects.
 */
async function launchRequiredBrowsers(platforms) {
  const activePages = {};
  for (const platform of platforms) {
    const normPlatform = platform.toLowerCase().trim();
    try {
      logger.info("SERVER", `[CAMPAIGN-QUEUES] Pre-launching browser context for platform: ${normPlatform}`);
      let state;
      if (normPlatform === "instagram") {
        state = await browserBase.createInstagramBrowser();
      } else {
        state = await browserBase.createBrowser(normPlatform, {
          headless: process.env.ALLOW_HEADLESS_SOCIAL === "true",
        });
      }
      activePages[normPlatform] = state;
    } catch (err) {
      logger.error("SERVER", `[CAMPAIGN-QUEUES] Failed to launch browser for platform: ${normPlatform}`, err);
      // Rollback clean up already launched contexts
      for (const [p, state] of Object.entries(activePages)) {
        try {
          await browserBase.closeBrowser(state.browser, p, state.context, {
            mode: state.mode,
            tracePath: state.tracePath,
            shouldCloseBrowser: state.shouldCloseBrowser,
            lock: state.lock,
          });
        } catch (_) { /* ignore */ }
      }
      throw err;
    }
  }
  return activePages;
}

/**
 * Clean up and close all active campaign queue browser pages/contexts.
 *
 * @param {Object} activePages - Map of platform keys to active browser states.
 */
async function closeAllActivePages(activePages) {
  for (const [platform, state] of Object.entries(activePages)) {
    try {
      logger.info("SERVER", `[CAMPAIGN-QUEUES] Closing background browser context for platform: ${platform}`);
      await browserBase.closeBrowser(state.browser, platform, state.context, {
        mode: state.mode,
        tracePath: state.tracePath,
        shouldCloseBrowser: state.shouldCloseBrowser,
        lock: state.lock,
      });
    } catch (err) {
      logger.error("SERVER", `[CAMPAIGN-QUEUES] Error during browser closure for ${platform}`, err);
    }
  }
}

/**
 * Create a transparent dynamic Proxy that maps standard Playwright page calls
 * to the currently active platform's pre-launched page context.
 *
 * @param {Object} activePages - Pre-launched platform contexts.
 * @returns {Object} Transparent page Proxy.
 */
function createProxyPage(activePages) {
  return new Proxy({}, {
    get(target, prop) {
      if (!currentPlatform) {
        logger.warn("SERVER", "[CAMPAIGN-QUEUES] Proxy page property accessed, but no active currentPlatform context is active.");
        return undefined;
      }
      const realState = activePages[currentPlatform];
      if (!realState || !realState.page) {
        throw new Error(`[CAMPAIGN-QUEUES] No active browser page found for current platform context: ${currentPlatform}`);
      }
      const val = realState.page[prop];
      if (typeof val === "function") {
        return val.bind(realState.page);
      }
      return val;
    }
  });
}

/**
 * Worker runner job for campaign invites Connection Queue.
 */
async function runConnectionQueueJob(options = {}) {
  if (campaignQueueInProgress) {
    logger.info("SERVER", "[CONNECTION-QUEUE] Skipping execution: another campaign outreach queue run is in progress.");
    return;
  }

  const db = getDb();
  
  // Acquire cluster-safe database lock atomic transition
  try {
    const lockRes = db.prepare("UPDATE settings SET value = 'true' WHERE key = 'campaign_queue_lock' AND value = 'false'").run();
    if (lockRes.changes === 0) {
      logger.info("SERVER", "[CONNECTION-QUEUE] Skipping execution: another cluster instance or runner has acquired the queue lock.");
      return;
    }
  } catch (err) {
    logger.error("SERVER", "[CONNECTION-QUEUE] Failed to acquire persistent queue lock: ", err.message);
    return;
  }

  campaignQueueInProgress = true;
  let activePages = {};

  try {
    logger.info("SERVER", "[CONNECTION-QUEUE] Starting campaign connection invite queue run...");

    const maxRetries = 5;
    const rows = db.prepare(`
      SELECT DISTINCT c.platform
      FROM connection_jobs cj
      JOIN campaigns c ON cj.campaign_id = c.id
      JOIN leads l ON cj.lead_id = l.id
      WHERE (cj.status = 'pending' OR (cj.status = 'failed' AND cj.retry_count < ? AND (cj.next_retry_at IS NULL OR datetime(cj.next_retry_at) <= datetime('now'))))
        AND c.status = 'active'
    `).all(maxRetries);

    if (rows.length === 0) {
      logger.info("SERVER", "[CONNECTION-QUEUE] No active platform campaigns have pending or retryable connection invite jobs.");
      campaignQueueInProgress = false;
      try {
        db.prepare("UPDATE settings SET value = 'false' WHERE key = 'campaign_queue_lock'").run();
      } catch (_) {}
      return;
    }

    const requiredPlatforms = rows.map(r => String(r.platform).toLowerCase().trim());
    logger.info("SERVER", `[CONNECTION-QUEUE] Pre-flight inspection: Launching contexts for platforms: ${requiredPlatforms.join(", ")}`);

    activePages = await launchRequiredBrowsers(requiredPlatforms);
    const proxyPage = createProxyPage(activePages);

    const report = await processConnectionQueue(proxyPage, options);
    logger.info("SERVER", `[CONNECTION-QUEUE] Connection queue batch processing complete: ${JSON.stringify(report)}`);

  } catch (err) {
    logger.error("SERVER", "[CONNECTION-QUEUE] Connection queue cron runner encountered a critical error", err);
  } finally {
    await closeAllActivePages(activePages);
    currentPlatform = null;
    campaignQueueInProgress = false;
    try {
      db.prepare("UPDATE settings SET value = 'false' WHERE key = 'campaign_queue_lock'").run();
    } catch (err) {
      logger.error("SERVER", "[CONNECTION-QUEUE] Failed to release persistent queue lock: ", err.message);
    }
  }
}

/**
 * Worker runner job for campaign messaging DM Queue.
 */
async function runDmQueueJob(options = {}) {
  if (campaignQueueInProgress) {
    logger.info("SERVER", "[DM-QUEUE] Skipping execution: another campaign outreach queue run is in progress.");
    return;
  }

  const db = getDb();

  // Acquire cluster-safe database lock atomic transition
  try {
    const lockRes = db.prepare("UPDATE settings SET value = 'true' WHERE key = 'campaign_queue_lock' AND value = 'false'").run();
    if (lockRes.changes === 0) {
      logger.info("SERVER", "[DM-QUEUE] Skipping execution: another cluster instance or runner has acquired the queue lock.");
      return;
    }
  } catch (err) {
    logger.error("SERVER", "[DM-QUEUE] Failed to acquire persistent queue lock: ", err.message);
    return;
  }

  campaignQueueInProgress = true;
  let activePages = {};

  try {
    logger.info("SERVER", "[DM-QUEUE] Starting campaign DM messaging queue run...");

    const maxRetries = 5;
    const rows = db.prepare(`
      SELECT DISTINCT c.platform
      FROM dm_jobs dj
      JOIN campaigns c ON dj.campaign_id = c.id
      JOIN leads l ON dj.lead_id = l.id
      WHERE (dj.status = 'pending' OR dj.status = 'scheduled' OR (dj.status = 'failed' AND dj.retry_count < ? AND (dj.next_retry_at IS NULL OR datetime(dj.next_retry_at) <= datetime('now'))))
        AND c.status = 'active'
    `).all(maxRetries);

    if (rows.length === 0) {
      logger.info("SERVER", "[DM-QUEUE] No active platform campaigns have pending, scheduled, or retryable DM messaging jobs.");
      campaignQueueInProgress = false;
      try {
        db.prepare("UPDATE settings SET value = 'false' WHERE key = 'campaign_queue_lock'").run();
      } catch (_) {}
      return;
    }

    const requiredPlatforms = rows.map(r => String(r.platform).toLowerCase().trim());
    logger.info("SERVER", `[DM-QUEUE] Pre-flight inspection: Launching contexts for platforms: ${requiredPlatforms.join(", ")}`);

    activePages = await launchRequiredBrowsers(requiredPlatforms);
    const proxyPage = createProxyPage(activePages);

    const report = await processDmQueue(proxyPage, options);
    logger.info("SERVER", `[DM-QUEUE] DM queue batch processing complete: ${JSON.stringify(report)}`);

  } catch (err) {
    logger.error("SERVER", "[DM-QUEUE] DM queue cron runner encountered a critical error", err);
  } finally {
    await closeAllActivePages(activePages);
    currentPlatform = null;
    campaignQueueInProgress = false;
    try {
      db.prepare("UPDATE settings SET value = 'false' WHERE key = 'campaign_queue_lock'").run();
    } catch (err) {
      logger.error("SERVER", "[DM-QUEUE] Failed to release persistent queue lock: ", err.message);
    }
  }
}

let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn(
    "SERVER",
    `Background automation worker received ${signal}. Shutting down.`,
  );

  try {
    stopAllJobs();
    await browserBase.closeAllBrowsers();
    logger.info("SERVER", "Background automation worker shutdown complete.");
    process.exit(0);
  } catch (error) {
    logger.error(
      "SERVER",
      "Background automation worker shutdown failed",
      error,
    );
    process.exit(1);
  }
}

function startBackgroundJobs() {
  logger.info("SERVER", "Background automation worker initializing.");

  // ── STARTUP RECOVERY SWEEPER & LOCK RESET ──────────────────────────────────
  try {
    const db = getDb();
    
    // Clear connection jobs stuck in 'running' state on server boot
    const connSweep = db.prepare(`
      UPDATE connection_jobs 
      SET status = 'pending', updated_at = CURRENT_TIMESTAMP 
      WHERE status = 'running'
    `).run();
    logger.info("SERVER", `[STARTUP-SWEEP] Reset ${connSweep.changes} connection jobs stuck in 'running' status back to 'pending'.`);

    // Clear DM jobs stuck in 'running' state
    const dmSweep = db.prepare(`
      UPDATE dm_jobs 
      SET status = 'pending', updated_at = CURRENT_TIMESTAMP 
      WHERE status = 'running'
    `).run();
    logger.info("SERVER", `[STARTUP-SWEEP] Reset ${dmSweep.changes} DM jobs stuck in 'running' status back to 'pending'.`);

    // Initialize/Reset the database lock to false
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('campaign_queue_lock', 'false')
      ON CONFLICT(key) DO UPDATE SET value = 'false'
    `).run();
    logger.info("SERVER", "[STARTUP-SWEEP] Initialized/Reset persistent campaign queue lock to 'false'.");
  } catch (err) {
    logger.error("SERVER", "[STARTUP-SWEEP] Failed to execute startup sweeper & lock reset: ", err);
  }

  initReplyChecker();
  initScheduledPoster();
  initInstagramWarmupJobs();

  // Cleanup orphan uploads (older than 7 days) at 3 AM daily
  const cron = require("node-cron");
  const fs = require("fs");
  const path = require("path");
  cron.schedule("0 3 * * *", () => {
    const dir = path.join(__dirname, "../../public/uploads");
    if (!fs.existsSync(dir)) return;
    const db = getDb();
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    fs.readdirSync(dir).forEach((f) => {
      const fp = path.join(dir, f);
      try {
        const stats = fs.statSync(fp);
        const pendingRow = db
            .prepare(
                `SELECT 1
             FROM posts
             WHERE media_path IN (?, ?, ?)
               AND (
                 status IN ('scheduled', 'draft')
                 OR (status = 'failed' AND (retry_count > 0 OR next_retry_at IS NOT NULL))
               )
             LIMIT 1`,
            )
            .get(fp, `/uploads/${f}`, `uploads/${f}`);

        if (!pendingRow && stats.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          logger.info("SERVER", `Cleaned up orphan upload: ${f}`);
        } else if (pendingRow) {
          logger.debug(
              "SERVER",
              `Keeping upload referenced by pending post: ${f}`,
          );
        }
      } catch (e) {
        /* ignore */
      }
    });
  });

  // Pipeline cron — run the full outreach pipeline on schedule
  const { pipelineCron } = require('../config/pipelineConfig');
  const { runFullPipeline } = require('../pipeline/pipelineRunner');
  const cronExpression = pipelineCron();

  if (cronExpression && cron.validate(cronExpression)) {
    cron.schedule(cronExpression, async () => {
      logger.info('PIPELINE', `Scheduled pipeline run triggered (cron: ${cronExpression})`);
      try {
        const runId = await runFullPipeline('cron');
        logger.info('PIPELINE', `Scheduled pipeline run completed: #${runId}`);
      } catch (err) {
        logger.error('PIPELINE', 'Scheduled pipeline run failed', { error: err.message });
      }
    });
    logger.info('SERVER', `Pipeline cron registered: ${cronExpression}`);
  } else if (cronExpression) {
    logger.warn('SERVER', `Invalid PIPELINE_CRON expression: "${cronExpression}" — pipeline cron NOT registered`);
  }

  // Instagram Inbox Reply Checker cron (runs every 30 minutes)
  const { checkInbox, checkFollowBacks } = require("../services/instagramReplyChecker");
  cron.schedule("*/30 * * * *", async () => {
    logger.info("SERVER", "Running scheduled Instagram checkInbox job...");
    try {
      await checkInbox();
      logger.info("SERVER", "Scheduled Instagram checkInbox job completed successfully.");
    } catch (err) {
      logger.error("SERVER", "Scheduled Instagram checkInbox job failed", err);
    }
  });
  logger.info("SERVER", "Instagram inbox checker cron registered: every 30 minutes");

  // Instagram Follow-Backs cron (runs at 4 AM daily)
  cron.schedule("0 4 * * *", async () => {
    logger.info("SERVER", "Running scheduled Instagram checkFollowBacks job...");
    try {
      const result = await checkFollowBacks();
      logger.info("SERVER", `Scheduled Instagram checkFollowBacks job completed. Found ${result.newFollowBacksCount || 0} new follow-backs.`);
    } catch (err) {
      logger.error("SERVER", "Scheduled Instagram checkFollowBacks job failed", err);
    }
  });
  logger.info("SERVER", "Instagram follow-backs cron registered: daily at 4:00 AM");

  // Campaign Connection Queue cron (runs every 20 minutes)
  cron.schedule("*/20 * * * *", async () => {
    logger.info("SERVER", "Running scheduled campaign Connection Queue cron job...");
    try {
      await runConnectionQueueJob();
      logger.info("SERVER", "Scheduled campaign Connection Queue job completed successfully.");
    } catch (err) {
      logger.error("SERVER", "Scheduled campaign Connection Queue job failed", err);
    }
  });
  logger.info("SERVER", "Campaign Connection Queue cron registered: every 20 minutes");

  // Campaign DM Queue cron (runs every 20 minutes with a 10-minute offset)
  cron.schedule("10,30,50 * * * *", async () => {
    logger.info("SERVER", "Running scheduled campaign DM Queue cron job...");
    try {
      await runDmQueueJob();
      logger.info("SERVER", "Scheduled campaign DM Queue job completed successfully.");
    } catch (err) {
      logger.error("SERVER", "Scheduled campaign DM Queue job failed", err);
    }
  });
  logger.info("SERVER", "Campaign DM Queue cron registered: every 20 minutes (staggered offset: 10m)");

  logger.info("SERVER", "Background automation worker initialized.");
}

if (require.main === module && process.env.DISABLE_BACKGROUND_JOBS !== "true") {
  startBackgroundJobs();
}

process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

module.exports = {
  startBackgroundJobs,
  isCampaignQueueInProgress: () => campaignQueueInProgress,
  __private: {
    runConnectionQueueJob,
    runDmQueueJob,
  }
};

