/**
 * massFollowPipeline.js — Mass-Follow Pipeline
 *
 * Bulk-follows target accounts across all supported social platforms
 * (LinkedIn, X, Instagram, Facebook, TikTok) with human-like scheduling,
 * per-platform active windows, daily/hourly rate caps, and retry/backoff
 * for transient failures.
 *
 * Stages (mirrors the runner / checkpoint / lifecycle pattern used by
 * contentPipeline.js and pipelineRunner.js):
 *
 *   1. select_targets  — pull a batch of pending mass_follow_targets rows
 *                        (filtered by enabled platforms, active windows,
 *                        daily limits, retry eligibility). Persist a
 *                        checkpoint with the chosen batch IDs.
 *   2. follow          — for each target, mark it 'running', dispatch
 *                        through platformAdapter.runConnectionAction
 *                        (which already normalizes outcomes across every
 *                        supported platform), record a daily_actions row
 *                        + touchpoint + audit log entry, then mark the
 *                        target 'sent' | 'skipped' | 'failed'. Honors
 *                        pipelineState.throwIfAborted / awaitResume so
 *                        Pause / Stop / Resume work mid-batch.
 *   3. report          — write a summary checkpoint (counts per platform /
 *                        outcome) and emit a final pipeline log entry.
 *
 * Public API:
 *   runMassFollowPipeline(config) — wraps runMassFollowPipelineNow in
 *     enqueuePipelineRun so only one pipeline runs process-wide at a time.
 *
 * Config shape (mirrors what pipelineScheduler passes from limits_json):
 *   {
 *     platforms:                  string[],  // ['instagram','x','linkedin','facebook','tiktok']
 *     max_follows_per_run:        number,    // batch size cap (default 20)
 *     follow_interval_min_seconds: number,   // human-like delay floor (default 40)
 *     follow_interval_max_seconds: number,   // human-like delay ceiling (default 110)
 *     respect_active_window:      boolean,   // skip platforms outside their active window (default true)
 *     skip_already_following:     boolean,   // mark 'already_connected' outcomes as 'skipped' (default true)
 *     max_retries_per_target:     number,    // per-target retry ceiling (default 3)
 *     trigger:                    'cron'|'manual'|'api'|'retry'|'resume',
 *     executionId:                string,    // UUID from pipelineState.createExecution
 *     resumeFrom:                 string|null,
 *   }
 */

const crypto = require("crypto");
const { getDb } = require("../db/database");
const platformAdapter = require("../campaign/platformAdapter");
const platformPolicies = require("../config/platformPolicies");
const limits = require("../config/limits");
const browserBase = require("../automation/browserBase");
const { logActivity } = require("../services/auditService");
const jobRegistry = require("../jobs/jobRegistry");
const logger = require("../utils/logger");
const { enqueuePipelineRun } = require("./pipelineQueue");
const pipelineState = require("../services/pipelineStateService");
const pipelineLogger = require("../services/pipelineLogger");
const checkpointService = require("../services/pipelineCheckpoint");

const MASS_FOLLOW_STAGES = ["select_targets", "follow", "report"];

const SUPPORTED_PLATFORMS = new Set([
  "instagram",
  "x",
  "linkedin",
  "facebook",
  "tiktok",
]);

/**
 * Build an emit callback that mirrors events into the pipeline logger +
 * Socket.IO broadcast, matching the convention used by contentPipeline.js.
 */
function buildEmitter(jobId) {
  return (event) => {
    const stageLabel = event.stage || event.type || "event";
    const message = event.message || String(stageLabel);
    const level =
      event.level ||
      (String(stageLabel).toLowerCase() === "error" ? "error" : "info");
    logger.info("MASS-FOLLOW-PIPELINE", `[${jobId}] ${stageLabel}: ${message}`);
    try {
      const { broadcast } = require("../services/socketService");
      broadcast("mass_follow_pipeline:event", { ...event, jobId });
    } catch (_) {}
    // Mirror into structured logs so the pipelines UI shows live progress.
    try {
      pipelineLogger.log({
        pipelineId: "mass_follow",
        executionId: jobId,
        level,
        stage: stageLabel,
        message,
        context: event.context || null,
      });
    } catch (_) {}
  };
}

function sleep(ms, executionId) {
  return new Promise((resolve) => {
    let elapsed = 0;
    const stepMs = 500;
    const tick = () => {
      // Honor Pause/Stop: if the user paused or aborted the pipeline,
      // resolve early so the runner can re-check pipelineState.
      if (executionId) {
        try {
          if (pipelineState.isAborted(executionId)) return resolve();
        } catch (_) {}
      }
      if (elapsed >= ms) return resolve();
      const wait = Math.min(stepMs, ms - elapsed);
      setTimeout(() => {
        elapsed += wait;
        tick();
      }, wait);
    };
    tick();
  });
}

function randomBetween(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.random() * (hi - lo);
}

function isWithinActiveWindow(policy) {
  if (!policy || !policy.activeWindow) return true;
  const currentHour = new Date().getHours();
  return (
    currentHour >= policy.activeWindow.startHour &&
    currentHour < policy.activeWindow.endHour
  );
}

function getDailyFollowCount(platform) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM daily_actions
       WHERE platform = ?
         AND action_type IN ('follows', 'connections')
         AND DATE(performed_at) = DATE('now', 'localtime')`,
    )
    .get(platform);
  return row ? row.count : 0;
}

function getHourlyFollowCount(platform) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM daily_actions
       WHERE platform = ?
         AND action_type IN ('follows', 'connections')
         AND performed_at >= datetime('now', '-1 hour')`,
    )
    .get(platform);
  return row ? row.count : 0;
}

function getEffectiveDailyLimit(platform) {
  // Prefer the user's stored daily_limits (Settings → Limits), fall back to
  // the static limits.js. The 'follows' key is used by X/Instagram/TikTok;
  // 'connections' is used by LinkedIn/Facebook (which call friend/connect).
  const stored = require("../db/database").getDailyLimits();
  const storedPlatform = stored[platform] || {};
  const staticPlatform = limits[platform] || {};
  if (typeof storedPlatform.follows === "number") return storedPlatform.follows;
  if (typeof storedPlatform.connections === "number") return storedPlatform.connections;
  if (typeof staticPlatform.follows === "number") return staticPlatform.follows;
  if (typeof staticPlatform.connections === "number") return staticPlatform.connections;
  return 5; // Conservative default — mirrors isWithinLimit fallback in database.js
}

function getEffectiveHourlyLimit(platform) {
  const stored = require("../db/database").getDailyLimits();
  const storedHourly = (stored[platform] && stored[platform].hourly) || {};
  const staticHourly = (limits[platform] && limits[platform].hourly) || {};
  if (typeof storedHourly.follows === "number") return storedHourly.follows;
  if (typeof storedHourly.connections === "number") return storedHourly.connections;
  if (typeof staticHourly.follows === "number") return staticHourly.follows;
  if (typeof staticHourly.connections === "number") return staticHourly.connections;
  return 3;
}

/**
 * Pull a batch of pending mass_follow_targets rows for the configured
 * platforms. Honors per-platform active windows and daily/hourly caps:
 * if a platform has hit its daily or hourly ceiling, that platform is
 * excluded from this batch (its targets stay 'pending' for the next run).
 *
 * Returns: { targets, skippedPlatforms }
 */
function selectTargetsBatch(platforms, maxFollowsPerRun, respectActiveWindow) {
  const db = getDb();
  const skippedPlatforms = [];
  const eligiblePlatforms = [];

  for (const platform of platforms) {
    if (!SUPPORTED_PLATFORMS.has(platform)) {
      logger.warn(
        "MASS-FOLLOW-PIPELINE",
        `Skipping unsupported platform: ${platform}`,
      );
      skippedPlatforms.push({ platform, reason: "unsupported" });
      continue;
    }
    const policy = platformPolicies[platform];
    if (respectActiveWindow && !isWithinActiveWindow(policy)) {
      skippedPlatforms.push({ platform, reason: "outside_active_window" });
      continue;
    }
    const daily = getDailyFollowCount(platform);
    const dailyLimit = getEffectiveDailyLimit(platform);
    if (daily >= dailyLimit) {
      skippedPlatforms.push({ platform, reason: "daily_limit_reached", daily, dailyLimit });
      continue;
    }
    const hourly = getHourlyFollowCount(platform);
    const hourlyLimit = getEffectiveHourlyLimit(platform);
    if (hourly >= hourlyLimit) {
      skippedPlatforms.push({ platform, reason: "hourly_limit_reached", hourly, hourlyLimit });
      continue;
    }
    eligiblePlatforms.push({
      platform,
      remainingDaily: Math.max(0, dailyLimit - daily),
      remainingHourly: Math.max(0, hourlyLimit - hourly),
    });
  }

  if (eligiblePlatforms.length === 0) {
    return { targets: [], skippedPlatforms };
  }

  // Pull pending or retryable rows for the eligible platforms, oldest first.
  // Retryable = status='failed' AND retry_count < max_retries AND
  // (next_retry_at IS NULL OR next_retry_at <= now).
  const placeholders = eligiblePlatforms.map(() => "?").join(",");
  const platformArgs = eligiblePlatforms.map((p) => p.platform);

  // Per-platform caps so a single platform doesn't starve the others.
  // Distribute maxFollowsPerRun proportionally to remainingHourly (so each
  // platform can use at most its hourly headroom), then cap at remainingDaily.
  const perPlatformCap = eligiblePlatforms.map((p) =>
    Math.min(p.remainingHourly, p.remainingDaily, maxFollowsPerRun),
  );

  // Pull a generous superset (maxFollowsPerRun * 2) then trim per-platform
  // in JS. This is simpler than crafting one SQL query with per-platform
  // LIMITs (which SQLite doesn't support natively) and the batch is small.
  const superset = db
    .prepare(
      `SELECT id, platform, profile_url, handle, source, campaign_id, lead_id,
              retry_count, max_retries, next_retry_at
       FROM mass_follow_targets
       WHERE platform IN (${placeholders})
         AND (
           status = 'pending'
           OR (status = 'failed'
               AND retry_count < COALESCE(max_retries, 3)
               AND (next_retry_at IS NULL OR datetime(next_retry_at) <= datetime('now')))
         )
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(...platformArgs, Math.max(maxFollowsPerRun * 2, maxFollowsPerRun));

  // Bucket by platform, trim to per-platform cap, preserve chronological order
  const buckets = new Map(eligiblePlatforms.map((p) => [p.platform, []]));
  for (const row of superset) {
    if (!buckets.has(row.platform)) continue;
    buckets.get(row.platform).push(row);
  }
  const targets = [];
  eligiblePlatforms.forEach((p, idx) => {
    const cap = perPlatformCap[idx];
    const bucket = buckets.get(p.platform).slice(0, cap);
    targets.push(...bucket);
  });

  // Final trim to overall maxFollowsPerRun (in case several platforms each
  // contributed their full cap and the total exceeds the run-level ceiling).
  return { targets: targets.slice(0, maxFollowsPerRun), skippedPlatforms };
}

/**
 * Persist a follow outcome for a single target. Mirrors the touchpoint +
 * daily_actions + audit log conventions used by connectionQueue.js.
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

/**
 * Launch per-platform browser contexts for the platforms that have targets
 * in this batch. Reuses backgroundJobs.launchRequiredBrowsers via a thin
 * local copy so we don't create a require cycle (backgroundJobs →
 * processConnectionQueue → platformAdapter vs. here → platformAdapter).
 */
async function launchBrowsersForPlatforms(platforms) {
  const activePages = {};
  for (const platform of platforms) {
    try {
      let state;
      if (platform === "instagram") {
        state = await browserBase.createInstagramBrowser({
          headless: process.env.ALLOW_HEADLESS_SOCIAL === "true",
        });
      } else {
        state = await browserBase.createBrowser(platform, {
          headless: process.env.ALLOW_HEADLESS_SOCIAL === "true",
        });
      }
      activePages[platform] = state;
    } catch (err) {
      logger.error(
        "MASS-FOLLOW-PIPELINE",
        `Failed to launch browser for ${platform}: ${err.message}`,
      );
      // Don't fail the whole batch — we'll mark this platform's targets as
      // 'session_required' so they retry next run.
      activePages[platform] = { error: err.message };
    }
  }
  return activePages;
}

async function closeBrowsersForPlatforms(activePages) {
  for (const [platform, state] of Object.entries(activePages)) {
    if (!state || !state.browser) continue;
    try {
      await browserBase.closeBrowser(state.browser, platform, state.context, {
        mode: state.mode,
        tracePath: state.tracePath,
        shouldCloseBrowser: state.shouldCloseBrowser,
        lock: state.lock,
      });
    } catch (err) {
      logger.warn(
        "MASS-FOLLOW-PIPELINE",
        `Error closing browser for ${platform}: ${err.message}`,
      );
    }
  }
}

/**
 * Run one cycle of the mass-follow pipeline.
 *
 * @param {Object} config — see file header for full shape.
 * @returns {Promise<{ success: boolean, summary?: object, error?: string }>}
 */
async function runMassFollowPipelineNow(config = {}) {
  const {
    platforms: rawPlatforms = ["instagram", "x"],
    max_follows_per_run = 20,
    follow_interval_min_seconds = 40,
    follow_interval_max_seconds = 110,
    respect_active_window: respectActiveWindow = true,
    skip_already_following: skipAlreadyFollowing = true,
    max_retries_per_target = 3,
    trigger = "manual",
  } = config;

  const platforms = Array.isArray(rawPlatforms)
    ? rawPlatforms
        .map((p) => String(p).trim().toLowerCase())
        .filter((p) => SUPPORTED_PLATFORMS.has(p))
    : [];

  if (platforms.length === 0) {
    logger.warn("MASS-FOLLOW-PIPELINE", "No supported platforms configured — skipping run");
    return { success: false, error: "No supported platforms configured" };
  }

  const maxFollows = Math.max(1, Math.floor(Number(max_follows_per_run) || 20));
  const intervalMin = Math.max(5, Math.floor(Number(follow_interval_min_seconds) || 40));
  const intervalMax = Math.max(intervalMin, Math.floor(Number(follow_interval_max_seconds) || 110));

  const jobId = config.executionId || crypto.randomUUID();
  const emit = buildEmitter(jobId);
  const db = getDb();

  // Register the job so force-clear / stop can abort it.
  const controller = jobRegistry.startJob(jobId, {
    pipelineId: "mass_follow",
    type: "mass_follow",
    stage: "select_targets",
  });
  const signal = controller.signal;

  // Bridge to the lifecycle state service.
  const lifecycleExecId = config.executionId || null;
  const updateLifecycle = (stage, message, progress, completedSteps, totalSteps) => {
    if (!lifecycleExecId) return;
    try {
      pipelineState.updateExecutionProgress(lifecycleExecId, {
        stage,
        message,
        progress,
        completedSteps,
        totalSteps,
      });
    } catch (_) {}
  };
  const checkAbort = () => {
    if (lifecycleExecId) {
      try {
        pipelineState.throwIfAborted(lifecycleExecId);
      } catch (err) {
        throw err;
      }
    }
    if (signal?.aborted) throw new Error("Mass-follow pipeline aborted");
  };

  emit({
    stage: "start",
    message: `Run started (trigger: ${trigger}, platforms: ${platforms.join(", ")})`,
  });
  logActivity({
    activityType: "pipeline_run",
    entityType: "pipeline",
    entityId: jobId,
    actor: trigger,
    status: "running",
    summary: `Mass-follow pipeline ${jobId} started`,
    details: { platforms, maxFollows, intervalMin, intervalMax },
  });

  const summary = {
    total: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
    perPlatform: {},
    skippedPlatforms: [],
  };

  // ── STAGE 1: select_targets ──────────────────────────────────────────────
  let stageStart = Date.now();
  // Hoisted to function scope so stage 2 (follow) can read it. `let` inside
  // the try block below would be block-scoped and unreachable from stage 2.
  let batch = null;
  try {
    updateLifecycle("select_targets", "Selecting targets for this run…", 5, 0, 3);

    // If we're resuming from a checkpoint, reuse the saved batch.
    const existingCheckpoint = lifecycleExecId
      ? checkpointService.hasCheckpoint(lifecycleExecId, "select_targets")
      : false;
    if (existingCheckpoint && lifecycleExecId) {
      const cps = checkpointService.getCheckpoints(lifecycleExecId);
      const cp = cps.find((c) => c.stage === "select_targets");
      if (cp && cp.payload_json) {
        try {
          const payload = JSON.parse(cp.payload_json);
          if (Array.isArray(payload.targetIds) && payload.targetIds.length > 0) {
            const placeholders = payload.targetIds.map(() => "?").join(",");
            batch = db
              .prepare(
                `SELECT id, platform, profile_url, handle, source, campaign_id, lead_id,
                        retry_count, max_retries, next_retry_at
                 FROM mass_follow_targets
                 WHERE id IN (${placeholders})`,
              )
              .all(...payload.targetIds);
          }
        } catch (_) {
          // fall through to fresh selection
        }
      }
    }

    if (!batch) {
      const selection = selectTargetsBatch(platforms, maxFollows, respectActiveWindow);
      batch = selection.targets;
      summary.skippedPlatforms = selection.skippedPlatforms;
      if (selection.skippedPlatforms.length > 0) {
        emit({
          stage: "select_targets",
          level: "warn",
          message: `Skipped platforms: ${selection.skippedPlatforms
            .map((p) => `${p.platform} (${p.reason})`)
            .join(", ")}`,
        });
      }
      // Save the chosen batch as a checkpoint so resume-from-checkpoint
      // re-runs only the follow stage against the same targets.
      if (lifecycleExecId) {
        checkpointService.saveCheckpoint({
          executionId: lifecycleExecId,
          pipelineId: "mass_follow",
          stage: "select_targets",
          status: "completed",
          payload: {
            targetIds: batch.map((t) => t.id),
            skippedPlatforms: summary.skippedPlatforms,
          },
          durationMs: Date.now() - stageStart,
        });
      }
    } else {
      // Resuming — recompute skipped platforms for the report
      summary.skippedPlatforms = platforms
        .filter((p) => !batch.some((t) => t.platform === p))
        .map((p) => ({ platform: p, reason: "no_targets_in_batch" }));
    }

    summary.total = batch.length;
    if (batch.length === 0) {
      emit({
        stage: "select_targets",
        message: "No eligible targets — nothing to follow this run.",
      });
      updateLifecycle("select_targets", "No eligible targets", 100, 1, 3);
      if (lifecycleExecId) {
        checkpointService.saveCheckpoint({
          executionId: lifecycleExecId,
          pipelineId: "mass_follow",
          stage: "follow",
          status: "skipped",
          payload: { reason: "no_targets", summary },
          durationMs: 0,
        });
        checkpointService.saveCheckpoint({
          executionId: lifecycleExecId,
          pipelineId: "mass_follow",
          stage: "report",
          status: "completed",
          payload: summary,
          durationMs: 0,
        });
      }
      jobRegistry.finishJob(jobId);
      logActivity({
        activityType: "pipeline_run",
        entityType: "pipeline",
        entityId: jobId,
        actor: trigger,
        status: "success",
        summary: `Mass-follow pipeline ${jobId} completed (no targets)`,
        details: summary,
      });
      return { success: true, summary };
    }

    emit({
      stage: "select_targets",
      message: `Selected ${batch.length} target(s) across ${new Set(batch.map((t) => t.platform)).size} platform(s)`,
    });
    updateLifecycle("select_targets", `Selected ${batch.length} target(s)`, 10, 1, 3);
  } catch (err) {
    if (lifecycleExecId) {
      checkpointService.saveCheckpoint({
        executionId: lifecycleExecId,
        pipelineId: "mass_follow",
        stage: "select_targets",
        status: "failed",
        error: err,
        durationMs: Date.now() - stageStart,
      });
    }
    jobRegistry.finishJob(jobId);
    throw err;
  }

  // ── STAGE 2: follow ──────────────────────────────────────────────────────
  stageStart = Date.now();
  const platformsInBatch = [...new Set(batch.map((t) => t.platform))];
  let activePages = {};
  try {
    updateLifecycle("follow", `Launching browsers for: ${platformsInBatch.join(", ")}…`, 15, 1, 3);

    // Honor Pause before launching browsers (a long-paused pipeline shouldn't
    // hold a browser open).
    if (lifecycleExecId) {
      try { await pipelineState.awaitResume(lifecycleExecId, emit); } catch (_) {}
    }
    checkAbort();

    activePages = await launchBrowsersForPlatforms(platformsInBatch);

    for (let i = 0; i < batch.length; i++) {
      checkAbort();

      // Honor Pause between targets
      if (lifecycleExecId) {
        try { await pipelineState.awaitResume(lifecycleExecId, emit); } catch (_) {}
      }

      const target = batch[i];
      const platform = target.platform;
      const state = activePages[platform];
      const pct = 15 + Math.floor(((i + 1) / batch.length) * 75); // 15..90

      // Browser launch failed for this platform → mark all of its targets
      // as 'session_required' so they retry next run.
      if (!state || state.error) {
        db.prepare(
          `UPDATE mass_follow_targets
           SET status = 'pending', error_message = ?,
               attempted_at = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        ).run(
          state?.error ? `Browser launch failed: ${state.error}` : "Browser unavailable",
          new Date().toISOString(),
          target.id,
        );
        summary.pending += 1;
        summary.perPlatform[platform] = summary.perPlatform[platform] || {
          sent: 0, skipped: 0, failed: 0, pending: 0,
        };
        summary.perPlatform[platform].pending += 1;
        updateLifecycle(
          "follow",
          `Target ${i + 1}/${batch.length}: ${target.handle || target.profile_url} skipped (no browser for ${platform})`,
          pct, 1, 3,
        );
        continue;
      }

      // Mark target 'running' atomically so concurrent runs don't double-pick.
      const claim = db
        .prepare(
          `UPDATE mass_follow_targets
           SET status = 'running', attempted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status != 'running'`,
        )
        .run(target.id);
      if (claim.changes === 0) {
        // Already claimed by another runner — skip.
        continue;
      }

      emit({
        stage: "follow",
        message: `Following ${target.handle || target.profile_url} on ${platform} (${i + 1}/${batch.length})`,
        context: { targetId: target.id, platform, profileUrl: target.profile_url },
      });
      updateLifecycle(
        "follow",
        `Following ${target.handle || target.profile_url} on ${platform} (${i + 1}/${batch.length})`,
        pct, 1, 3,
      );

      // The platform adapter expects a lead-shaped object with at least
      // profile_url + id. We synthesize one from the target.
      const syntheticLead = {
        id: target.lead_id || target.id,
        profile_url: target.profile_url,
        name: target.handle || null,
      };

      let result;
      try {
        result = await platformAdapter.runConnectionAction(
          platform,
          state.page,
          syntheticLead,
          "", // no message — pure follow
          (type, msg) => emit({ stage: "follow", level: type, message: msg }),
        );
      } catch (err) {
        result = {
          outcome: "failed",
          error: err.message,
          metadata: {},
          retryable: true,
        };
      }

      const finalStatus = recordOutcome(db, target, platform, result);
      summary[finalStatus] = (summary[finalStatus] || 0) + 1;
      summary.perPlatform[platform] = summary.perPlatform[platform] || {
        sent: 0, skipped: 0, failed: 0, pending: 0,
      };
      summary.perPlatform[platform][finalStatus] =
        (summary.perPlatform[platform][finalStatus] || 0) + 1;

      emit({
        stage: "follow",
        level: finalStatus === "sent" ? "success" : finalStatus === "failed" ? "error" : "info",
        message: `${target.handle || target.profile_url} → ${finalStatus}`,
      });

      // Human-like delay before the next target (skip after the last one)
      if (i < batch.length - 1) {
        const delaySec = randomBetween(intervalMin, intervalMax);
        await sleep(delaySec * 1000, lifecycleExecId);
      }
    }

    if (lifecycleExecId) {
      checkpointService.saveCheckpoint({
        executionId: lifecycleExecId,
        pipelineId: "mass_follow",
        stage: "follow",
        status: "completed",
        payload: {
          sent: summary.sent,
          skipped: summary.skipped,
          failed: summary.failed,
          pending: summary.pending,
          total: summary.total,
        },
        durationMs: Date.now() - stageStart,
      });
    }
    updateLifecycle("follow", `Followed ${summary.sent}, skipped ${summary.skipped}, failed ${summary.failed}`, 92, 2, 3);
  } catch (err) {
    if (lifecycleExecId) {
      checkpointService.saveCheckpoint({
        executionId: lifecycleExecId,
        pipelineId: "mass_follow",
        stage: "follow",
        status: "failed",
        error: err,
        durationMs: Date.now() - stageStart,
      });
    }
    throw err;
  } finally {
    await closeBrowsersForPlatforms(activePages);
  }

  // ── STAGE 3: report ──────────────────────────────────────────────────────
  stageStart = Date.now();
  try {
    updateLifecycle("report", "Writing run summary…", 95, 2, 3);
    emit({
      stage: "report",
      level: "success",
      message: `Run complete — sent: ${summary.sent}, skipped: ${summary.skipped}, failed: ${summary.failed}, pending: ${summary.pending}`,
      context: summary,
    });
    if (lifecycleExecId) {
      checkpointService.saveCheckpoint({
        executionId: lifecycleExecId,
        pipelineId: "mass_follow",
        stage: "report",
        status: "completed",
        payload: summary,
        durationMs: Date.now() - stageStart,
      });
    }
    updateLifecycle("report", "Done", 100, 3, 3);
    logActivity({
      activityType: "pipeline_run",
      entityType: "pipeline",
      entityId: jobId,
      actor: trigger,
      status: "success",
      summary: `Mass-follow pipeline ${jobId} completed`,
      details: summary,
    });
    return { success: true, summary };
  } catch (err) {
    if (lifecycleExecId) {
      checkpointService.saveCheckpoint({
        executionId: lifecycleExecId,
        pipelineId: "mass_follow",
        stage: "report",
        status: "failed",
        error: err,
        durationMs: Date.now() - stageStart,
      });
    }
    throw err;
  } finally {
    jobRegistry.finishJob(jobId);
  }
}

/**
 * Public entry point — wraps the actual run in the global pipeline queue so
 * only one pipeline runs process-wide at a time (mirrors
 * contentPipeline.runContentPipeline).
 */
async function runMassFollowPipeline(config = {}) {
  return enqueuePipelineRun(
    "mass_follow",
    `mass_follow:${config.trigger || "manual"}:${Date.now()}`,
    () => runMassFollowPipelineNow(config),
    {
      onQueued: ({ position, activeRun }) => {
        logger.info(
          "MASS-FOLLOW-PIPELINE",
          `Mass-follow pipeline queued at position ${position}; waiting for active run to finish`,
          { activeRun },
        );
      },
    },
  );
}

module.exports = {
  runMassFollowPipeline,
  runMassFollowPipelineNow,
  MASS_FOLLOW_STAGES,
  SUPPORTED_PLATFORMS,
  // Exported for tests
  _internal: {
    selectTargetsBatch,
    recordOutcome,
    isWithinActiveWindow,
    getDailyFollowCount,
    getHourlyFollowCount,
    getEffectiveDailyLimit,
    getEffectiveHourlyLimit,
  },
};
