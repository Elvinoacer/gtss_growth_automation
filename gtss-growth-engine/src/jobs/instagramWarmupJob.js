const cron = require("node-cron");
const { getDb, getDailyActionCount, increment_action_count } = require("../db/database");
const {
  getLeadsDueForStep,
  advanceWarmupStep,
} = require("../automation/instagramWarmup");
const { unfollowAccount } = require("../automation/instagram");
const {
  createInstagramBrowser,
  closeBrowserContext,
  dailySessionWarmup,
  humanDelay,
} = require("../automation/browserBase");
const limits = require("../config/limits");
const logger = require("../utils/logger");

function safeEmit(emitter, type, message, data = {}) {
  if (typeof emitter === "function") {
    try {
      emitter(type, message, data);
    } catch (_) {}
  } else if (emitter && typeof emitter.emit === "function") {
    try {
      emitter.emit(type, { message, ...data });
    } catch (_) {}
  }
}

/**
 * Runs the active Instagram warmup sequence executor.
 * Processes up to 5 due leads per job execution.
 *
 * @param {Function} emitter - Optional orchestration logger.
 * @returns {Promise<Object>} Summary of execution outcomes.
 */
async function run(emitter) {
  const db = getDb();
  const igLimits = limits.instagram || { follows: 20, likes: 15, dms: 15 };

  // 1. Check total Instagram actions performed today
  const followsCount = getDailyActionCount("instagram", "follows");
  const likesCount = getDailyActionCount("instagram", "likes");
  const totalActions = followsCount + likesCount;
  const maxAllowedActions = igLimits.follows + igLimits.likes;

  if (totalActions >= maxAllowedActions) {
    logger.info(
      "INSTAGRAM_WARMUP",
      `Skipping job run: today's IG actions (${totalActions}) reached maximum limit (${maxAllowedActions})`
    );
    safeEmit(
      emitter,
      "info",
      `Skipping warmup job: today's IG actions reached limits (${totalActions}/${maxAllowedActions})`
    );
    return { success: true, skipped: true, reason: "daily_limit_hit" };
  }

  // 2. Load all due leads
  const dueLeads = getLeadsDueForStep();
  if (dueLeads.length === 0) {
    logger.info("INSTAGRAM_WARMUP", "No Instagram leads due for warmup steps.");
    safeEmit(emitter, "info", "No Instagram leads due for warmup steps.");
    return { success: true, processedCount: 0 };
  }

  // Slice to max 5 targets per job run
  const targets = dueLeads.slice(0, 5);
  logger.info(
    "INSTAGRAM_WARMUP",
    `Found ${dueLeads.length} leads due. Processing batch of ${targets.length}...`
  );
  safeEmit(
    emitter,
    "info",
    `Processing ${targets.length} Instagram warmup sequences...`
  );

  let browserState = null;
  let processedCount = 0;
  let succeededCount = 0;
  let failedCount = 0;

  let activeFollowsCount = followsCount;
  let activeLikesCount = likesCount;

  try {
    // 3. Launch headed browser
    browserState = await createInstagramBrowser();
    const page = browserState.page;

    // 4. Run organic session warmup ONCE per session
    logger.info("INSTAGRAM_WARMUP", "Performing organic session warmup...");
    safeEmit(emitter, "info", "Performing organic session warmup...");
    try {
      await dailySessionWarmup(page);
    } catch (warmupErr) {
      logger.warn(
        "INSTAGRAM_WARMUP",
        `Organic session warmup failed: ${warmupErr.message}`
      );
    }

    // 5. Execute warmup steps for each target lead
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const { leadId, username, nextStep } = target;

      // Double-check specific action limit before executing
      if (nextStep === "follow" && activeFollowsCount >= igLimits.follows) {
        logger.warn(
          "INSTAGRAM_WARMUP",
          `Skipping follow step for @${username} (daily follow limit reached)`
        );
        safeEmit(
          emitter,
          "warn",
          `Skipping follow step for @${username} (daily follow limit reached)`
        );
        continue;
      }
      if (nextStep === "like" && activeLikesCount >= igLimits.likes) {
        logger.warn(
          "INSTAGRAM_WARMUP",
          `Skipping like step for @${username} (daily like limit reached)`
        );
        safeEmit(
          emitter,
          "warn",
          `Skipping like step for @${username} (daily like limit reached)`
        );
        continue;
      }

      processedCount++;
      try {
        const res = await advanceWarmupStep(page, { leadId }, emitter);
        if (res && res.success) {
          succeededCount++;
          if (res.stepExecuted === "follow") {
            activeFollowsCount++;
          } else if (res.stepExecuted === "like") {
            activeLikesCount++;
          }
        } else {
          failedCount++;
        }
      } catch (stepErr) {
        failedCount++;
        logger.error(
          "INSTAGRAM_WARMUP",
          `Warmup execution failed for @${username}`,
          stepErr
        );
      }

      // Natural human-like Nairobi delay between leads
      if (i < targets.length - 1) {
        logger.info(
          "INSTAGRAM_WARMUP",
          "Applying natural delay between warmup targets..."
        );
        await humanDelay(45000, 120000);
      }
    }
  } catch (err) {
    logger.error("INSTAGRAM_WARMUP", "Fatal error during warmup job run", err);
    safeEmit(emitter, "error", `Fatal warmup job error: ${err.message}`);
    throw err;
  } finally {
    // 6. Ensure browser context is cleanly closed
    if (browserState) {
      logger.info("INSTAGRAM_WARMUP", "Closing Instagram warmup browser...");
      await closeBrowserContext("instagram", browserState);
    }
  }

  logger.info(
    "INSTAGRAM_WARMUP",
    `Warmup execution completed. Processed: ${processedCount}, Succeeded: ${succeededCount}, Failed: ${failedCount}`
  );
  safeEmit(
    emitter,
    "done",
    `Warmup completed. Succeeded: ${succeededCount}/${processedCount}`
  );

  return {
    success: true,
    processedCount,
    succeededCount,
    failedCount,
  };
}

/**
 * Scan for and unfollow eligible leads based on aging thresholds.
 *
 * @param {Function} emitter - Optional orchestration logger.
 * @returns {Promise<Object>} Summary of execution outcomes.
 */
async function processUnfollows(emitter) {
  const db = getDb();
  const dailyUnfollowLimit = (limits.instagram && limits.instagram.unfollows) || 15;

  // 1. Count today's unfollow actions on Instagram
  const unfollowsCountToday = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM daily_actions
      WHERE platform = 'instagram'
        AND (action_type = 'unfollow' OR action_type = 'unfollows')
        AND DATE(performed_at) = DATE('now', 'localtime')
    `
    )
    .get().count;

  if (unfollowsCountToday >= dailyUnfollowLimit) {
    logger.info(
      "INSTAGRAM_UNFOLLOW",
      `Skipping unfollow scans: today's unfollows (${unfollowsCountToday}) reached daily limit (${dailyUnfollowLimit})`
    );
    safeEmit(
      emitter,
      "info",
      `Skipping unfollow scans: today's unfollow limit reached (${unfollowsCountToday}/${dailyUnfollowLimit})`
    );
    return { success: true, skipped: true, reason: "daily_limit_hit" };
  }

  const capacity = dailyUnfollowLimit - unfollowsCountToday;

  // 2. Query candidates from ig_follow_tracker
  const candidates = db
    .prepare(
      `
      SELECT * FROM ig_follow_tracker
      WHERE eligible_for_unfollow = 1
        AND (
          (status = 'following' AND followed_at <= datetime('now', '-30 days'))
          OR
          (status = 'requested' AND followed_at <= datetime('now', '-14 days'))
        )
      ORDER BY followed_at ASC
    `
    )
    .all();

  if (candidates.length === 0) {
    logger.info("INSTAGRAM_UNFOLLOW", "No eligible unfollow candidates found.");
    safeEmit(emitter, "info", "No eligible unfollow candidates found.");
    return { success: true, processedCount: 0 };
  }

  // Slice to remaining daily capacity
  const targets = candidates.slice(0, capacity);
  logger.info(
    "INSTAGRAM_UNFOLLOW",
    `Found ${candidates.length} unfollow candidates. Executing unfollows on batch of ${targets.length}...`
  );
  safeEmit(
    emitter,
    "info",
    `Executing ${targets.length} Instagram unfollows...`
  );

  let browserState = null;
  let processedCount = 0;
  let succeededCount = 0;
  let failedCount = 0;

  try {
    // 3. Launch headed browser
    browserState = await createInstagramBrowser();
    const page = browserState.page;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const { lead_id, username } = target;

      processedCount++;
      try {
        logger.info(
          "INSTAGRAM_UNFOLLOW",
          `Attempting to unfollow @${username} (lead #${lead_id})`
        );
        const res = await unfollowAccount(page, { username }, emitter);
        if (res && res.success) {
          succeededCount++;

          // Update ig_follow_tracker status
          db.prepare(
            `
            UPDATE ig_follow_tracker
            SET status = 'unfollowed',
                unfollowed_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `
          ).run(target.id);

          // Record action in daily_actions
          increment_action_count('instagram', 'unfollow', lead_id, 'sent');
        } else {
          failedCount++;
          logger.warn(
            "INSTAGRAM_UNFOLLOW",
            `Unfollow failed for @${username}: ${res ? res.error : "unknown"}`
          );
        }
      } catch (err) {
        failedCount++;
        logger.error(
          "INSTAGRAM_UNFOLLOW",
          `Unfollow process failed for @${username}`,
          err
        );
      }

      // Natural Nairobi delay between unfollows
      if (i < targets.length - 1) {
        logger.info(
          "INSTAGRAM_UNFOLLOW",
          "Applying delay between unfollow targets..."
        );
        await humanDelay(45000, 120000);
      }
    }
  } catch (err) {
    logger.error("INSTAGRAM_UNFOLLOW", "Fatal error during unfollow job run", err);
    safeEmit(emitter, "error", `Fatal unfollow job error: ${err.message}`);
    throw err;
  } finally {
    if (browserState) {
      logger.info("INSTAGRAM_UNFOLLOW", "Closing Instagram unfollow browser...");
      await closeBrowserContext("instagram", browserState);
    }
  }

  logger.info(
    "INSTAGRAM_UNFOLLOW",
    `Unfollow execution completed. Processed: ${processedCount}, Succeeded: ${succeededCount}, Failed: ${failedCount}`
  );
  safeEmit(
    emitter,
    "done",
    `Unfollows completed. Succeeded: ${succeededCount}/${processedCount}`
  );

  return {
    success: true,
    processedCount,
    succeededCount,
    failedCount,
  };
}

/**
 * Initializes and schedules the warmup sequence & unfollow node-cron jobs.
 * Warmup sequence cron: every 4 hours
 * Unfollow scanner cron: daily at 8 PM
 */
function initInstagramWarmupJobs() {
  logger.info(
    "INSTAGRAM_JOBS",
    "Initializing Instagram Warmup & Unfollow background cron jobs (Africa/Nairobi timezone context)"
  );

  // 1. Warmup Cron: runs every 4 hours
  cron.schedule(
    "0 */4 * * *",
    async () => {
      logger.info("Cron triggered: Starting Instagram warmup sequence processing...");
      try {
        await run(() => {});
      } catch (err) {
        logger.error(
          "INSTAGRAM_JOBS",
          `Scheduled warmup sequence job failed: ${err.message}`
        );
      }
    },
    {
      noOverlap: true,
      name: "ig-warmup",
    }
  );

  // 2. Unfollow Cron: runs daily at 8 PM (20:00)
  cron.schedule(
    "0 20 * * *",
    async () => {
      logger.info("Cron triggered: Starting Instagram unfollow scanner...");
      try {
        await processUnfollows(() => {});
      } catch (err) {
        logger.error(
          "INSTAGRAM_JOBS",
          `Scheduled unfollow scanner job failed: ${err.message}`
        );
      }
    },
    {
      noOverlap: true,
      name: "ig-unfollow",
    }
  );
}

module.exports = {
  run,
  processUnfollows,
  initInstagramWarmupJobs,
};
