const { getDb, isWithinLimit: dbIsWithinLimit, normalizeActionType } = require('../db/database');
const { createBrowser, closeBrowser, humanDelay, detectCaptcha, checkSessionState, AUTH_STATES, captureFailureArtifact } = require('./browserBase');
const { isSessionValid } = require('./sessionManager');
const { startJob, updateJobStatus, recordEvent } = require('./journal');
const { reserveAction, releaseActionFingerprint } = require('./idempotency');
const logger = require('../utils/logger');

const STOP_FLAGS = new Map();
let ACTIVE_JOB_ID = null;
let RUN_QUEUE = Promise.resolve();

function createEmitter(sseRes) {
  return (type, message, data = {}) => {
    if (!sseRes) return;
    const payload = JSON.stringify({ type, message, timestamp: new Date().toISOString(), ...data });
    sseRes.write(`data: ${payload}\n\n`);
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
    details
  });
  emit('state', message || status, { status, ...details });
}

/**
 * Robust check for daily limits.
 */
function isWithinLimit(platform, actionType) {
  // Always fetch fresh limit from config to ensure we don't exceed even if settings change
  return dbIsWithinLimit(platform, actionType);
}

function getQueuedActions() {
  const db = getDb();
  return db.prepare(`
    SELECT m.id AS message_id, m.platform, m.body, m.variant, m.is_follow_up, m.lead_id,
           l.name AS lead_name, l.profile_url, l.status AS lead_status
    FROM messages m
    JOIN leads l ON m.lead_id = l.id
    WHERE m.status = 'approved' AND (m.snooze_until IS NULL OR m.snooze_until <= datetime('now'))
    ORDER BY m.approved_at ASC
  `).all();
}

function determineActionType(message) {
  if (message.platform !== 'linkedin') return 'dm';
  if (message.is_follow_up) return 'dm';

  // Check if a connection request was already sent to this lead
  const db = getDb();
  const priorConnect = db.prepare(`
    SELECT id FROM touchpoints
    WHERE lead_id = ? AND type = 'connections' AND outcome = 'sent'
    LIMIT 1
  `).get(message.lead_id);

  return priorConnect ? 'dm' : 'connect';
}

async function runAutomationAction(action, browserState, emit) {
  const { platform } = action;
  const actionType = determineActionType(action);
  let automationModule;

  try {
    automationModule = require(`./${platform}`);
  } catch (err) {
    emit('error', `Automation module for ${platform} not implemented.`);
    return { outcome: 'failed', reason: 'Module not implemented' };
  }

  const { page } = browserState;

  if (actionType === 'connect' && automationModule.sendConnectionRequest) {
    if (automationModule.likeRecentPost) {
      emit('info', 'Warming up: liking a recent post...');
      await automationModule.likeRecentPost(page, action.profile_url, emit);
      await humanDelay(3000, 6000);
    }
    return await automationModule.sendConnectionRequest(page, action.profile_url, action.body, emit);
  } else if (actionType === 'dm' && automationModule.sendDirectMessage) {
    return await automationModule.sendDirectMessage(page, action.profile_url, action.body, emit);
  } else {
    emit('error', `Action ${actionType} not supported for ${platform}.`);
    return { outcome: 'failed', reason: 'Unsupported action' };
  }
}

function recordOutcome(action, actionType, outcomeObj) {
  const db = getDb();
  const { outcome, reason } = outcomeObj;
  const normalizedActionType = normalizeActionType(actionType);

  db.prepare(`
    INSERT INTO daily_actions (platform, action_type, lead_id, outcome)
    VALUES (?, ?, ?, ?)
  `).run(action.platform, normalizedActionType, action.lead_id, outcome);

  db.prepare(`
    INSERT INTO touchpoints (lead_id, type, platform, message_id, outcome, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(action.lead_id, normalizedActionType, action.platform, action.message_id, outcome, reason || null);

  if (outcome === 'sent') {
    db.prepare(`UPDATE messages SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(action.message_id);

    // For LinkedIn connect actions, queue the DM body as a new pending message
    // so it fires once the connection is accepted (on the next queue run)
    if (normalizedActionType === 'connections') {
      const originalMessage = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(action.message_id);
      if (originalMessage) {
        const existing = db.prepare(`
          SELECT id FROM messages
          WHERE lead_id = ? AND status IN ('pending','approved') AND is_follow_up = 0
          LIMIT 1
        `).get(action.lead_id);

        if (!existing) {
          db.prepare(`
            INSERT INTO messages (lead_id, platform, body, variant, is_follow_up, status, generated_at)
            VALUES (?, ?, ?, 'A', 0, 'pending', CURRENT_TIMESTAMP)
          `).run(
            action.lead_id,
            action.platform,
            originalMessage.body
          );
        }
      }
    }

    const lead = db.prepare(`SELECT status FROM leads WHERE id = ?`).get(action.lead_id);
    if (lead && ['discovered', 'qualified', 'deprioritized', 'scoring_failed'].includes(lead.status)) {
       db.prepare(`UPDATE leads SET status = 'messaged', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
         .run(action.lead_id);
    }
  } else if (outcome === 'failed') {
    db.prepare(`
      UPDATE messages
      SET retry_count = retry_count + 1,
          last_error = ?,
          status = 'approved',
          snooze_until = datetime('now', '+' || MIN((retry_count + 1) * 60, 1440) || ' minutes')
      WHERE id = ?
    `).run(reason, action.message_id);
  } else if (outcome === 'not_connected') {
    // Give the connection time to be accepted without burning a send retry.
    db.prepare(`
      UPDATE messages
      SET snooze_until = datetime('now', '+24 hours')
      WHERE id = ?
    `).run(action.message_id);
  } else if (outcome === 'session_required') {
    db.prepare(`
      UPDATE messages
      SET last_error = ?,
          snooze_until = datetime('now', '+1 hour')
      WHERE id = ?
    `).run(reason, action.message_id);
  } else if (outcome === 'unknown') {
    db.prepare(`
      UPDATE messages
      SET last_error = ?,
          status = 'approved',
          snooze_until = datetime('now', '+1 hour')
      WHERE id = ?
    `).run(reason, action.message_id);
  } else if (outcome === 'limit_reached') {
    // Snooze until next day instead of permanently failing
    db.prepare(`
      UPDATE messages
      SET snooze_until = date('now', 'localtime', '+1 day')
      WHERE id = ?
    `).run(action.message_id);
  } else if (outcome === 'already_connected' || outcome === 'no_posts') {
    // These are genuine "nothing to do" states
    db.prepare(`UPDATE messages SET status = 'skipped' WHERE id = ?`).run(action.message_id);
  } else if (outcome === 'skipped') {
    // Generic skip — only snooze, keep status as 'approved' for retry
    db.prepare(`
      UPDATE messages
      SET snooze_until = datetime('now', '+1 hour')
      WHERE id = ?
    `).run(action.message_id);
  }
}

function parseDelayRange(value, fallback) {
  if (!value) return fallback;
  const parts = String(value).split(',').map((part) => Number(part.trim()));
  if (parts.length !== 2 || parts.some((part) => Number.isNaN(part))) return fallback;
  return { min: Math.min(parts[0], parts[1]), max: Math.max(parts[0], parts[1]) };
}

function getActionDelayRange(platform, actionType) {
  const platformKey = `${platform}_${actionType}_DELAY_MS`.toUpperCase();
  return parseDelayRange(
    process.env[platformKey] || process.env.AUTOMATION_ACTION_DELAY_MS,
    { min: 60_000, max: 180_000 }
  );
}

async function closeBrowserState(browserState, platform) {
  if (!browserState) return;
  await closeBrowser(browserState.browser, platform, browserState.context, {
    mode: browserState.mode,
    tracePath: browserState.tracePath,
    shouldCloseBrowser: browserState.shouldCloseBrowser,
    lock: browserState.lock
  });
}

function getSessionCheckUrl(platform) {
  if (platform === 'linkedin') return 'https://www.linkedin.com/feed/';
  if (platform === 'x') return 'https://x.com/home';
  return `https://www.${platform}.com`;
}

async function openSessionCheckPage(page, platform) {
  const url = getSessionCheckUrl(platform);
  const waitUntil = platform === 'linkedin' ? 'networkidle' : 'domcontentloaded';

  await page.goto(url, { waitUntil, timeout: 60000 }).catch(async (error) => {
    logger.warn('AUTOMATION', `Session check navigation did not fully settle for ${platform}`, {
      error: error.message,
      url
    });
    if (!page.isClosed() && page.url() !== url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
  });

  if (platform === 'linkedin') {
    await humanDelay(5000, 8000);
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
        emit('warn', `${platform} auth check returned ${lastState.state}; retrying session recovery (${attempt}/${attempts - 1}).`, {
          platform,
          authState: lastState.state,
          reason: lastState.reason,
        });
        await browserState.page.reload({ waitUntil: platform === 'linkedin' ? 'networkidle' : 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await humanDelay(5000, 8000);
      }
    } finally {
      if (browserState && (!lastState || lastState.state !== AUTH_STATES.AUTHENTICATED)) {
        await closeBrowserState(browserState, platform);
      }
    }
  }

  return { browserState: null, authState: lastState };
}

async function processActionQueue(jobId, sseRes) {
  const emit = createEmitter(sseRes);

  if (ACTIVE_JOB_ID) {
    emit('error', `Automation run ${ACTIVE_JOB_ID} is already active. Stop it before starting another run.`);
    if (sseRes) sseRes.end();
    return;
  }

  ACTIVE_JOB_ID = jobId;
  STOP_FLAGS.set(jobId, false);
  startJob(jobId, { source: 'automation_queue' });

  emit('info', `Starting automation run (Job ID: ${jobId})`);
  emitState(emit, jobId, 'PENDING', 'Automation run queued.');

  try {
    const queue = getQueuedActions();
    emit('info', `Found ${queue.length} actions in queue.`);

    if (queue.length === 0) {
      emitState(emit, jobId, 'COMPLETED', 'Queue is empty.', { queueLength: 0 });
      emit('done', 'Queue is empty.');
      return;
    }

    let successes = 0;
    let failures = 0;
    let skipped = 0;

    for (const action of queue) {
      if (STOP_FLAGS.get(jobId)) {
        emit('warn', 'Automation stopped by user.');
        emitState(emit, jobId, 'MANUAL_INTERVENTION_REQUIRED', 'Automation stopped by user.');
        break;
      }

      const { platform } = action;
      const actionType = determineActionType(action);
      const eventBase = {
        platform,
        actionType,
        target: action.profile_url,
        messageId: action.message_id,
        leadId: action.lead_id
      };

      // 1. Double check limits right before action
      if (!isWithinLimit(platform, actionType)) {
        emit('warn', `Daily limit reached for ${platform} ${actionType}. Will retry tomorrow.`);
        emitState(emit, jobId, 'RATE_LIMITED', `Daily limit reached for ${platform} ${actionType}.`, eventBase);
        // Snooze until midnight so it re-queues on the next calendar day
        const db = getDb();
        db.prepare(`
          UPDATE messages
          SET snooze_until = date('now', 'localtime', '+1 day')
          WHERE id = ?
        `).run(action.message_id);
        skipped++;
        continue;
      }

      if (!isSessionValid(platform)) {
        emit('error', `No valid session for ${platform}. Please re-auth.`);
        emitState(emit, jobId, 'MANUAL_INTERVENTION_REQUIRED', `No valid session for ${platform}.`, eventBase);
        failures++;
        continue;
      }

      const reservation = reserveAction(action, actionType);
      if (!reservation.reserved) {
        emit('warn', `Duplicate ${platform} ${actionType} skipped: ${reservation.reason}`);
        emitState(emit, jobId, 'COMPLETED', 'Duplicate action skipped.', { ...eventBase, fingerprint: reservation.fingerprint, reason: reservation.reason });
        recordOutcome(action, actionType, { outcome: 'skipped', reason: reservation.reason });
        skipped++;
        continue;
      }

      let browserState = null;
      try {
        emitState(emit, jobId, 'STARTING_BROWSER', `Starting browser for ${platform}.`, { ...eventBase, fingerprint: reservation.fingerprint });
        emitState(emit, jobId, 'AUTH_CHECK', `Checking ${platform} session.`, { ...eventBase, fingerprint: reservation.fingerprint });
        const validated = await createValidatedBrowser(platform, emit);
        browserState = validated.browserState;

        if (!browserState) {
          const authState = validated.authState || { state: AUTH_STATES.UNKNOWN_STATE, reason: 'Session validation failed before producing a state' };
          emit('error', `${platform} session is not automation-ready: ${authState.state}. ${authState.reason}`);
          emitState(emit, jobId, authState.state, `${platform} session is not automation-ready.`, {
            ...eventBase,
            fingerprint: reservation.fingerprint,
            authState: authState.state,
            reason: authState.reason,
            screenshotPath: authState.screenshotPath,
            htmlPath: authState.htmlPath,
          });
          releaseActionFingerprint(reservation.fingerprint);
          recordOutcome(action, actionType, {
            outcome: 'session_required',
            reason: `${authState.state}: ${authState.reason}`,
          });
          failures++;
          continue;
        }

        if (await detectCaptcha(browserState.page)) {
           emit('captcha', `CAPTCHA on ${platform} home. Pausing.`, { platform });
           emitState(emit, jobId, 'CAPTCHA_REQUIRED', `CAPTCHA on ${platform} home.`, { ...eventBase, fingerprint: reservation.fingerprint, warningDetected: true });
           releaseActionFingerprint(reservation.fingerprint);
           break;
        }

        emitState(emit, jobId, 'RUNNING', `Running ${platform} ${actionType}.`, { ...eventBase, fingerprint: reservation.fingerprint });
        const outcomeObj = await runAutomationAction(action, browserState, emit);
        
        // Post-action session check
        emitState(emit, jobId, 'VERIFYING', `Verifying ${platform} ${actionType}.`, { ...eventBase, fingerprint: reservation.fingerprint });
        await checkSessionState(browserState.page, platform, emit, {
          label: `post-action-session-${actionType}-${action.message_id}`,
        });

        if (outcomeObj.outcome === 'failed') {
          const screenshot = await captureFailureArtifact(browserState.page, platform, `${actionType}-${action.message_id}-${outcomeObj.reason || 'failed'}`);
          if (screenshot) {
            outcomeObj.reason = `${outcomeObj.reason || 'Failed'} | screenshot: ${screenshot}`;
          }
        }

        recordOutcome(action, actionType, outcomeObj);
        recordEvent({
          jobId,
          ...eventBase,
          status: outcomeObj.outcome === 'sent' ? 'COMPLETED' : 'FAILED',
          warningDetected: /warning|captcha|limit|blocked|session/i.test(outcomeObj.reason || ''),
          details: { outcome: outcomeObj.outcome, reason: outcomeObj.reason, fingerprint: reservation.fingerprint }
        });

        if (outcomeObj.outcome === 'sent') successes++;
        else if (['skipped', 'already_connected', 'no_posts', 'not_connected', 'session_required'].includes(outcomeObj.outcome)) {
          releaseActionFingerprint(reservation.fingerprint);
          skipped++;
        } else {
          releaseActionFingerprint(reservation.fingerprint);
          failures++;
        }

      } catch (err) {
        logger.error('AUTOMATION', `Error on action ${action.message_id}`, err);
        emit('error', `Unexpected error: ${err.message}`);
        if (browserState && browserState.page) {
          await captureFailureArtifact(browserState.page, platform, `${actionType}-${action.message_id}-exception`);
        }
        emitState(emit, jobId, 'FAILED', `Action failed: ${err.message}`, { ...eventBase, fingerprint: reservation.fingerprint });
        releaseActionFingerprint(reservation.fingerprint);
        recordOutcome(action, actionType, { outcome: 'failed', reason: err.message });
        failures++;
      } finally {
        await closeBrowserState(browserState, platform);
      }

      if (queue.indexOf(action) < queue.length - 1 && !STOP_FLAGS.get(jobId)) {
        const delay = getActionDelayRange(platform, actionType);
        emitState(emit, jobId, 'COOLDOWN', 'Cooling down before next action.', { ...eventBase, minDelayMs: delay.min, maxDelayMs: delay.max });
        emit('info', `Cooling down before next action (${Math.round(delay.min / 1000)}-${Math.round(delay.max / 1000)}s).`);
        await humanDelay(delay.min, delay.max);
      }
    }

    emitState(emit, jobId, failures > 0 ? 'FAILED' : 'COMPLETED', 'Automation run completed.', { successes, failures, skipped });
    emit('done', 'Automation run completed.', { successes, failures, skipped });

  } catch (error) {
    logger.error('AUTOMATION', 'Executor failure', error);
    emitState(emit, jobId, 'FAILED', `Executor error: ${error.message}`, { error: error.message });
    emit('error', `Executor error: ${error.message}`);
  } finally {
    ACTIVE_JOB_ID = null;
    STOP_FLAGS.delete(jobId);
    if (sseRes) sseRes.end();
  }
}

function enqueueActionQueue(jobId, sseRes) {
  const run = () => processActionQueue(jobId, sseRes);
  const queuedRun = RUN_QUEUE.then(run, run);
  RUN_QUEUE = queuedRun.catch((error) => {
    logger.error('AUTOMATION', 'Queued automation run failed', error);
  });
  return queuedRun;
}

async function authenticatePlatform(platform) {
  logger.info('AUTH', `Starting manual auth for ${platform}`);

  const browserState = await createBrowser(platform, { headless: false });
  const { page } = browserState;

  let loginUrl = `https://www.${platform}.com/login`;
  if (platform === 'linkedin') loginUrl = 'https://www.linkedin.com/login';
  else if (platform === 'x') loginUrl = 'https://x.com/i/flow/login';

  await page.goto(loginUrl);

  return new Promise((resolve, reject) => {
    let checkInterval;
    const timeout = setTimeout(async () => {
      clearInterval(checkInterval);
      try { await closeBrowserState(browserState, platform); } catch(e){}
      reject(new Error('Auth timeout (5 mins)'));
    }, 5 * 60 * 1000);

    checkInterval = setInterval(async () => {
      try {
        if (page.isClosed()) {
           clearInterval(checkInterval);
           clearTimeout(timeout);
           reject(new Error('Browser closed'));
           return;
        }

        const url = page.url();
        let isLoggedIn = false;
        if (platform === 'linkedin' && url.includes('/feed')) isLoggedIn = true;
        if (platform === 'x' && url.includes('/home')) isLoggedIn = true;
        if (platform === 'facebook' && url === 'https://www.facebook.com/') isLoggedIn = true;
        if (platform === 'instagram' && url === 'https://www.instagram.com/') isLoggedIn = true;

        if (isLoggedIn) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          await closeBrowserState(browserState, platform);
          resolve(true);
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
  getQueuedActions,
  isWithinLimit
};
