/**
 * massFollowPipeline/runMassFollowPipelineNow.js
 *
 * The core pipeline runner: one cycle of the mass-follow pipeline across 3
 * stages (select_targets → follow → report) with pause/resume, abort,
 * checkpoint persistence, audit logging, per-platform rate-limit halting,
 * and per-target retry backoff.
 *
 * Kept intact as a single ~466-line function: splitting it would require
 * threading 10+ closed-over locals (jobId, db, emit, summary, batch,
 * activePages, haltedPlatforms, lifecycleExecId, updateLifecycle, checkAbort,
 * signal) through every extracted helper, obscuring the 3-stage narrative.
 *
 * Returns { success, summary } on success, { success:false, error, summary }
 * on early-exit, throws on unrecoverable failure.
 */

const crypto = require("crypto");
const { getDb } = require("../../db/database");
const platformAdapter = require("../../campaign/platformAdapter");
const { logActivity } = require("../../services/auditService");
const jobRegistry = require("../../jobs/jobRegistry");
const logger = require("../../utils/logger");
const pipelineState = require("../../services/pipelineStateService");
const checkpointService = require("../../services/pipelineCheckpoint");
const { SUPPORTED_PLATFORMS, buildEmitter, sleep, randomBetween } = require("./shared");
const { isRateLimitResult } = require("./followLimits");
const { selectTargetsBatch } = require("./selectTargetsBatch");
const { recordOutcome } = require("./recordOutcome");
const { launchBrowsersForPlatforms, closeBrowsersForPlatforms } = require("./browserLifecycle");

async function runMassFollowPipelineNow(config = {}) {
  const {
    platforms: rawPlatforms = ["instagram", "x"],
    max_follows_per_run = 20,
    follow_interval_min_seconds = 40,
    follow_interval_max_seconds = 110,
    respect_active_window: respectActiveWindow = true,
    skip_already_following: skipAlreadyFollowing = true,
    max_retries_per_target = 3,
    max_follows_per_platform: rawMaxFollowsPerPlatform = {},
    show_browser: showBrowser = false,
    trigger = "manual",
  } = config;

  // Normalize the per-platform overrides into a { platform: number } map.
  const maxFollowsPerPlatform = {};
  if (rawMaxFollowsPerPlatform && typeof rawMaxFollowsPerPlatform === "object" && !Array.isArray(rawMaxFollowsPerPlatform)) {
    for (const [platform, value] of Object.entries(rawMaxFollowsPerPlatform)) {
      const p = String(platform).trim().toLowerCase();
      if (!SUPPORTED_PLATFORMS.has(p)) continue;
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) maxFollowsPerPlatform[p] = Math.floor(n);
    }
  }

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
      const selection = selectTargetsBatch(platforms, maxFollows, respectActiveWindow, maxFollowsPerPlatform);
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
        status: "skipped",
        summary: `Mass-follow pipeline ${jobId} skipped (no eligible targets)`,
        details: summary,
      });
      return { success: false, error: "No eligible targets", summary };
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
  const haltedPlatforms = new Set();
  let activePages = {};
  try {
    updateLifecycle("follow", `Launching browsers for: ${platformsInBatch.join(", ")}…`, 15, 1, 3);

    // Honor Pause before launching browsers (a long-paused pipeline shouldn't
    // hold a browser open).
    if (lifecycleExecId) {
      try { await pipelineState.awaitResume(lifecycleExecId, emit); } catch (_) {}
    }
    checkAbort();

    activePages = await launchBrowsersForPlatforms(platformsInBatch, showBrowser);

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

      if (haltedPlatforms.has(platform)) {
        db.prepare(
          `UPDATE mass_follow_targets
           SET status = 'pending', error_message = ?,
               attempted_at = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        ).run(
          "Platform rate limit reached earlier in this run; held for a later run",
          new Date().toISOString(),
          target.id,
        );
        summary.pending += 1;
        summary.perPlatform[platform] = summary.perPlatform[platform] || {
          sent: 0, skipped: 0, failed: 0, pending: 0,
        };
        summary.perPlatform[platform].pending += 1;
        continue;
      }

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
      if (isRateLimitResult(result)) {
        haltedPlatforms.add(platform);
        emit({
          stage: "follow",
          level: "warn",
          message: `${platform} reported a rate limit; holding remaining ${platform} targets for a later run`,
        });
      }
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
    if (summary.total > 0 && summary.sent + summary.skipped + summary.failed === 0) {
      throw new Error("Mass-follow did not complete any targets; all selected targets were left pending");
    }
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

module.exports = { runMassFollowPipelineNow };
