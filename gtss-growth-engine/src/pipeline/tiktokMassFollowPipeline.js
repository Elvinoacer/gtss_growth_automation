/**
 * tiktokMassFollowPipeline.js — TikTok Search-Driven Mass-Follow Pipeline
 *
 * Unlike the generic mass_follow pipeline (which operates on pre-populated
 * mass_follow_targets rows and navigates to each profile individually),
 * this pipeline is purpose-built for TikTok's /search/user page:
 *
 *   1. search    — navigate to https://www.tiktok.com/search/user?q=<query>
 *                  (query is user-configurable or AI-determined), scrape the
 *                  visible user cards, and persist them as a checkpoint.
 *   2. follow    — click the Follow button (data-e2e="follow-back") directly
 *                  on each card, up to the user-set follow limit per run.
 *                  Honors daily/hourly caps from limits.js, the TikTok
 *                  active window, human-like delays, and Pause/Stop/Resume.
 *   3. report    — write a summary checkpoint and emit a final log entry.
 *
 * Why a dedicated pipeline (instead of extending the generic one)?
 *   - TikTok's search page is the only platform where Follow buttons live
 *     inline on the search results — every other platform requires a
 *     profile navigation. Forcing the generic pipeline to support both
 *     shapes would have bloated its dispatch logic.
 *   - The user explicitly wants TikTok to be testable in isolation. A
 *     dedicated pipeline id (`tiktok_mass_follow`) gets its own schedule
 *     row, its own UI card, its own Run button, and its own health
 *     metrics — fully independent of the other platforms.
 *
 * Public API:
 *   runTikTokMassFollowPipeline(config)
 *     Wraps runTikTokMassFollowPipelineNow in enqueuePipelineRun so only
 *     one pipeline runs process-wide at a time.
 *
 * Config shape (mirrors what pipelineScheduler passes from limits_json):
 *   {
 *     search_query:              string,   // e.g. "restaurant owners" (required)
 *     max_follows_per_run:       number,   // user-set follow limit (default 20)
 *     follow_interval_min_seconds: number,  // human-like delay floor (default 40)
 *     follow_interval_max_seconds: number,  // human-like delay ceiling (default 110)
 *     max_scrolls:               number,   // scroll passes when scraping (default 3)
 *     respect_active_window:     boolean,  // skip if outside TikTok's active window (default true)
 *     trigger:                   'cron'|'manual'|'api'|'retry'|'resume',
 *     executionId:               string,   // UUID from pipelineState.createExecution
 *     resumeFrom:                string|null,
 *   }
 */

const crypto = require("crypto");
const { getDb } = require("../db/database");
const platformPolicies = require("../config/platformPolicies");
const limits = require("../config/limits");
const browserBase = require("../automation/browserBase");
const tiktokSearch = require("../automation/tiktokSearch");
const { logActivity } = require("../services/auditService");
const jobRegistry = require("../jobs/jobRegistry");
const logger = require("../utils/logger");
const { enqueuePipelineRun } = require("./pipelineQueue");
const pipelineState = require("../services/pipelineStateService");
const pipelineLogger = require("../services/pipelineLogger");
const checkpointService = require("../services/pipelineCheckpoint");

const PIPELINE_ID = "tiktok_mass_follow";
const PLATFORM = "tiktok";
const STAGES = ["search", "follow", "report"];

/**
 * Build an emit callback that mirrors events into the pipeline logger +
 * Socket.IO broadcast, matching the convention used by massFollowPipeline.js.
 */
function buildEmitter(jobId) {
  return (event) => {
    const stageLabel = event.stage || event.type || "event";
    const message = event.message || String(stageLabel);
    const level =
      event.level ||
      (String(stageLabel).toLowerCase() === "error" ? "error" : "info");
    logger.info("TIKTOK-MASS-FOLLOW", `[${jobId}] ${stageLabel}: ${message}`);
    try {
      const { broadcast } = require("../services/socketService");
      broadcast("tiktok_mass_follow_pipeline:event", { ...event, jobId });
    } catch (_) {}
    try {
      pipelineLogger.log({
        pipelineId: PIPELINE_ID,
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

function isWithinActiveWindow(policy) {
  if (!policy || !policy.activeWindow) return true;
  const currentHour = new Date().getHours();
  return (
    currentHour >= policy.activeWindow.startHour &&
    currentHour < policy.activeWindow.endHour
  );
}

function getDailyFollowCount() {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM daily_actions
       WHERE platform = 'tiktok'
         AND action_type = 'follows'
         AND DATE(performed_at) = DATE('now', 'localtime')`,
    )
    .get();
  return row ? row.count : 0;
}

function getHourlyFollowCount() {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM daily_actions
       WHERE platform = 'tiktok'
         AND action_type = 'follows'
         AND performed_at >= datetime('now', '-1 hour')`,
    )
    .get();
  return row ? row.count : 0;
}

function getEffectiveDailyLimit() {
  // Prefer the user's stored daily_limits (Settings → Limits), fall back to
  // the static limits.js. The 'follows' key is used by TikTok.
  const stored = require("../db/database").getDailyLimits();
  const storedTikTok = stored.tiktok || {};
  const staticTikTok = limits.tiktok || {};
  if (typeof storedTikTok.follows === "number") return storedTikTok.follows;
  if (typeof staticTikTok.follows === "number") return staticTikTok.follows;
  return 25; // Conservative default — mirrors limits.js
}

function getEffectiveHourlyLimit() {
  const stored = require("../db/database").getDailyLimits();
  const storedHourly = (stored.tiktok && stored.tiktok.hourly) || {};
  const staticHourly = (limits.tiktok && limits.tiktok.hourly) || {};
  if (typeof storedHourly.follows === "number") return storedHourly.follows;
  if (typeof staticHourly.follows === "number") return staticHourly.follows;
  return 4;
}

/**
 * Record a single follow outcome: a daily_actions row (for rate-limit
 * counting) + a touchpoint (if a lead_id is available) + an audit log
 * entry. Mirrors the recording convention in massFollowPipeline.js.
 */
function recordFollowOutcome(db, card, result, runId) {
  const now = new Date().toISOString();
  const outcome = result.outcome || "failed";
  const errorMessage = result.reason || result.error || null;

  // 1. daily_actions row — only on sent / skipped (failed attempts don't
  //    count against the daily cap, mirroring massFollowPipeline.js).
  if (outcome === "sent" || outcome === "already_connected") {
    db.prepare(
      `INSERT INTO daily_actions (platform, action_type, lead_id, outcome, reason, performed_at)
       VALUES (?, 'follows', NULL, ?, ?, CURRENT_TIMESTAMP)`,
    ).run(
      PLATFORM,
      outcome === "sent" ? "sent" : "skipped",
      errorMessage,
    );
  }

  // 2. Audit log entry (always — even failures, so the user can see what
  //    happened in the activity feed).
  try {
    logActivity({
      activityType: "tiktok_mass_follow_action",
      entityType: "pipeline",
      entityId: PIPELINE_ID,
      actor: runId,
      status: outcome === "sent" ? "success" : outcome === "already_connected" ? "skipped" : "failed",
      summary: `@${card.username} → ${outcome}`,
      details: {
        username: card.username,
        displayName: card.displayName,
        profileUrl: card.profileUrl,
        followers: card.followers,
        likes: card.likes,
        outcome,
        reason: errorMessage,
        failCategory: result.failCategory || null,
      },
    });
  } catch (_) {}
}

/**
 * Persist the discovered cards as a checkpoint so resume-from-checkpoint
 * re-runs only the follow stage against the same cards. We store the
 * full card list (not just usernames) so the follow stage doesn't have
 * to re-scrape — TikTok's search results can shift between runs.
 */
function saveCardsCheckpoint(executionId, cards) {
  if (!executionId) return;
  try {
    checkpointService.saveCheckpoint({
      executionId,
      pipelineId: PIPELINE_ID,
      stage: "search",
      status: "completed",
      payload: {
        cards,
        cardCount: cards.length,
      },
      durationMs: 0,
    });
  } catch (_) {}
}

function loadCardsCheckpoint(executionId) {
  if (!executionId) return null;
  try {
    const cps = checkpointService.getCheckpoints(executionId);
    const cp = cps.find((c) => c.stage === "search" && c.payload_json);
    if (!cp) return null;
    const payload = JSON.parse(cp.payload_json);
    if (Array.isArray(payload.cards)) return payload.cards;
  } catch (_) {}
  return null;
}

// Closure-scoped mutable ref so the search + follow stages can share the
// browser state without serializing it through the checkpoint service.
// (checkpoints persist to SQLite as JSON, so we can't stash a Playwright
// browser handle there.) Declared at module scope so both stages read/write
// the same ref across a single pipeline run.
const browserStateRef = { state: null };

/**
 * Run one cycle of the TikTok mass-follow pipeline.
 *
 * @param {Object} config — see file header for full shape.
 * @returns {Promise<{ success: boolean, summary?: object, error?: string }>}
 */
async function runTikTokMassFollowPipelineNow(config = {}) {
  const {
    search_query: rawQuery = "",
    max_follows_per_run: maxFollowsPerRun = 20,
    follow_interval_min_seconds: intervalMinSec = 40,
    follow_interval_max_seconds: intervalMaxSec = 110,
    max_scrolls: maxScrolls = 3,
    respect_active_window: respectActiveWindow = true,
    trigger = "manual",
  } = config;

  const searchQuery = String(rawQuery || "").trim();
  if (!searchQuery) {
    logger.warn("TIKTOK-MASS-FOLLOW", "No search_query configured — skipping run");
    return { success: false, error: "No search_query configured" };
  }

  // Active-window check — skip the run entirely if TikTok is outside its
  // configured active window AND the user hasn't disabled the check.
  if (respectActiveWindow && !isWithinActiveWindow(platformPolicies.tiktok)) {
    logger.info("TIKTOK-MASS-FOLLOW", "Skipped: outside TikTok active window");
    return {
      success: true,
      summary: {
        skipped: true,
        reason: "outside_active_window",
        discovered: 0,
        sent: 0,
        skipped: 0,
        failed: 0,
      },
    };
  }

  // Daily / hourly cap check — clamp the per-run limit to the remaining headroom.
  const daily = getDailyFollowCount();
  const dailyLimit = getEffectiveDailyLimit();
  const hourly = getHourlyFollowCount();
  const hourlyLimit = getEffectiveHourlyLimit();
  const remainingDaily = Math.max(0, dailyLimit - daily);
  const remainingHourly = Math.max(0, hourlyLimit - hourly);
  const effectiveLimit = Math.max(
    0,
    Math.min(
      Number(maxFollowsPerRun) || 20,
      remainingDaily,
      remainingHourly,
    ),
  );

  if (effectiveLimit === 0) {
    logger.info("TIKTOK-MASS-FOLLOW", `Skipped: daily or hourly cap reached (daily ${daily}/${dailyLimit}, hourly ${hourly}/${hourlyLimit})`);
    return {
      success: true,
      summary: {
        skipped: true,
        reason: "rate_cap_reached",
        daily,
        dailyLimit,
        hourly,
        hourlyLimit,
        discovered: 0,
        sent: 0,
        skipped: 0,
        failed: 0,
      },
    };
  }

  const intervalMin = Math.max(5, Math.floor(Number(intervalMinSec) || 40));
  const intervalMax = Math.max(intervalMin, Math.floor(Number(intervalMaxSec) || 110));

  const jobId = config.executionId || crypto.randomUUID();
  const emit = buildEmitter(jobId);
  const db = getDb();

  // Register the job so force-clear / stop can abort it.
  const controller = jobRegistry.startJob(jobId, {
    pipelineId: PIPELINE_ID,
    type: PIPELINE_ID,
    stage: "search",
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
    if (signal?.aborted) throw new Error("TikTok mass-follow pipeline aborted");
  };
  const isStopped = () => {
    if (lifecycleExecId) {
      try {
        if (pipelineState.isAborted(lifecycleExecId)) return true;
      } catch (_) {}
    }
    return !!signal?.aborted;
  };

  emit({
    stage: "start",
    message: `Run started (trigger: ${trigger}, query: "${searchQuery}", limit: ${effectiveLimit})`,
  });
  logActivity({
    activityType: "pipeline_run",
    entityType: "pipeline",
    entityId: jobId,
    actor: trigger,
    status: "running",
    summary: `TikTok mass-follow pipeline ${jobId} started`,
    details: { searchQuery, effectiveLimit, intervalMin, intervalMax, daily, dailyLimit, hourly, hourlyLimit },
  });

  const summary = {
    query: searchQuery,
    discovered: 0,
    attempted: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    rateCapped: false,
    details: [],
  };

  // ── STAGE 1: search ──────────────────────────────────────────────────────
  let stageStart = Date.now();
  let cards = null;
  try {
    updateLifecycle("search", `Searching TikTok for "${searchQuery}"…`, 5, 0, 3);

    // Resume-from-checkpoint: reuse saved cards if present.
    if (lifecycleExecId && checkpointService.hasCheckpoint(lifecycleExecId, "search")) {
      cards = loadCardsCheckpoint(lifecycleExecId);
      if (Array.isArray(cards) && cards.length > 0) {
        emit({
          stage: "search",
          message: `Resumed from checkpoint: ${cards.length} card(s) cached from previous search`,
        });
      } else {
        cards = null;
      }
    }

    if (!cards) {
      // Honor Pause before launching the browser.
      if (lifecycleExecId) {
        try { await pipelineState.awaitResume(lifecycleExecId, emit); } catch (_) {}
      }
      checkAbort();

      // Launch TikTok browser.
      updateLifecycle("search", "Launching TikTok browser…", 8, 0, 3);
      let browserState;
      try {
        browserState = await browserBase.createBrowser(PLATFORM, {
          headless: process.env.ALLOW_HEADLESS_SOCIAL === "true",
        });
      } catch (err) {
        emit({ stage: "search", level: "error", message: `Browser launch failed: ${err.message}` });
        throw err;
      }

      try {
        const page = browserState.page;
        checkAbort();

        // Navigate to the TikTok user-search page BEFORE scraping.
        // scrapeUserCards() only scrolls + reads the DOM — it never calls
        // page.goto(), so without this step the browser sits on about:blank
        // and we discover zero cards every time. This mirrors what the
        // preview-search endpoint and searchAndFollow() do.
        const searchUrl = tiktokSearch.buildSearchUrl(searchQuery);
        emit({
          stage: "search",
          message: `Navigating to TikTok search: ${searchUrl}`,
        });
        updateLifecycle("search", `Loading TikTok search results…`, 10, 0, 3);
        try {
          await page.goto(searchUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
        } catch (navErr) {
          emit({
            stage: "search",
            level: "error",
            message: `Failed to load search page: ${navErr.message}`,
          });
          throw navErr;
        }

        // Give TikTok's React app a moment to hydrate + render the first
        // batch of user cards before we start scrolling. The page typically
        // paints cards within ~2s on a warm profile; 3s is a safe floor.
        await new Promise((r) => setTimeout(r, 3000));

        // Now scrape — the page is on the search URL, so cards will be in the DOM.
        cards = await tiktokSearch.scrapeUserCards(page, {
          maxScrolls,
          maxCards: Math.max(effectiveLimit * 3, 30),
          emit: (e) => emit({ stage: "search", ...e }),
        });

        // Last-resort refresh-if-empty: scrapeUserCards already retries once
        // internally, but if it still returns zero cards we do one final
        // page.reload() + re-scrape. This catches the case where TikTok's
        // SPA boots but the search XHR silently 4xx'd on the first nav and
        // only succeeds on a fresh document load.
        if (cards.length === 0) {
          emit({
            stage: "search",
            level: "warn",
            message: "First scrape returned 0 cards — reloading search page and retrying once…",
          });
          try {
            await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
            await new Promise((r) => setTimeout(r, 3000));
            cards = await tiktokSearch.scrapeUserCards(page, {
              maxScrolls,
              maxCards: Math.max(effectiveLimit * 3, 30),
              emit: (e) => emit({ stage: "search", ...e }),
            });
          } catch (retryErr) {
            emit({
              stage: "search",
              level: "error",
              message: `Retry scrape failed: ${retryErr.message}`,
            });
          }
        }
      } finally {
        // Close the browser between search + follow stages IF we're not
        // resuming — actually we keep the browser open for the follow
        // stage to avoid a second launch. But scrapeUserCards already
        // navigated; we'll re-use the page. So we DON'T close here.
        // The follow stage will close the browser in its finally block.
        // Stash the browser state on a closure variable the follow stage
        // can read. (We can't pass it through checkpointService because
        // that serializes to JSON.)
        browserStateRef.state = browserState;
      }

      if (cards.length === 0) {
        emit({
          stage: "search",
          level: "warn",
          message: "No user cards found — search may have returned zero results or the page didn't load fully",
        });
      } else {
        emit({
          stage: "search",
          message: `Discovered ${cards.length} user card(s)`,
        });
        saveCardsCheckpoint(lifecycleExecId, cards);
      }
    }

    summary.discovered = cards.length;
    updateLifecycle("search", `Discovered ${cards.length} card(s)`, 15, 1, 3);
  } catch (err) {
    if (lifecycleExecId) {
      checkpointService.saveCheckpoint({
        executionId: lifecycleExecId,
        pipelineId: PIPELINE_ID,
        stage: "search",
        status: "failed",
        error: err,
        durationMs: Date.now() - stageStart,
      });
    }
    // Clean up the browser if we opened one.
    if (browserStateRef.state) {
      try {
        await browserBase.closeBrowser(
          browserStateRef.state.browser,
          PLATFORM,
          browserStateRef.state.context,
          {
            mode: browserStateRef.state.mode,
            tracePath: browserStateRef.state.tracePath,
            shouldCloseBrowser: browserStateRef.state.shouldCloseBrowser,
            lock: browserStateRef.state.lock,
          },
        );
      } catch (_) {}
      browserStateRef.state = null;
    }
    jobRegistry.finishJob(jobId);
    throw err;
  }

  // If no cards were discovered, skip straight to report.
  if (cards.length === 0) {
    if (browserStateRef.state) {
      try {
        await browserBase.closeBrowser(
          browserStateRef.state.browser,
          PLATFORM,
          browserStateRef.state.context,
          {
            mode: browserStateRef.state.mode,
            tracePath: browserStateRef.state.tracePath,
            shouldCloseBrowser: browserStateRef.state.shouldCloseBrowser,
            lock: browserStateRef.state.lock,
          },
        );
      } catch (_) {}
      browserStateRef.state = null;
    }
    if (lifecycleExecId) {
      checkpointService.saveCheckpoint({
        executionId: lifecycleExecId,
        pipelineId: PIPELINE_ID,
        stage: "follow",
        status: "skipped",
        payload: { reason: "no_cards", summary },
        durationMs: 0,
      });
      checkpointService.saveCheckpoint({
        executionId: lifecycleExecId,
        pipelineId: PIPELINE_ID,
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
      summary: `TikTok mass-follow pipeline ${jobId} completed (no cards discovered)`,
      details: summary,
    });
    return { success: true, summary };
  }

  // ── STAGE 2: follow ──────────────────────────────────────────────────────
  stageStart = Date.now();
  // Closure-scoped ref so the search stage can stash the browser state and
  // the follow stage can read it. (Defined after the search stage because
  // JS hoists `var` but not `let`/`const` — we use a mutable object ref.)
  try {
    updateLifecycle("follow", `Following up to ${effectiveLimit} user(s)…`, 20, 1, 3);

    if (lifecycleExecId) {
      try { await pipelineState.awaitResume(lifecycleExecId, emit); } catch (_) {}
    }
    checkAbort();

    // If we don't have a live browser (e.g., resumed from checkpoint),
    // launch one now.
    if (!browserStateRef.state) {
      try {
        browserStateRef.state = await browserBase.createBrowser(PLATFORM, {
          headless: process.env.ALLOW_HEADLESS_SOCIAL === "true",
        });
      } catch (err) {
        emit({ stage: "follow", level: "error", message: `Browser launch failed: ${err.message}` });
        throw err;
      }
    }

    const page = browserStateRef.state.page;

    // If we resumed from checkpoint, we still need to navigate to the
    // search page so the cards are in the DOM for clicking.
    const currentUrl = page.url();
    const expectedUrl = tiktokSearch.buildSearchUrl(searchQuery);
    if (!currentUrl.includes("tiktok.com/search/user") || !currentUrl.includes(`q=${encodeURIComponent(searchQuery)}`)) {
      emit({ stage: "follow", message: `Re-navigating to search page (resumed from checkpoint)…` });
      await page.goto(expectedUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await new Promise((r) => setTimeout(r, 2500));
    }

    // Filter: only follow cards in the 'follow' or 'unknown' state.
    const followable = cards.filter((c) => c.followState === "follow" || c.followState === "unknown");
    const alreadyConnected = cards.length - followable.length;
    summary.skipped += alreadyConnected;
    if (alreadyConnected > 0) {
      emit({
        stage: "follow",
        message: `${alreadyConnected} card(s) already following / pending — skipping`,
      });
    }

    const limit = Math.min(effectiveLimit, followable.length);
    let rateCapped = false;

    for (let i = 0; i < limit; i++) {
      checkAbort();
      if (lifecycleExecId) {
        try { await pipelineState.awaitResume(lifecycleExecId, emit); } catch (_) {}
      }
      if (rateCapped) break;

      const card = followable[i];
      const pct = 20 + Math.floor(((i + 1) / limit) * 70); // 20..90
      summary.attempted += 1;

      emit({
        stage: "follow",
        message: `Following @${card.username} (${i + 1}/${limit})`,
        context: { username: card.username, profileUrl: card.profileUrl },
      });
      updateLifecycle(
        "follow",
        `Following @${card.username} (${i + 1}/${limit})`,
        pct, 1, 3,
      );

      let result;
      try {
        result = await tiktokSearch.followUserCard(page, card, (type, msg) =>
          emit({ stage: "follow", level: type, message: msg }),
        );
      } catch (err) {
        result = { outcome: "failed", reason: err.message, failCategory: null };
      }

      // Recovery: if the click triggered a navigation away from the search
      // page (followUserCard returns failCategory="not_found" with the
      // "search page lost" reason), re-navigate to the search URL so the
      // next card can be located. The follow itself is counted as failed,
      // but we don't burn the rest of the run.
      if (
        result.failCategory === "not_found" &&
        result.reason &&
        result.reason.includes("search page lost")
      ) {
        emit({
          stage: "follow",
          level: "warn",
          message: `Re-navigating to search page after navigation drift…`,
        });
        try {
          await page.goto(expectedUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
          await new Promise((r) => setTimeout(r, 2500));
        } catch (navErr) {
          emit({
            stage: "follow",
            level: "error",
            message: `Re-navigation failed: ${navErr.message}`,
          });
        }
      }

      // Rate-limited → stop the loop immediately (don't attempt more follows
      // this run; they'll all fail and burn the daily cap budget).
      if (result.failCategory === "rate_limited") {
        rateCapped = true;
        summary.rateCapped = true;
        emit({
          stage: "follow",
          level: "error",
          message: `Rate limited by TikTok after @${card.username} — stopping run early`,
        });
      }

      recordFollowOutcome(db, card, result, jobId);

      if (result.outcome === "sent") {
        summary.sent += 1;
      } else if (result.outcome === "already_connected") {
        summary.skipped += 1;
      } else {
        summary.failed += 1;
      }
      summary.details.push({
        username: card.username,
        displayName: card.displayName,
        profileUrl: card.profileUrl,
        followers: card.followers,
        likes: card.likes,
        outcome: result.outcome,
        reason: result.reason || null,
        failCategory: result.failCategory || null,
      });

      emit({
        stage: "follow",
        level: result.outcome === "sent" ? "success" : result.outcome === "failed" ? "error" : "info",
        message: `@${card.username} → ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`,
      });

      // Human-like delay before the next follow (skip after the last one).
      if (i < limit - 1 && !rateCapped) {
        const delaySec = intervalMin + Math.random() * (intervalMax - intervalMin);
        emit({ stage: "follow", message: `Waiting ${delaySec.toFixed(1)}s before next follow…` });
        await sleep(delaySec * 1000, lifecycleExecId);
      }
    }

    if (lifecycleExecId) {
      checkpointService.saveCheckpoint({
        executionId: lifecycleExecId,
        pipelineId: PIPELINE_ID,
        stage: "follow",
        status: "completed",
        payload: {
          sent: summary.sent,
          skipped: summary.skipped,
          failed: summary.failed,
          attempted: summary.attempted,
          discovered: summary.discovered,
          rateCapped: summary.rateCapped,
        },
        durationMs: Date.now() - stageStart,
      });
    }
    updateLifecycle(
      "follow",
      `Followed ${summary.sent}, skipped ${summary.skipped}, failed ${summary.failed}${summary.rateCapped ? " (rate-capped)" : ""}`,
      92, 2, 3,
    );
  } catch (err) {
    if (lifecycleExecId) {
      checkpointService.saveCheckpoint({
        executionId: lifecycleExecId,
        pipelineId: PIPELINE_ID,
        stage: "follow",
        status: "failed",
        error: err,
        durationMs: Date.now() - stageStart,
      });
    }
    throw err;
  } finally {
    // Always close the browser — whether we launched it in the search
    // stage or the follow stage, this is the single owner.
    if (browserStateRef.state) {
      try {
        await browserBase.closeBrowser(
          browserStateRef.state.browser,
          PLATFORM,
          browserStateRef.state.context,
          {
            mode: browserStateRef.state.mode,
            tracePath: browserStateRef.state.tracePath,
            shouldCloseBrowser: browserStateRef.state.shouldCloseBrowser,
            lock: browserStateRef.state.lock,
          },
        );
      } catch (err) {
        logger.warn("TIKTOK-MASS-FOLLOW", `Error closing browser: ${err.message}`);
      }
      browserStateRef.state = null;
    }
  }

  // ── STAGE 3: report ──────────────────────────────────────────────────────
  stageStart = Date.now();
  try {
    updateLifecycle("report", "Writing run summary…", 95, 2, 3);
    emit({
      stage: "report",
      level: "success",
      message: `Run complete — sent: ${summary.sent}, skipped: ${summary.skipped}, failed: ${summary.failed}, discovered: ${summary.discovered}${summary.rateCapped ? " (rate-capped)" : ""}`,
      context: summary,
    });
    if (lifecycleExecId) {
      checkpointService.saveCheckpoint({
        executionId: lifecycleExecId,
        pipelineId: PIPELINE_ID,
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
      summary: `TikTok mass-follow pipeline ${jobId} completed`,
      details: summary,
    });
    return { success: true, summary };
  } catch (err) {
    if (lifecycleExecId) {
      checkpointService.saveCheckpoint({
        executionId: lifecycleExecId,
        pipelineId: PIPELINE_ID,
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
 * only one pipeline runs process-wide at a time.
 */
async function runTikTokMassFollowPipeline(config = {}) {
  return enqueuePipelineRun(
    PIPELINE_ID,
    `${PIPELINE_ID}:${config.trigger || "manual"}:${Date.now()}`,
    () => runTikTokMassFollowPipelineNow(config),
    {
      onQueued: ({ position, activeRun }) => {
        logger.info(
          "TIKTOK-MASS-FOLLOW",
          `TikTok mass-follow pipeline queued at position ${position}; waiting for active run to finish`,
          { activeRun },
        );
      },
    },
  );
}

module.exports = {
  runTikTokMassFollowPipeline,
  runTikTokMassFollowPipelineNow,
  TIKTOK_MASS_FOLLOW_STAGES: STAGES,
  PIPELINE_ID,
  // Exported for tests
  _internal: {
    isWithinActiveWindow,
    getDailyFollowCount,
    getHourlyFollowCount,
    getEffectiveDailyLimit,
    getEffectiveHourlyLimit,
    recordFollowOutcome,
  },
};
