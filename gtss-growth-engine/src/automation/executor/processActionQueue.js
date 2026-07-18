/**
 * Executor — processActionQueue (Main Run Loop)
 *
 * processActionQueue(jobId, sseRes, options) is the heart of the executor:
 * a long-running async function that drains the queued actions
 * (`messages` rows joined with `leads`) and runs each one through
 * runAutomationAction, with all of the operational concerns layered in:
 *
 *   - Per-job ACTIVE_JOB_ID guard (only one run at a time)
 *   - Per-platform browser caching (open once, reuse across all actions
 *     for that platform, close at the end)
 *   - Daily-limit pre-check (skip + snooze until tomorrow)
 *   - Session validity pre-check (skip + emit MANUAL_INTERVENTION_REQUIRED)
 *   - Idempotency fingerprint reservation (skip duplicates)
 *   - CAPTCHA detection (pause the run, release the fingerprint)
 *   - In-loop retry with NON_RETRYABLE_OUTCOMES + NON_RETRYABLE_FAILURE_REASONS
 *   - Per-action outcome recording via recordOutcome
 *   - Post-action session check (re-verify the session)
 *   - Failure-artifact capture (screenshots) on failed outcomes
 *   - Circuit breaker (abort after MAX_CONSECUTIVE_FAILURES in a row)
 *   - Cooldown between profiles (skipped for non-action outcomes like
 *     premium_required / not_connected / already_connected)
 *   - Stray-tab cleanup after every profile (LinkedIn /job-posting etc.)
 *   - Final summary with successes / failures / skipped / waiting / blocked
 *
 * This single function is ~680 lines long. Per the worklog rules, a single
 * function that exceeds 500 lines is allowed to stay in its own file.
 * Splitting it further would require threading 10+ closed-over locals
 * (successes, failures, skipped, consecutiveFailures, browserCache,
 * dmsSentThisRun, connectionsSentThisRun, maxDmsPerRun,
 * maxConnectionsPerRun, jobId, emit) through every extracted helper,
 * which would obscure the run-loop narrative.
 *
 * Extracted from the original automation/executor.js for maintainability.
 */

const {
  getDb,
  increment_action_count,
} = require('../../db/database');
const {
  detectCaptcha,
  captureFailureArtifact,
  checkSessionState,
  closeStrayTabs,
  AUTH_STATES,
} = require('../browserBase');
const { isSessionValid } = require('../sessionManager');
const { startJob, recordEvent } = require('../journal');
const {
  reserveAction,
  releaseActionFingerprint,
} = require('../idempotency');
const logger = require('../../utils/logger');

const { STOP_FLAGS, runtimeState } = require('./state');
const { createEmitter } = require('./emitter');
const { emitState } = require('./emitState');
const { interruptibleDelay } = require('./interruptibleDelay');
const { isWithinLimit } = require('./limits');
const {
  normalizeQueuedActionType,
  determineActionType,
} = require('./actionTypes');
const { getQueuedActions } = require('./queuedActions');
const { recordOutcome } = require('./outcome');
const { runAutomationAction } = require('./actionRouting');
const { getActionDelayRange } = require('./actionDelays');
const {
  closeBrowserState,
  createValidatedBrowser,
} = require('./browserLifecycle');

async function processActionQueue(jobId, sseRes, options = {}) {
  const emit = createEmitter(sseRes);

  if (runtimeState.ACTIVE_JOB_ID) {
    emit(
      'error',
      `Automation run ${runtimeState.ACTIVE_JOB_ID} is already active. Stop it before starting another run.`,
    );
    if (sseRes) sseRes.end();
    return;
  }

  runtimeState.ACTIVE_JOB_ID = jobId;
  STOP_FLAGS.set(jobId, false);
  startJob(jobId, { source: 'automation_queue' });

  emit('info', `Starting automation run (Job ID: ${jobId})`);
  emitState(emit, jobId, 'PENDING', 'Automation run queued.');

  try {
    const {
      filterOutreachPlatforms,
      disabledOutreachDmPlatforms,
      describeStrippedOutreachPlatforms,
    } = require('../../config/pipelineConfig');
    let platforms = Array.isArray(options.platforms)
      ? options.platforms
          .map((platform) => String(platform).trim().toLowerCase())
          .filter(Boolean)
      : [];
    // When the operator selected platforms, strip disabled cold-DM platforms.
    // When no filter was provided (run-all), leave empty so getQueuedActions
    // returns the full queue — we drop blocked rows after fetch (below).
    if (platforms.length > 0) {
      platforms = filterOutreachPlatforms(platforms);
    }
    const actionTypes = Array.isArray(options.actionTypes)
      ? options.actionTypes
          .map((actionType) => normalizeQueuedActionType(actionType))
          .filter(Boolean)
      : [];
    let runnableQueue = getQueuedActions({ platforms, actionTypes });
    let fullQueue = getQueuedActions({
      includeBlocked: true,
      includeWaiting: true,
      platforms,
      actionTypes,
    });

    // Exclude X / Instagram from the automation queue while their DM
    // outreach flags are off (re-enable in Settings → Pipeline Configuration).
    const blocked = new Set(disabledOutreachDmPlatforms());
    if (blocked.size > 0) {
      const beforePlatforms = [
        ...new Set([
          ...runnableQueue.map((a) => a.platform),
          ...fullQueue.map((a) => a.platform),
        ]),
      ];
      runnableQueue = runnableQueue.filter((a) => !blocked.has(a.platform));
      fullQueue = fullQueue.filter((a) => !blocked.has(a.platform));
      const afterPlatforms = [
        ...new Set([
          ...runnableQueue.map((a) => a.platform),
          ...fullQueue.map((a) => a.platform),
        ]),
      ];
      const note = describeStrippedOutreachPlatforms(
        beforePlatforms,
        afterPlatforms,
      );
      if (note) {
        emit(
          'info',
          `Skipping blocked platform queue items — ${note}`,
        );
      }
      if (
        Array.isArray(options.platforms) &&
        options.platforms.length > 0 &&
        platforms.length === 0
      ) {
        emit(
          'warn',
          'No eligible platforms left after excluding disabled DM platforms. Enable X/Instagram DM outreach under Settings, or select LinkedIn / Facebook.',
        );
      }
    }

    const waitingCount = fullQueue.filter(
      (action) => action.status === 'approved' && !action.runnable,
    ).length;
    const blockedCount = fullQueue.filter(
      (action) => action.status === 'blocked',
    ).length;

    emit('info', `Found ${runnableQueue.length} runnable action(s).`);

    if (runnableQueue.length === 0) {
      const summary =
        fullQueue.length === 0
          ? 'Queue is empty — no actions pending.'
          : `Nothing runnable right now. ${waitingCount} waiting (snoozed), ${blockedCount} blocked (manual action required).`;
      emitState(emit, jobId, 'COMPLETED', summary, {
        queueLength: fullQueue.length,
        runnableCount: 0,
        waitingCount,
        blockedCount,
      });
      emit('done', summary, {
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
    // MAX_CONSECUTIVE_FAILURES, the run aborts.
    //
    // NOTE: this must live out here (outer loop scope), not inside the
    // per-action try block below — it's read after the try/catch closes
    // (in the circuit-breaker check), and a `const` declared inside the
    // try block falls out of scope before that check runs, which is what
    // caused "MAX_CONSECUTIVE_FAILURES is not defined" at runtime.
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 5;
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
        'STARTING_BROWSER',
        `Starting browser for ${plat}.`,
        { ...evtBase, fingerprint: fp },
      );
      emitState(emitFn, jobId, 'AUTH_CHECK', `Checking ${plat} session.`, {
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
          logger.warn('AUTOMATION', `Failed to close browser for ${plat}`, {
            error: e.message,
          });
        }
      }
      browserCache.clear();
    }

    for (const action of runnableQueue) {
      if (STOP_FLAGS.get(jobId)) {
        emit('warn', 'Automation stopped by user.');
        emitState(
          emit,
          jobId,
          'MANUAL_INTERVENTION_REQUIRED',
          'Automation stopped by user.',
        );
        break;
      }

      const { platform } = action;
      const actionType = action.action_type || determineActionType(action);
      const isDm = actionType === 'dm' || actionType === 'instagram_dm';
      const isConnection =
        actionType === 'connect' || actionType === 'connection';

      if (
        isDm &&
        typeof maxDmsPerRun === 'number' &&
        dmsSentThisRun >= maxDmsPerRun
      ) {
        emit(
          'info',
          `Stopping DM actions: hit max_dms_per_run cap of ${maxDmsPerRun}.`,
        );
        break;
      }
      if (
        isConnection &&
        typeof maxConnectionsPerRun === 'number' &&
        connectionsSentThisRun >= maxConnectionsPerRun
      ) {
        emit(
          'info',
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
          'warn',
          `Daily limit reached for ${platform} ${actionType}. Will retry tomorrow.`,
        );
        emitState(
          emit,
          jobId,
          'RATE_LIMITED',
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
        emit('error', `No valid session for ${platform}. Please re-auth.`);
        emitState(
          emit,
          jobId,
          'MANUAL_INTERVENTION_REQUIRED',
          `No valid session for ${platform}.`,
          eventBase,
        );
        failures++;
        continue;
      }

      const reservation = reserveAction(action, actionType);
      if (!reservation.reserved) {
        emit(
          'warn',
          `Duplicate ${platform} ${actionType} skipped: ${reservation.reason}`,
        );
        emitState(emit, jobId, 'COMPLETED', 'Duplicate action skipped.', {
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

      // NOTE: outcomeObj MUST be declared in the for-loop body scope (here),
      // NOT inside the try block below. It is read after the try/catch closes
      // (circuit-breaker message, cooldown decision, stray-tab cleanup). The
      // previous code declared it with `let` inside the try, which made it
      // block-scoped to the try — any throw left it undefined in the post-catch
      // zone, raising `ReferenceError: outcomeObj is not defined` and aborting
      // the entire run. This mirrors the same class of bug previously fixed
      // for `consecutiveFailures` / `MAX_CONSECUTIVE_FAILURES` (see comment
      // above). Hoisting here ensures the post-catch code always sees a value.
      let outcomeObj = null;

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
            reason: 'Session validation failed before producing a state',
          };
          emit(
            'error',
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
            outcome: 'session_required',
            reason: `${authState.state}: ${authState.reason}`,
          });
          failures++;
          continue;
        }

        if (await detectCaptcha(browserState.page)) {
          emit('captcha', `CAPTCHA on ${platform} home. Pausing.`, {
            platform,
          });
          emitState(
            emit,
            jobId,
            'CAPTCHA_REQUIRED',
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
          'RUNNING',
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
        // We also track consecutive failures across profiles (counter and
        // MAX_CONSECUTIVE_FAILURES are declared in the outer run-level scope
        // above, since the circuit-breaker check below needs them after this
        // try block closes). If we hit MAX_CONSECUTIVE_FAILURES in a row, we
        // abort the whole run — that's a strong signal something systemic is
        // wrong (session expired, LinkedIn changed selectors, captcha wall,
        // etc.) and continuing would just burn time on doomed attempts.
        const MAX_INLOOP_RETRIES = 2; // 1 initial + 2 retries = 3 attempts max
        const NON_RETRYABLE_OUTCOMES = new Set([
          'sent',
          'premium_required',
          'not_connected',
          'already_connected',
          'session_required',
          'no_posts',
          'skipped',
        ]);
        const NON_RETRYABLE_FAILURE_REASONS = [
          /profile name mismatch/i,
          /message content mismatch/i,
          /wrong-recipient/i,
          /recipient-verification guard/i,
          /modal recipient .* does not match/i,
          // Permanent data / product gates — retrying wastes 3× navigation time.
          /relationship metadata/i,
          /is metadata, not a person/i,
          /pre-navigation identity guard/i,
          /identity guard/i,
          /lead data is corrupt/i,
          /dm editor not found/i,
          /composer did not mount/i,
          /linkedin premium required/i,
        ];

        // Outcomes where we never sent a DM (and often never even opened a
        // composer). For these we must NOT:
        //   - run "Verifying linkedin dm" session checks
        //   - sit in a 60–180s inter-action cooldown
        //   - treat them as automation failures toward the circuit breaker
        const NO_SEND_OUTCOMES = new Set([
          'premium_required',
          'not_connected',
          'already_connected',
          'no_posts',
          'skipped',
          'session_required',
        ]);
        const isNoSendOutcome = (obj) => {
          if (!obj) return false;
          if (NO_SEND_OUTCOMES.has(obj.outcome)) return true;
          // Permanent data / product gates recorded as outcome:failed
          if (obj.outcome === 'failed') {
            return NON_RETRYABLE_FAILURE_REASONS.some((pattern) =>
              pattern.test(String(obj.reason || '')),
            );
          }
          return false;
        };

        // outcomeObj is declared in the outer (for-loop body) scope above the
        // try block, so the post-catch circuit-breaker / cooldown / cleanup
        // code can read it safely even when the try throws before assignment.
        for (let attempt = 1; attempt <= MAX_INLOOP_RETRIES + 1; attempt++) {
          if (STOP_FLAGS.get(jobId)) {
            outcomeObj = { outcome: 'skipped', reason: 'Stopped by user' };
            break;
          }
          outcomeObj = await runAutomationAction(action, browserState, emit);

          // Success or non-retryable → done.
          if (
            !outcomeObj ||
            outcomeObj.outcome === 'sent' ||
            NON_RETRYABLE_OUTCOMES.has(outcomeObj.outcome) ||
            NON_RETRYABLE_FAILURE_REASONS.some((pattern) =>
              pattern.test(String(outcomeObj.reason || '')),
            )
          ) {
            break;
          }

          // Retryable failure — try again if we have attempts left.
          if (attempt <= MAX_INLOOP_RETRIES) {
            emit(
              'warn',
              `Attempt ${attempt} failed (${outcomeObj.reason || outcomeObj.outcome}). Retrying (${attempt}/${MAX_INLOOP_RETRIES})...`,
            );
            await interruptibleDelay(2000, 4000, jobId);
            if (STOP_FLAGS.get(jobId)) break;
          }
        }

        // Post-action session check ONLY when we actually attempted a send
        // (or a transient failure that might be session-related).
        // Premium / not-connected / metadata skips never sent a DM — running
        // "Verifying linkedin dm" here was confusing and wasted time.
        if (outcomeObj?.outcome === 'sent' || !isNoSendOutcome(outcomeObj)) {
          emitState(
            emit,
            jobId,
            'VERIFYING',
            `Verifying ${platform} ${actionType}.`,
            { ...eventBase, fingerprint: reservation.fingerprint },
          );
          await checkSessionState(browserState.page, platform, emit, {
            label: `post-action-session-${actionType}-${action.message_id}`,
          });
        } else {
          emit(
            'info',
            `Skipping post-action verify for ${outcomeObj.outcome}` +
              (outcomeObj.reason ? ` (${String(outcomeObj.reason).slice(0, 80)})` : '') +
              ' — no DM was sent.',
          );
        }

        // Screenshots only for unexpected send failures — not for premium
        // walls or bad lead data we already classified.
        if (outcomeObj.outcome === 'failed' && !isNoSendOutcome(outcomeObj)) {
          // Hardened: captureFailureArtifact must not throw even if the
          // artifacts dir is unwritable. Wrap in try/catch as belt-and-
          // suspenders so the original failure reason isn't masked.
          try {
            const screenshot = await captureFailureArtifact(
              browserState.page,
              platform,
              `${actionType}-${action.message_id}-${outcomeObj.reason || 'failed'}`,
            );
            if (screenshot) {
              outcomeObj.reason = `${outcomeObj.reason || 'Failed'} | screenshot: ${screenshot}`;
            }
          } catch (artifactErr) {
            logger.warn(
              'AUTOMATION',
              `captureFailureArtifact failed: ${artifactErr.message}`,
            );
          }
        }

        recordOutcome(action, actionType, outcomeObj);
        recordEvent({
          jobId,
          ...eventBase,
          status: outcomeObj.outcome === 'sent' ? 'COMPLETED' : 'FAILED',
          warningDetected: /warning|captcha|limit|blocked|session/i.test(
            outcomeObj.reason || '',
          ),
          details: {
            outcome: outcomeObj.outcome,
            reason: outcomeObj.reason,
            fingerprint: reservation.fingerprint,
          },
        });

        if (outcomeObj.outcome === 'sent') {
          successes++;
          consecutiveFailures = 0; // reset circuit breaker on success
          if (actionType === 'dm' || actionType === 'instagram_dm') {
            dmsSentThisRun++;
          }
          if (actionType === 'connect' || actionType === 'connection') {
            connectionsSentThisRun++;
          }
        } else if (isNoSendOutcome(outcomeObj)) {
          releaseActionFingerprint(reservation.fingerprint);
          skipped++;
          // premium_required / not_connected / metadata / identity gates are
          // NOT automation failures — don't trip the circuit breaker.
          consecutiveFailures = 0;
        } else {
          releaseActionFingerprint(reservation.fingerprint);
          failures++;
          consecutiveFailures++;
        }
      } catch (err) {
        logger.error('AUTOMATION', `Error on action ${action.message_id}`, err);
        emit('error', `Unexpected error: ${err.message}`);
        // Capture a failure screenshot for debugging — but never let this
        // mask the original automation error. If the artifacts dir is
        // unwritable (e.g. user pointed AUTOMATION_ARTIFACTS_DIR at
        // /var/log/... without root), captureFailureArtifact must NOT
        // throw here, because that throw would escape this catch block
        // and bubble to the outer executor catch, aborting the entire
        // run. captureFailureArtifact is hardened, but we add a belt-
        // and-suspenders try/catch here as well.
        try {
          const cached = browserCache.get(platform);
          if (cached && cached.page && !cached.page.isClosed()) {
            await captureFailureArtifact(
              cached.page,
              platform,
              `${actionType}-${action.message_id}-exception`,
            );
          }
        } catch (artifactErr) {
          logger.warn(
            'AUTOMATION',
            `captureFailureArtifact failed: ${artifactErr.message}`,
          );
        }
        emitState(emit, jobId, 'FAILED', `Action failed: ${err.message}`, {
          ...eventBase,
          fingerprint: reservation.fingerprint,
        });
        releaseActionFingerprint(reservation.fingerprint);
        // Record the outcome object in the outer scope so the post-catch
        // circuit-breaker / cooldown code below see a real value instead of
        // null. Without this, `outcomeObj?.outcome` would fall back to
        // "exception" — accurate, but we can be more precise.
        outcomeObj = { outcome: 'failed', reason: err.message };
        recordOutcome(action, actionType, outcomeObj);
        failures++;
        consecutiveFailures++;
      }

      // ── Post-action bookkeeping (circuit breaker + cooldown + cleanup) ───────
      // This entire section is wrapped in a try/catch so that any error here
      // (e.g. a future bug in emitState, interruptibleDelay, or closeStrayTabs)
      // is logged but does NOT abort the whole run. Previously this section
      // was unprotected — a single throw here escaped to the outer executor
      // catch and skipped all remaining profiles, AND skipped the per-profile
      // stray-tab cleanup, causing /job-posting tabs to accumulate.
      try {
        // ── Circuit breaker: too many consecutive failures ───────────────────
        // If we hit MAX_CONSECUTIVE_FAILURES in a row, abort the whole run —
        // something systemic is wrong (session expired, selectors changed,
        // captcha wall) and continuing would just burn time on doomed attempts.
        if (
          consecutiveFailures >= MAX_CONSECUTIVE_FAILURES &&
          !STOP_FLAGS.get(jobId)
        ) {
          emit(
            'error',
            `Aborting run: ${consecutiveFailures} consecutive failures (circuit breaker). ` +
              `Last outcome: ${outcomeObj?.outcome || 'exception'} — ${outcomeObj?.reason || ''}. ` +
              `Check that your LinkedIn session is still valid and that LinkedIn hasn't changed its UI.`,
          );
          emitState(
            emit,
            jobId,
            'MANUAL_INTERVENTION_REQUIRED',
            `Run aborted after ${consecutiveFailures} consecutive failures.`,
            { ...eventBase, consecutiveFailures },
          );
          break;
        }

        // ── Cooldown between profiles ────────────────────────────────────────
        // SKIP the full 60–180s cooldown whenever we did not actually send
        // (premium wall, not connected, metadata lead names, identity guards,
        // composer never mounted, etc.). Only real sends / transient failures
        // need the anti-rate-limit pause.
        const SKIP_COOLDOWN_OUTCOMES = new Set([
          'premium_required',
          'not_connected',
          'already_connected',
          'no_posts',
          'skipped',
          'session_required',
        ]);
        const PERMANENT_FAIL_SKIP_COOLDOWN = [
          /relationship metadata/i,
          /is metadata, not a person/i,
          /pre-navigation identity guard/i,
          /identity guard/i,
          /lead data is corrupt/i,
          /dm editor not found/i,
          /composer did not mount/i,
          /linkedin premium required/i,
          /profile name mismatch/i,
          /message content mismatch/i,
          /wrong-recipient/i,
          /recipient-verification guard/i,
          // Infra / lock failures — waiting 60–180s does not free the browser.
          /browser profile is already in use/i,
          /stale lock/i,
          /already in use for linkedin/i,
        ];
        const shouldSkipCooldown = outcomeObj
          ? SKIP_COOLDOWN_OUTCOMES.has(outcomeObj.outcome) ||
            (outcomeObj.outcome === 'failed' &&
              PERMANENT_FAIL_SKIP_COOLDOWN.some((re) =>
                re.test(String(outcomeObj.reason || '')),
              ))
          : false;

        if (
          runnableQueue.indexOf(action) < runnableQueue.length - 1 &&
          !STOP_FLAGS.get(jobId) &&
          !shouldSkipCooldown
        ) {
          const delay = getActionDelayRange(platform, actionType);
          emitState(emit, jobId, 'COOLDOWN', 'Cooling down before next action.', {
            ...eventBase,
            minDelayMs: delay.min,
            maxDelayMs: delay.max,
          });
          emit(
            'info',
            `Cooling down before next action (${Math.round(delay.min / 1000)}-${Math.round(delay.max / 1000)}s).`,
          );
          await interruptibleDelay(delay.min, delay.max, jobId);
        } else if (shouldSkipCooldown && !STOP_FLAGS.get(jobId)) {
          // Brief pause only — enough for the browser to settle, not enough to
          // waste time. Lets us move to the next profile almost immediately.
          emit(
            'info',
            `Skipping cooldown for ${outcomeObj?.outcome || 'skipped'} — moving to next profile.`,
          );
          await interruptibleDelay(400, 900, jobId);
        }
      } catch (bookkeepingErr) {
        // Never let a bug in cooldown / circuit-breaker accounting abort the
        // entire run. Log it and continue to the next profile.
        logger.error(
          'AUTOMATION',
          `Post-action bookkeeping failed for ${action.message_id}: ${bookkeepingErr.message}`,
        );
        emit('warn', `Post-action bookkeeping error (continuing): ${bookkeepingErr.message}`);
      }

      // ── Stray-tab cleanup after every profile ─────────────────────────────
      // LinkedIn may have spawned a /job-posting tab during this action (e.g.
      // by auto-redirecting after a premium dialog). Close any stray tabs
      // before moving to the next profile so they don't accumulate.
      //
      // This is intentionally OUTSIDE the bookkeeping try/catch above so that
      // even if cooldown threw, we still clean up stray tabs. It has its own
      // try/catch because closeStrayTabs touches the browser context and we
      // never want a cleanup failure to abort the run.
      try {
        const cached = browserCache.get(platform);
        if (
          cached &&
          cached.context &&
          typeof cached.context.pages === 'function'
        ) {
          await closeStrayTabs(cached.context, platform);
        }
      } catch (cleanupErr) {
        logger.warn(
          'AUTOMATION',
          `Stray-tab cleanup failed for ${platform}: ${cleanupErr.message}`,
        );
      }
    }

    // Close all browsers only after the ENTIRE run is done
    await closeAllCachedBrowsers();

    const remainingQueue = getQueuedActions({
      includeBlocked: true,
      includeWaiting: true,
      platforms,
    });
    const remainingWaiting = remainingQueue.filter(
      (action) => action.status === 'approved' && !action.runnable,
    ).length;
    const remainingBlocked = remainingQueue.filter(
      (action) => action.status === 'blocked',
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
      failures > 0 ? 'FAILED' : 'COMPLETED',
      'Automation run completed.',
      summary,
    );
    emit('done', 'Automation run completed.', summary);
    return summary;
  } catch (error) {
    logger.error('AUTOMATION', 'Executor failure', error);
    emitState(emit, jobId, 'FAILED', `Executor error: ${error.message}`, {
      error: error.message,
    });
    emit('error', `Executor error: ${error.message}`);
  } finally {
    runtimeState.ACTIVE_JOB_ID = null;
    STOP_FLAGS.delete(jobId);
    if (sseRes) sseRes.end();
  }
}

module.exports = { processActionQueue };
