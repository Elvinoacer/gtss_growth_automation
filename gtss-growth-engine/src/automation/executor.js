const {
  getDb,
  isWithinLimit: dbIsWithinLimit,
  normalizeActionType,
  increment_action_count,
} = require("../db/database");
const {
  createBrowser,
  closeBrowser,
  humanDelay,
  detectCaptcha,
  checkSessionState,
  AUTH_STATES,
  captureFailureArtifact,
} = require("./browserBase");
const { isSessionValid } = require("./sessionManager");
const { startJob, updateJobStatus, recordEvent } = require("./journal");
const { reserveAction, releaseActionFingerprint } = require("./idempotency");
const logger = require("../utils/logger");
const { broadcast } = require("../services/socketService");

const STOP_FLAGS = new Map();
let ACTIVE_JOB_ID = null;
let RUN_QUEUE = Promise.resolve();
const MAX_AUTO_RETRIES = 3;

async function interruptibleDelay(minMs, maxMs, jobId) {
  const targetMs = Math.floor(Math.random() * (maxMs - minMs) + minMs);
  const stepMs = 500;
  let elapsed = 0;
  while (elapsed < targetMs) {
    if (STOP_FLAGS.get(jobId)) return;
    const waitMs = Math.min(stepMs, targetMs - elapsed);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    elapsed += waitMs;
  }
}

function createEmitter(sseRes) {
  return (type, message, data = {}) => {
    const payload = {
      type,
      message,
      timestamp: new Date().toISOString(),
      ...data,
    };

    // Broadcast via Socket.IO to all connected clients
    broadcast("automation:log", payload);

    // Also broadcast queue/limits refresh signals on state changes
    if (["state", "done", "error", "info"].includes(type)) {
      broadcast("automation:refresh", { type });
    }

    // Legacy SSE stream
    if (sseRes) {
      sseRes.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };
}

function stopJob(jobId) {
  if (STOP_FLAGS.has(jobId)) {
    STOP_FLAGS.set(jobId, true);
    return true;
  }
  return false;
}

function stopAllJobs() {
  for (const jobId of STOP_FLAGS.keys()) {
    STOP_FLAGS.set(jobId, true);
  }
}

function emitState(emit, jobId, status, message, details = {}) {
  updateJobStatus(jobId, status, details);
  recordEvent({
    jobId,
    status,
    platform: details.platform,
    actionType: details.actionType,
    target: details.target,
    messageId: details.messageId,
    leadId: details.leadId,
    warningDetected: details.warningDetected,
    details,
  });
  emit("state", message || status, { status, ...details });
}

/**
 * Robust check for daily limits.
 */
function isWithinLimit(platform, actionType) {
  // Always fetch fresh limit from config to ensure we don't exceed even if settings change
  return dbIsWithinLimit(platform, actionType);
}

function getQueuedActions(options = {}) {
  const db = getDb();
  const includeBlocked = options.includeBlocked === true;
  const includeWaiting = options.includeWaiting === true;
  const platforms = Array.isArray(options.platforms)
    ? options.platforms
        .map((platform) => String(platform).trim().toLowerCase())
        .filter(Boolean)
    : [];
  const platformClause =
    platforms.length > 0
      ? `AND m.platform IN (${platforms.map(() => "?").join(",")})`
      : "";
  return db
    .prepare(
      `
    SELECT m.id AS message_id, m.platform, m.body, m.variant, m.is_follow_up, m.lead_id,
           m.status, m.snooze_until, m.retry_count, m.last_error, m.blocked_reason, m.fail_category, m.action_type,
           CASE
             WHEN m.status = 'approved' AND (m.snooze_until IS NULL OR m.snooze_until <= datetime('now')) THEN 1
             ELSE 0
           END AS runnable,
           l.name AS lead_name, l.profile_url, l.status AS lead_status
    FROM messages m
    JOIN leads l ON m.lead_id = l.id
    WHERE (
      (m.status = 'approved' ${includeWaiting ? "" : "AND (m.snooze_until IS NULL OR m.snooze_until <= datetime('now'))"})
      ${includeBlocked ? "OR m.status = 'blocked'" : ""}
    )
    ${platformClause}
    ORDER BY
      CASE
        WHEN m.status = 'approved' AND (m.snooze_until IS NULL OR m.snooze_until <= datetime('now')) THEN 0
        WHEN m.status = 'approved' THEN 1
        WHEN m.status = 'blocked' THEN 2
        ELSE 3
      END,
      m.approved_at ASC
  `,
    )
    .all(...platforms)
    .map((action) => ({
      ...action,
      action_type: action.action_type || determineActionType(action),
      runnable: Boolean(action.runnable),
    }));
}

function classifyOutcome(outcome, reason) {
  if (outcome === "sent") return null;
  if (outcome === "premium_required") return "premium_required";
  if (outcome === "not_connected") return "not_connected";
  if (outcome === "session_required") return "session_expired";
  if (outcome === "limit_reached") return "rate_limited";
  if (outcome === "failed") {
    return /captcha/i.test(String(reason || "")) ? "captcha" : "send_failed";
  }
  if (
    outcome === "already_connected" ||
    outcome === "no_posts" ||
    outcome === "skipped"
  ) {
    return null;
  }
  return "unknown";
}

function retryDelayMinutes(retryCount) {
  return Math.min(Math.max(retryCount, 1) * 60, 1440);
}

function getSettingValue(key) {
  return getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key)
    ?.value;
}

function isTruthyConfig(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function getLinkedInOutreachMode() {
  const configured =
    process.env.LINKEDIN_OUTREACH_MODE ||
    (isTruthyConfig(process.env.LINKEDIN_DIRECT_DM_FIRST)
      ? "dm_first"
      : null) ||
    getSettingValue("linkedin_outreach_mode");

  if (configured === "dm_only" || configured === "dm_first") return configured;
  return "connect_first";
}

function getXOutreachMode() {
  const configured =
    process.env.X_OUTREACH_MODE || getSettingValue("x_outreach_mode");

  if (configured === "dm_only" || configured === "dm_first") return configured;
  return "follow_first";
}

function determineActionType(message) {
  if (message.is_follow_up) return "dm";

  if (message.platform === "linkedin") {
    const outreachMode = getLinkedInOutreachMode();
    if (outreachMode === "dm_only" || outreachMode === "dm_first") return "dm";

    // Check if a connection request was already sent to this lead
    const db = getDb();
    const priorConnect = db
      .prepare(
        `
      SELECT id FROM touchpoints
      WHERE lead_id = ? AND type = 'connections' AND outcome = 'sent'
      LIMIT 1
    `,
      )
      .get(message.lead_id);

    return priorConnect ? "dm" : "connect";
  }

  if (message.platform === "x") {
    const outreachMode = getXOutreachMode();
    if (outreachMode === "dm_only" || outreachMode === "dm_first") return "dm";

    // Check if a follow was already sent to this lead
    const db = getDb();
    const priorFollow = db
      .prepare(
        `
      SELECT id FROM touchpoints
      WHERE lead_id = ? AND type = 'follows' AND outcome = 'sent'
      LIMIT 1
    `,
      )
      .get(message.lead_id);

    return priorFollow ? "dm" : "follow";
  }

  return "dm";
}

async function runAutomationAction(action, browserState, emit) {
  const { platform } = action;
  const actionType = action.action_type || determineActionType(action);

  // Handle specific Instagram actions directly via switch routing
  if (platform === "instagram") {
    const instagram = require("./instagram");
    const instagramWarmup = require("./instagramWarmup");
    const { page } = browserState;
    const limits = require("../config/limits");

    const normalized = normalizeActionType(actionType);
    const hasLimit =
      limits.instagram && typeof limits.instagram[normalized] === "number";
    if (hasLimit && !isWithinLimit("instagram", actionType)) {
      emit("warn", `Instagram action ${actionType} limit reached. Skipping.`);
      return {
        outcome: "skipped",
        reason: `Daily limit reached for instagram ${actionType}`,
      };
    }

    // Extract username from profile_url
    const username = action.profile_url
      ? action.profile_url.replace(/\/$/, "").split("/").pop()
      : "";

    switch (actionType) {
      case "instagram_dm": {
        const result = await instagram.sendDM(
          page,
          { username, message: action.body },
          emit,
        );
        return {
          outcome: result.success ? "sent" : "failed",
          reason: result.error || null,
          isMessageRequest: result.isMessageRequest,
        };
      }
      case "instagram_follow": {
        const result = await instagram.followAccount(page, { username }, emit);
        return {
          outcome: result.success ? "sent" : "failed",
          reason: result.error || null,
        };
      }
      case "instagram_like": {
        const result = await instagram.likeRecentPost(page, { username }, emit);
        return {
          outcome: result.success ? "sent" : "failed",
          reason: result.error || null,
        };
      }
      case "instagram_story_view": {
        const result = await instagram.viewStory(page, { username }, emit);
        return {
          outcome: result.success ? "sent" : "failed",
          reason: result.error || null,
        };
      }
      case "instagram_warmup_advance": {
        const result = await instagramWarmup.advanceWarmupStep(
          page,
          { leadId: action.lead_id },
          emit,
        );
        return {
          outcome: result.success ? "sent" : "failed",
          reason: result.error || null,
        };
      }
    }
  }

  let automationModule;

  try {
    automationModule = require(`./${platform}`);
  } catch (err) {
    emit("error", `Automation module for ${platform} not implemented.`);
    return { outcome: "failed", reason: "Module not implemented" };
  }

  const { page } = browserState;

  if (
    (actionType === "connect" || actionType === "follow") &&
    (automationModule.sendConnectionRequest || automationModule.followUser)
  ) {
    if (automationModule.likeRecentPost) {
      emit("info", "Warming up: liking a recent post...");
      await automationModule.likeRecentPost(page, action.profile_url, emit);
      await humanDelay(3000, 6000);
    }
    if (actionType === "follow" && automationModule.followUser) {
      return await automationModule.followUser(page, action.profile_url, emit);
    }
    return await automationModule.sendConnectionRequest(
      page,
      action.profile_url,
      action.body,
      emit,
    );
  } else if (actionType === "dm" && automationModule.sendDirectMessage) {
    // Bug #6 fix: bring the automation tab to front at the architecture level
    // before handing the page to any platform module. This is belt-and-suspenders
    // for platforms that may not call bringToFront internally — every DM action
    // gets it for free, so no platform module can forget it.
    const { page: dmPage } = browserState;
    if (dmPage && typeof dmPage.bringToFront === "function") {
      await dmPage.bringToFront().catch(() => {});
      await new Promise((r) => setTimeout(r, 150));
    }
    return await automationModule.sendDirectMessage(
      page,
      action.profile_url,
      action.body,
      emit,
      action.lead_name || null,
    );
  } else {
    emit("error", `Action ${actionType} not supported for ${platform}.`);
    return { outcome: "failed", reason: "Unsupported action" };
  }
}

function recordOutcome(action, actionType, outcomeObj) {
  const db = getDb();
  const { outcome, reason } = outcomeObj;
  const normalizedActionType = normalizeActionType(actionType);
  const failCategory = classifyOutcome(outcome, reason);
  const retryCount = Number(action.retry_count || 0);

  const logLevel = outcome === "sent" ? "info" : "warn";
  logger[logLevel]("EXECUTOR", "Action outcome classified", {
    messageId: action.message_id,
    leadId: action.lead_id,
    platform: action.platform,
    actionType: normalizedActionType,
    outcome,
    failCategory,
    retryCount,
    reason: String(reason || "").slice(0, 200),
  });

  increment_action_count(
    action.platform,
    normalizedActionType,
    action.lead_id,
    outcome,
    reason || null,
  );

  db.prepare(
    `
    INSERT INTO touchpoints (lead_id, type, platform, message_id, outcome, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    action.lead_id,
    normalizedActionType,
    action.platform,
    action.message_id,
    outcome,
    reason || null,
  );

  if (outcome === "sent") {
    db.prepare(
      `UPDATE messages
       SET status = 'sent',
           sent_at = CURRENT_TIMESTAMP,
           retry_count = 0,
           last_error = NULL,
           blocked_reason = NULL,
           fail_category = NULL,
           snooze_until = NULL
       WHERE id = ?`,
    ).run(action.message_id);

    // For LinkedIn connect and X follow actions, queue the DM body as a new pending message
    // so it fires once the connection or follow is complete (on the next queue run)
    if (
      normalizedActionType === "connections" ||
      normalizedActionType === "follows"
    ) {
      const originalMessage = db
        .prepare(`SELECT * FROM messages WHERE id = ?`)
        .get(action.message_id);
      if (originalMessage) {
        const existing = db
          .prepare(
            `
          SELECT id FROM messages
          WHERE lead_id = ? AND status IN ('pending','approved') AND is_follow_up = 0
          LIMIT 1
        `,
          )
          .get(action.lead_id);

        if (!existing) {
          // Add a 1-hour delay/snooze for X follows to prevent immediate bot-like direct messaging
          const snoozeDelay =
            action.platform === "x" ? "datetime('now', '+1 hour')" : "NULL";
          db.prepare(
            `
            INSERT INTO messages (lead_id, platform, body, variant, is_follow_up, status, snooze_until, generated_at)
            VALUES (?, ?, ?, 'A', 0, 'pending', ${snoozeDelay}, CURRENT_TIMESTAMP)
          `,
          ).run(action.lead_id, action.platform, originalMessage.body);
        }
      }
    }

    const lead = db
      .prepare(`SELECT status FROM leads WHERE id = ?`)
      .get(action.lead_id);
    if (
      lead &&
      ["discovered", "qualified", "deprioritized", "scoring_failed"].includes(
        lead.status,
      )
    ) {
      db.prepare(
        `UPDATE leads SET status = 'messaged', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).run(action.lead_id);
    }
  } else if (outcome === "already_connected" || outcome === "no_posts") {
    db.prepare(
      `
      UPDATE messages
      SET status = 'skipped',
          last_error = ?,
          blocked_reason = NULL,
          fail_category = NULL,
          snooze_until = NULL
      WHERE id = ?
    `,
    ).run(reason || outcome, action.message_id);
  } else if (outcome === "skipped") {
    db.prepare(
      `
      UPDATE messages
      SET status = 'approved',
          fail_category = NULL,
          blocked_reason = NULL,
          last_error = ?,
          snooze_until = datetime('now', '+1 hour')
      WHERE id = ?
    `,
    ).run(reason || "Skipped", action.message_id);
  } else if (
    failCategory === "premium_required" ||
    failCategory === "captcha"
  ) {
    db.prepare(
      `
      UPDATE messages
      SET status = 'blocked',
          fail_category = ?,
          blocked_reason = ?,
          last_error = ?,
          snooze_until = NULL
      WHERE id = ?
    `,
    ).run(
      failCategory,
      failCategory,
      reason || failCategory,
      action.message_id,
    );
  } else if (failCategory === "not_connected") {
    db.prepare(
      `
      UPDATE messages
      SET status = 'approved',
          fail_category = ?,
          blocked_reason = NULL,
          last_error = ?,
          snooze_until = datetime('now', '+24 hours')
      WHERE id = ?
    `,
    ).run(failCategory, reason || failCategory, action.message_id);
  } else if (failCategory === "rate_limited") {
    db.prepare(
      `
      UPDATE messages
      SET status = 'approved',
          fail_category = ?,
          blocked_reason = NULL,
          last_error = ?,
          snooze_until = date('now', 'localtime', '+1 day')
      WHERE id = ?
    `,
    ).run(failCategory, reason || failCategory, action.message_id);
  } else {
    const nextRetryCount = retryCount + 1;
    if (nextRetryCount > MAX_AUTO_RETRIES) {
      db.prepare(
        `
        UPDATE messages
        SET status = 'blocked',
            retry_count = ?,
            fail_category = ?,
            blocked_reason = 'max_retries_exceeded',
            last_error = ?,
            snooze_until = NULL
        WHERE id = ?
      `,
      ).run(
        nextRetryCount,
        failCategory || "unknown",
        reason || "Publish failed",
        action.message_id,
      );
    } else {
      db.prepare(
        `
        UPDATE messages
        SET status = 'approved',
            retry_count = ?,
            fail_category = ?,
            blocked_reason = NULL,
            last_error = ?,
            snooze_until = datetime('now', '+' || ? || ' minutes')
        WHERE id = ?
      `,
      ).run(
        nextRetryCount,
        failCategory || "unknown",
        reason || "Publish failed",
        retryDelayMinutes(nextRetryCount),
        action.message_id,
      );
    }
  }
}

function parseDelayRange(value, fallback) {
  if (!value) return fallback;
  const parts = String(value)
    .split(",")
    .map((part) => Number(part.trim()));
  if (parts.length !== 2 || parts.some((part) => Number.isNaN(part)))
    return fallback;
  return {
    min: Math.min(parts[0], parts[1]),
    max: Math.max(parts[0], parts[1]),
  };
}

function getActionDelayRange(platform, actionType) {
  const platformKey = `${platform}_${actionType}_DELAY_MS`.toUpperCase();
  return parseDelayRange(
    process.env[platformKey] || process.env.AUTOMATION_ACTION_DELAY_MS,
    { min: 60_000, max: 180_000 },
  );
}

async function closeBrowserState(browserState, platform) {
  if (!browserState) return;
  await closeBrowser(browserState.browser, platform, browserState.context, {
    mode: browserState.mode,
    tracePath: browserState.tracePath,
    shouldCloseBrowser: browserState.shouldCloseBrowser,
    shouldClosePageOnly: browserState.shouldClosePageOnly,
    page: browserState.page,
    lock: browserState.lock,
  });
}

function getPageUrl(page) {
  try {
    return String(page.url()).toLowerCase();
  } catch (_) {
    return "";
  }
}

function isManualAuthComplete(page, platform) {
  const url = getPageUrl(page);
  if (!url) return false;

  if (platform === "linkedin") return url.includes("/feed");
  if (platform === "x") return url.includes("/home");
  if (platform === "facebook") {
    return (
      url.includes("facebook.com") &&
      !url.includes("/login") &&
      !url.includes("/checkpoint") &&
      !url.includes("/recover") &&
      !url.includes("/two_factor") &&
      !url.includes("/r.php")
    );
  }
  if (platform === "instagram") {
    return (
      url.includes("instagram.com") &&
      !url.includes("/accounts/login") &&
      !url.includes("/challenge") &&
      !url.includes("/two_factor") &&
      !url.includes("/accounts/onetap")
    );
  }

  return (
    !url.includes("/login") &&
    !url.includes("/checkpoint") &&
    !url.includes("/challenge")
  );
}

function getSessionCheckUrl(platform) {
  if (platform === "linkedin") return "https://www.linkedin.com/feed/";
  if (platform === "x") return "https://x.com/home";
  return `https://www.${platform}.com`;
}

async function openSessionCheckPage(page, platform) {
  const url = getSessionCheckUrl(platform);
  const waitUntil = "domcontentloaded";

  await page.goto(url, { waitUntil, timeout: 60000 }).catch(async (error) => {
    logger.warn(
      "AUTOMATION",
      `Session check navigation did not fully settle for ${platform}`,
      {
        error: error.message,
        url,
      },
    );
    if (!page.isClosed() && page.url() !== url) {
      await page
        .goto(url, { waitUntil: "domcontentloaded", timeout: 30000 })
        .catch(() => {});
    }
  });

  if (platform === "linkedin") {
    await humanDelay(1000, 1800);
  }
}

function maxSessionRecoveryAttempts() {
  const configured = Number(process.env.MAX_SESSION_RECOVERY_ATTEMPTS || 2);
  return Number.isFinite(configured) && configured >= 0 ? configured : 2;
}

async function createValidatedBrowser(platform, emit) {
  const attempts = maxSessionRecoveryAttempts() + 1;
  let lastState = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let browserState = null;
    try {
      browserState = await createBrowser(platform);
      await openSessionCheckPage(browserState.page, platform);

      lastState = await checkSessionState(browserState.page, platform, emit, {
        label: `session-check-attempt-${attempt}`,
      });

      if (lastState.state === AUTH_STATES.AUTHENTICATED) {
        return { browserState, authState: lastState };
      }

      if (attempt < attempts) {
        emit(
          "warn",
          `${platform} auth check returned ${lastState.state}; retrying session recovery (${attempt}/${attempts - 1}).`,
          {
            platform,
            authState: lastState.state,
            reason: lastState.reason,
          },
        );
        await browserState.page
          .reload({
            waitUntil: "domcontentloaded",
            timeout: 60000,
          })
          .catch(() => {});
        await humanDelay(1200, 2200);
      }
    } finally {
      if (
        browserState &&
        (!lastState || lastState.state !== AUTH_STATES.AUTHENTICATED)
      ) {
        await closeBrowserState(browserState, platform);
      }
    }
  }

  return { browserState: null, authState: lastState };
}

async function processActionQueue(jobId, sseRes, options = {}) {
  const emit = createEmitter(sseRes);

  if (ACTIVE_JOB_ID) {
    emit(
      "error",
      `Automation run ${ACTIVE_JOB_ID} is already active. Stop it before starting another run.`,
    );
    if (sseRes) sseRes.end();
    return;
  }

  ACTIVE_JOB_ID = jobId;
  STOP_FLAGS.set(jobId, false);
  startJob(jobId, { source: "automation_queue" });

  emit("info", `Starting automation run (Job ID: ${jobId})`);
  emitState(emit, jobId, "PENDING", "Automation run queued.");

  try {
    const platforms = Array.isArray(options.platforms)
      ? options.platforms
          .map((platform) => String(platform).trim().toLowerCase())
          .filter(Boolean)
      : [];
    const runnableQueue = getQueuedActions({ platforms });
    const fullQueue = getQueuedActions({
      includeBlocked: true,
      includeWaiting: true,
      platforms,
    });
    const waitingCount = fullQueue.filter(
      (action) => action.status === "approved" && !action.runnable,
    ).length;
    const blockedCount = fullQueue.filter(
      (action) => action.status === "blocked",
    ).length;

    emit("info", `Found ${runnableQueue.length} runnable action(s).`);

    if (runnableQueue.length === 0) {
      const summary =
        fullQueue.length === 0
          ? "Queue is empty — no actions pending."
          : `Nothing runnable right now. ${waitingCount} waiting (snoozed), ${blockedCount} blocked (manual action required).`;
      emitState(emit, jobId, "COMPLETED", summary, {
        queueLength: fullQueue.length,
        runnableCount: 0,
        waitingCount,
        blockedCount,
      });
      emit("done", summary, {
        queueLength: fullQueue.length,
        runnableCount: 0,
        waitingCount,
        blockedCount,
      });
      return {
        successes: 0,
        failures: 0,
        skipped: 0,
        queueLength: fullQueue.length,
        runnableCount: 0,
        waitingCount,
        blockedCount,
      };
    }

    let successes = 0;
    let failures = 0;
    let skipped = 0;
    // Consecutive failure counter for circuit breaker. Reset on any success
    // or non-failure outcome (skipped, premium_required, etc.). If this hits
    // MAX_CONSECUTIVE_FAILURES (defined inside the loop), the run aborts.
    let consecutiveFailures = 0;
    const maxDmsPerRun = options.maxDmsPerRun;
    const maxConnectionsPerRun = options.maxConnectionsPerRun;
    let dmsSentThisRun = 0;
    let connectionsSentThisRun = 0;

    // Cache one browser/tab per platform — reuse across all actions in this run
    const browserCache = new Map();

    async function getOrCreateBrowser(plat, emitFn, evtBase, fp) {
      if (browserCache.has(plat)) {
        const cached = browserCache.get(plat);
        if (cached.page && !cached.page.isClosed())
          return { browserState: cached };
        browserCache.delete(plat);
      }
      emitState(
        emitFn,
        jobId,
        "STARTING_BROWSER",
        `Starting browser for ${plat}.`,
        { ...evtBase, fingerprint: fp },
      );
      emitState(emitFn, jobId, "AUTH_CHECK", `Checking ${plat} session.`, {
        ...evtBase,
        fingerprint: fp,
      });
      const validated = await createValidatedBrowser(plat, emitFn);
      if (validated.browserState)
        browserCache.set(plat, validated.browserState);
      return validated;
    }

    async function closeAllCachedBrowsers() {
      for (const [plat, state] of browserCache) {
        try {
          await closeBrowserState(state, plat);
        } catch (e) {
          logger.warn("AUTOMATION", `Failed to close browser for ${plat}`, {
            error: e.message,
          });
        }
      }
      browserCache.clear();
    }

    for (const action of runnableQueue) {
      if (STOP_FLAGS.get(jobId)) {
        emit("warn", "Automation stopped by user.");
        emitState(
          emit,
          jobId,
          "MANUAL_INTERVENTION_REQUIRED",
          "Automation stopped by user.",
        );
        break;
      }

      const { platform } = action;
      const actionType = determineActionType(action);
      const isDm = actionType === "dm" || actionType === "instagram_dm";
      const isConnection =
        actionType === "connect" || actionType === "connection";

      if (
        isDm &&
        typeof maxDmsPerRun === "number" &&
        dmsSentThisRun >= maxDmsPerRun
      ) {
        emit(
          "info",
          `Stopping DM actions: hit max_dms_per_run cap of ${maxDmsPerRun}.`,
        );
        break;
      }
      if (
        isConnection &&
        typeof maxConnectionsPerRun === "number" &&
        connectionsSentThisRun >= maxConnectionsPerRun
      ) {
        emit(
          "info",
          `Stopping connection actions: hit max_connections_per_run cap of ${maxConnectionsPerRun}.`,
        );
        break;
      }

      const eventBase = {
        platform,
        actionType,
        target: action.profile_url,
        messageId: action.message_id,
        leadId: action.lead_id,
      };

      // 1. Double check limits right before action
      if (!isWithinLimit(platform, actionType)) {
        emit(
          "warn",
          `Daily limit reached for ${platform} ${actionType}. Will retry tomorrow.`,
        );
        emitState(
          emit,
          jobId,
          "RATE_LIMITED",
          `Daily limit reached for ${platform} ${actionType}.`,
          eventBase,
        );
        // Snooze until midnight so it re-queues on the next calendar day
        const db = getDb();
        db.prepare(
          `
          UPDATE messages
          SET snooze_until = date('now', 'localtime', '+1 day')
          WHERE id = ?
        `,
        ).run(action.message_id);
        skipped++;
        continue;
      }

      if (!isSessionValid(platform)) {
        emit("error", `No valid session for ${platform}. Please re-auth.`);
        emitState(
          emit,
          jobId,
          "MANUAL_INTERVENTION_REQUIRED",
          `No valid session for ${platform}.`,
          eventBase,
        );
        failures++;
        continue;
      }

      const reservation = reserveAction(action, actionType);
      if (!reservation.reserved) {
        emit(
          "warn",
          `Duplicate ${platform} ${actionType} skipped: ${reservation.reason}`,
        );
        emitState(emit, jobId, "COMPLETED", "Duplicate action skipped.", {
          ...eventBase,
          fingerprint: reservation.fingerprint,
          reason: reservation.reason,
        });

        // Snooze until the fingerprint expires so we don't re-check every hour
        const existingFp = getDb()
          .prepare(
            `SELECT expires_at FROM action_fingerprints WHERE fingerprint = ?`,
          )
          .get(reservation.fingerprint);

        const snoozeUntil =
          existingFp?.expires_at ?? `datetime('now', '+7 days')`;
        getDb()
          .prepare(
            `
          UPDATE messages
          SET snooze_until = ?,
              last_error = ?
          WHERE id = ?
        `,
          )
          .run(snoozeUntil, reservation.reason, action.message_id);

        skipped++;
        continue;
      }

      try {
        const validated = await getOrCreateBrowser(
          platform,
          emit,
          eventBase,
          reservation.fingerprint,
        );
        const browserState = validated.browserState;

        if (!browserState) {
          const authState = validated.authState || {
            state: AUTH_STATES.UNKNOWN_STATE,
            reason: "Session validation failed before producing a state",
          };
          emit(
            "error",
            `${platform} session is not automation-ready: ${authState.state}. ${authState.reason}`,
          );
          emitState(
            emit,
            jobId,
            authState.state,
            `${platform} session is not automation-ready.`,
            {
              ...eventBase,
              fingerprint: reservation.fingerprint,
              authState: authState.state,
              reason: authState.reason,
              screenshotPath: authState.screenshotPath,
              htmlPath: authState.htmlPath,
            },
          );
          releaseActionFingerprint(reservation.fingerprint);
          recordOutcome(action, actionType, {
            outcome: "session_required",
            reason: `${authState.state}: ${authState.reason}`,
          });
          failures++;
          continue;
        }

        if (await detectCaptcha(browserState.page)) {
          emit("captcha", `CAPTCHA on ${platform} home. Pausing.`, {
            platform,
          });
          emitState(
            emit,
            jobId,
            "CAPTCHA_REQUIRED",
            `CAPTCHA on ${platform} home.`,
            {
              ...eventBase,
              fingerprint: reservation.fingerprint,
              warningDetected: true,
            },
          );
          releaseActionFingerprint(reservation.fingerprint);
          break;
        }

        emitState(
          emit,
          jobId,
          "RUNNING",
          `Running ${platform} ${actionType}.`,
          { ...eventBase, fingerprint: reservation.fingerprint },
        );

        // ── In-loop retry with circuit breaker ──────────────────────────────
        //
        // Previously, any failure (including transient ones like "React
        // remounted the editor mid-typing") would immediately record the
        // outcome and move on, snoozing the message for 1-3 hours. Now we
        // retry the action up to MAX_INLOOP_RETRIES times with a short
        // interruptible delay between attempts. Only retryable outcomes are
        // retried — premium_required, not_connected, already_connected,
        // session_required, no_posts, and skipped are NOT retried.
        //
        // We also track consecutive failures across profiles. If we hit
        // MAX_CONSECUTIVE_FAILURES in a row, we abort the whole run — that's
        // a strong signal something systemic is wrong (session expired,
        // LinkedIn changed selectors, captcha wall, etc.) and continuing
        // would just burn time on doomed attempts.
        const MAX_INLOOP_RETRIES = 2; // 1 initial + 2 retries = 3 attempts max
        const MAX_CONSECUTIVE_FAILURES = 5;
        const NON_RETRYABLE_OUTCOMES = new Set([
          "sent",
          "premium_required",
          "not_connected",
          "already_connected",
          "session_required",
          "no_posts",
          "skipped",
        ]);

        let outcomeObj = null;
        for (let attempt = 1; attempt <= MAX_INLOOP_RETRIES + 1; attempt++) {
          if (STOP_FLAGS.get(jobId)) {
            outcomeObj = { outcome: "skipped", reason: "Stopped by user" };
            break;
          }
          outcomeObj = await runAutomationAction(
            action,
            browserState,
            emit,
          );

          // Success or non-retryable → done.
          if (
            !outcomeObj ||
            outcomeObj.outcome === "sent" ||
            NON_RETRYABLE_OUTCOMES.has(outcomeObj.outcome)
          ) {
            break;
          }

          // Retryable failure — try again if we have attempts left.
          if (attempt <= MAX_INLOOP_RETRIES) {
            emit(
              "warn",
              `Attempt ${attempt} failed (${outcomeObj.reason || outcomeObj.outcome}). Retrying (${attempt}/${MAX_INLOOP_RETRIES})...`,
            );
            await interruptibleDelay(2000, 4000, jobId);
            if (STOP_FLAGS.get(jobId)) break;
          }
        }

        // Post-action session check
        emitState(
          emit,
          jobId,
          "VERIFYING",
          `Verifying ${platform} ${actionType}.`,
          { ...eventBase, fingerprint: reservation.fingerprint },
        );
        await checkSessionState(browserState.page, platform, emit, {
          label: `post-action-session-${actionType}-${action.message_id}`,
        });

        if (outcomeObj.outcome === "failed") {
          const screenshot = await captureFailureArtifact(
            browserState.page,
            platform,
            `${actionType}-${action.message_id}-${outcomeObj.reason || "failed"}`,
          );
          if (screenshot) {
            outcomeObj.reason = `${outcomeObj.reason || "Failed"} | screenshot: ${screenshot}`;
          }
        }

        recordOutcome(action, actionType, outcomeObj);
        recordEvent({
          jobId,
          ...eventBase,
          status: outcomeObj.outcome === "sent" ? "COMPLETED" : "FAILED",
          warningDetected: /warning|captcha|limit|blocked|session/i.test(
            outcomeObj.reason || "",
          ),
          details: {
            outcome: outcomeObj.outcome,
            reason: outcomeObj.reason,
            fingerprint: reservation.fingerprint,
          },
        });

        if (outcomeObj.outcome === "sent") {
          successes++;
          consecutiveFailures = 0; // reset circuit breaker on success
          if (actionType === "dm" || actionType === "instagram_dm") {
            dmsSentThisRun++;
          }
          if (actionType === "connect" || actionType === "connection") {
            connectionsSentThisRun++;
          }
        } else if (
          [
            "skipped",
            "already_connected",
            "no_posts",
            "not_connected",
            "premium_required",
            "session_required",
          ].includes(outcomeObj.outcome)
        ) {
          releaseActionFingerprint(reservation.fingerprint);
          skipped++;
          // premium_required / not_connected / already_connected are NOT
          // failures of our automation — they're LinkedIn saying "this lead
          // can't be DM'd". Don't let them count toward the circuit breaker.
          consecutiveFailures = 0;
        } else {
          releaseActionFingerprint(reservation.fingerprint);
          failures++;
          consecutiveFailures++;
        }
      } catch (err) {
        logger.error("AUTOMATION", `Error on action ${action.message_id}`, err);
        emit("error", `Unexpected error: ${err.message}`);
        const cached = browserCache.get(platform);
        if (cached && cached.page && !cached.page.isClosed()) {
          await captureFailureArtifact(
            cached.page,
            platform,
            `${actionType}-${action.message_id}-exception`,
          );
        }
        emitState(emit, jobId, "FAILED", `Action failed: ${err.message}`, {
          ...eventBase,
          fingerprint: reservation.fingerprint,
        });
        releaseActionFingerprint(reservation.fingerprint);
        recordOutcome(action, actionType, {
          outcome: "failed",
          reason: err.message,
        });
        failures++;
        consecutiveFailures++;
      }

      // ── Circuit breaker: too many consecutive failures ─────────────────────
      // If we hit MAX_CONSECUTIVE_FAILURES in a row, abort the whole run —
      // something systemic is wrong (session expired, selectors changed,
      // captcha wall) and continuing would just burn time on doomed attempts.
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !STOP_FLAGS.get(jobId)) {
        emit(
          "error",
          `Aborting run: ${consecutiveFailures} consecutive failures (circuit breaker). ` +
            `Last outcome: ${outcomeObj?.outcome || "exception"} — ${outcomeObj?.reason || ""}. ` +
            `Check that your LinkedIn session is still valid and that LinkedIn hasn't changed its UI.`,
        );
        emitState(
          emit,
          jobId,
          "MANUAL_INTERVENTION_REQUIRED",
          `Run aborted after ${consecutiveFailures} consecutive failures.`,
          { ...eventBase, consecutiveFailures },
        );
        break;
      }

      // ── Cooldown between profiles ──────────────────────────────────────────
      // SKIP the cooldown entirely for premium_required / not_connected /
      // already_connected / no_posts — these are not "actions we just took"
      // (no DM was sent, no connection request was submitted), so there's
      // nothing to cool down from. The user explicitly asked for this so we
      // don't waste 60-180s on every premium-required profile.
      const SKIP_COOLDOWN_OUTCOMES = new Set([
        "premium_required",
        "not_connected",
        "already_connected",
        "no_posts",
        "skipped",
      ]);
      const shouldSkipCooldown = outcomeObj
        ? SKIP_COOLDOWN_OUTCOMES.has(outcomeObj.outcome)
        : false;

      if (
        runnableQueue.indexOf(action) < runnableQueue.length - 1 &&
        !STOP_FLAGS.get(jobId) &&
        !shouldSkipCooldown
      ) {
        const delay = getActionDelayRange(platform, actionType);
        emitState(emit, jobId, "COOLDOWN", "Cooling down before next action.", {
          ...eventBase,
          minDelayMs: delay.min,
          maxDelayMs: delay.max,
        });
        emit(
          "info",
          `Cooling down before next action (${Math.round(delay.min / 1000)}-${Math.round(delay.max / 1000)}s).`,
        );
        await interruptibleDelay(delay.min, delay.max, jobId);
      } else if (shouldSkipCooldown && !STOP_FLAGS.get(jobId)) {
        // Brief pause only — enough for the browser to settle, not enough to
        // waste time. Lets us move to the next profile almost immediately.
        emit(
          "info",
          `Skipping cooldown for ${outcomeObj.outcome} — moving to next profile.`,
        );
        await interruptibleDelay(800, 1500, jobId);
      }

      // ── Stray-tab cleanup after every profile ─────────────────────────────
      // LinkedIn may have spawned a /job-posting tab during this action (e.g.
      // by auto-redirecting after a premium dialog). Close any stray tabs
      // before moving to the next profile so they don't accumulate.
      try {
        const cached = browserCache.get(platform);
        if (cached && cached.context && typeof cached.context.pages === "function") {
          const { closeStrayTabs } = require("./browserBase");
          await closeStrayTabs(cached.context, platform);
        }
      } catch (_) {}
    }

    // Close all browsers only after the ENTIRE run is done
    await closeAllCachedBrowsers();

    const remainingQueue = getQueuedActions({
      includeBlocked: true,
      includeWaiting: true,
      platforms,
    });
    const remainingWaiting = remainingQueue.filter(
      (action) => action.status === "approved" && !action.runnable,
    ).length;
    const remainingBlocked = remainingQueue.filter(
      (action) => action.status === "blocked",
    ).length;

    const summary = {
      successes,
      failures,
      skipped,
      queueLength: remainingQueue.length,
      runnableCount: remainingQueue.filter((action) => action.runnable).length,
      waitingCount: remainingWaiting,
      blockedCount: remainingBlocked,
    };

    emitState(
      emit,
      jobId,
      failures > 0 ? "FAILED" : "COMPLETED",
      "Automation run completed.",
      summary,
    );
    emit("done", "Automation run completed.", summary);
    return summary;
  } catch (error) {
    logger.error("AUTOMATION", "Executor failure", error);
    emitState(emit, jobId, "FAILED", `Executor error: ${error.message}`, {
      error: error.message,
    });
    emit("error", `Executor error: ${error.message}`);
  } finally {
    ACTIVE_JOB_ID = null;
    STOP_FLAGS.delete(jobId);
    if (sseRes) sseRes.end();
  }
}

function enqueueActionQueue(jobId, sseRes, options = {}) {
  const run = () => processActionQueue(jobId, sseRes, options);
  const queuedRun = RUN_QUEUE.then(run, run);
  RUN_QUEUE = queuedRun.catch((error) => {
    logger.error("AUTOMATION", "Queued automation run failed", error);
  });
  return queuedRun;
}

async function authenticatePlatform(platform) {
  logger.info("AUTH", `Starting manual auth for ${platform}`);

  const browserState = await createBrowser(platform, { headless: false });
  const { page } = browserState;

  let loginUrl = `https://www.${platform}.com/login`;
  if (platform === "linkedin") loginUrl = "https://www.linkedin.com/login";
  else if (platform === "x") loginUrl = "https://x.com/i/flow/login";

  await page.goto(loginUrl);

  return new Promise((resolve, reject) => {
    let checkInterval;
    let timeout;
    let finalized = false;

    const settle = async (success, errorMessage) => {
      if (finalized) return;
      finalized = true;
      clearInterval(checkInterval);
      if (timeout) clearTimeout(timeout);

      try {
        await closeBrowserState(browserState, platform);
      } catch (e) {}

      if (success) {
        resolve(true);
      } else {
        reject(new Error(errorMessage));
      }
    };

    page.once("close", () => {
      void settle(
        isManualAuthComplete(page, platform),
        "Browser closed before authentication completed",
      );
    });

    timeout = setTimeout(
      () => {
        void settle(false, "Auth timeout (5 mins)");
      },
      5 * 60 * 1000,
    );

    checkInterval = setInterval(async () => {
      try {
        if (finalized) return;

        if (page.isClosed()) {
          void settle(
            isManualAuthComplete(page, platform),
            "Browser closed before authentication completed",
          );
          return;
        }

        if (isManualAuthComplete(page, platform)) {
          await settle(true);
        }
      } catch (err) {}
    }, 3000);
  });
}

module.exports = {
  processActionQueue,
  enqueueActionQueue,
  stopJob,
  stopAllJobs,
  authenticatePlatform,
  isManualAuthComplete,
  getQueuedActions,
  isWithinLimit,
  determineActionType,
  getLinkedInOutreachMode,
  getXOutreachMode,
};
