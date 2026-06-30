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
const { getContext } = require("../services/contextService");
const {
  calculateBackoffDelay,
  recordCampaignEvent,
  getNextDayBusinessHourWindow,
  queueLog,
} = require("./utils/campaignUtils");
const { sendNotification } = require("../services/notificationService");

// ── GLOBAL STOP FLAG (shared with executor.js via stopDmQueue()) ──────────────
//
// The executor's STOP_FLAGS only stops the automation-page-triggered queue
// (Runner A). The campaign cron-triggered DM queue (Runner B) had NO stop
// mechanism at all — once a cron tick started processDmQueue, it ran to
// completion. This global flag lets the automation page's stop button halt
// the cron queue too: stopDmQueue() sets this to true, and the loop checks
// it between profiles and inside the cooldown sleep.
let DM_QUEUE_STOPPED = false;

/**
 * Halt the in-flight DM queue (if any). Called by the automation route's
 * stop endpoint. Idempotent — safe to call multiple times.
 */
function stopDmQueue() {
  DM_QUEUE_STOPPED = true;
}

/**
 * Reset the stop flag. Called at the START of each processDmQueue run so a
 * previous stop doesn't permanently disable future cron runs.
 */
function resetDmQueueStopFlag() {
  DM_QUEUE_STOPPED = false;
}

/**
 * Check whether the queue has been stopped.
 */
function isDmQueueStopped() {
  return DM_QUEUE_STOPPED;
}

// ── SCHEMA AUTO-UPGRADE (DEFENSIVE STARTUP INITIALIZATION) ───────────────────
const db = getDb();
try {
  const dmCols = db
    .prepare("PRAGMA table_info(dm_jobs)")
    .all()
    .map((c) => c.name);
  if (!dmCols.includes("retry_count")) {
    db.exec("ALTER TABLE dm_jobs ADD COLUMN retry_count INTEGER DEFAULT 0");
  }
  if (!dmCols.includes("next_retry_at")) {
    db.exec("ALTER TABLE dm_jobs ADD COLUMN next_retry_at TEXT");
  }
} catch (err) {
  console.error(
    "[DM-QUEUE] Defensively handled schema migration error on startup:",
    err.message,
  );
}

// ── PROFILE URL NORMALIZATION HELPERS ────────────────────────────────────────
/**
 * Normalises a social profile URL to a canonical, lowercase, protocol-free,
 * trailing-slash-free, query-param-free string used for cross-lead deduplication.
 *
 * Examples that all collapse to the same value:
 *   https://www.linkedin.com/in/brian/
 *   https://linkedin.com/in/brian?trk=abc
 *   HTTPS://WWW.LINKEDIN.COM/IN/BRIAN
 *
 * @param {string} url
 * @returns {string} Normalised URL or '' if input is falsy
 */
function normalizeProfileUrl(url) {
  if (!url) return "";
  return String(url)
    .toLowerCase()
    .trim()
    .split("?")[0] // drop query params (trk=, originalSubdomain=, etc.)
    .replace(/\/+$/, "") // drop trailing slashes
    .replace(/^https?:\/\/(www\.)?/, ""); // drop protocol + optional www
}

/**
 * Returns every realistic stored form of a normalised profile URL so we can
 * match across leads whose URLs were saved with or without https/www/slash.
 *
 * @param {string} normalized - Output of normalizeProfileUrl()
 * @returns {string[]}
 */
function buildProfileUrlVariants(normalized) {
  const base = normalized.replace(/\/+$/, "");
  return [
    base,
    base + "/",
    "https://" + base,
    "https://" + base + "/",
    "https://www." + base,
    "https://www." + base + "/",
  ];
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
  return (
    currentHour >= policy.activeWindow.startHour &&
    currentHour < policy.activeWindow.endHour
  );
}

/**
 * Helper delay function.
 *
 * @param {number} ms - Milliseconds to sleep
 */
/**
 * Interruptible sleep. Resolves early if the global DM_QUEUE_STOPPED flag is
 * set, so the stop button on the automation page can halt the cron-triggered
 * queue without waiting for the full cooldown to elapse.
 *
 * @param {number} ms - Milliseconds to sleep
 */
async function sleep(ms) {
  const stepMs = 500;
  let elapsed = 0;
  while (elapsed < ms) {
    if (DM_QUEUE_STOPPED) return;
    const waitMs = Math.min(stepMs, ms - elapsed);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    elapsed += waitMs;
  }
}

/**
 * Main DM queue processing loop context.
 *
 * @param {object} page - Playwright page context
 * @param {object} [options={}] - Optional processing overrides (e.g. custom delays for testing)
 * @returns {Promise<object>} Analytical report of processed batch items
 */
async function processDmQueue(page, options = {}) {
  // Reset the stop flag at the START of each run so a previous stop doesn't
  // permanently disable future cron runs. If the user clicks stop during
  // this run, the loop checks DM_QUEUE_STOPPED between profiles and aborts.
  resetDmQueueStopFlag();

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
  const maxDmsPerRun = options.maxDmsPerRun;
  let dmsSentThisRun = 0;

  queueLog(
    "info",
    "dm_queue",
    "SYSTEM",
    "Executing DM messaging queue processing loop...",
  );

  let eligibleJobs = [];
  try {
    eligibleJobs = db
      .prepare(
        `
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
    `,
      )
      .all(maxRetries);
  } catch (err) {
    queueLog(
      "error",
      "dm_queue",
      "SYSTEM",
      `Failed to query eligible DM jobs: ${err.message}`,
    );
    return report;
  }

  if (eligibleJobs.length === 0) {
    queueLog("info", "dm_queue", "SYSTEM", "No eligible DM jobs found.");
    return report;
  }

  queueLog(
    "info",
    "dm_queue",
    "SYSTEM",
    `Found ${eligibleJobs.length} eligible DM jobs for active campaigns.`,
  );

  for (const job of eligibleJobs) {
    if (DM_QUEUE_STOPPED) {
      queueLog(
        "info",
        "dm_queue",
        "SYSTEM",
        "DM queue stopped by user (stop button on automation page).",
      );
      break;
    }
    if (typeof maxDmsPerRun === "number" && dmsSentThisRun >= maxDmsPerRun) {
      queueLog(
        "info",
        "dm_queue",
        "SYSTEM",
        `Stopping DM processing: hit max_dms_per_run cap of ${maxDmsPerRun}.`,
      );
      break;
    }
    // Isolated nested exception handling to guarantee queue survival
    try {
      const normPlatform = String(job.platform).toLowerCase().trim();
      const policy = platformPolicies[normPlatform];
      const platformLimits = limits[normPlatform];

      if (!policy || !platformLimits) {
        queueLog(
          "warn",
          "dm_queue",
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
            UPDATE dm_jobs 
            SET status = 'pending', next_retry_at = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
          `,
          ).run(getNextDayBusinessHourWindow(normPlatform), job.id);
        } catch (err) {
          queueLog(
            "error",
            "dm_queue",
            job.id,
            `Failed to postpone job after session expiration skip: ${err.message}`,
          );
        }
        queueLog(
          "info",
          "dm_queue",
          job.id,
          `Postponed job: Platform '${normPlatform}' session is already known to be expired in this batch.`,
        );
        report.sessionExpired++;
        continue;
      }

      // ── 1. RUNTIME CAMPAIGN STATUS RE-VALIDATION ───────────────────────────
      let campaignRow;
      try {
        campaignRow = db
          .prepare("SELECT status FROM campaigns WHERE id = ?")
          .get(job.campaign_id);
      } catch (err) {
        queueLog(
          "error",
          "dm_queue",
          job.id,
          `Failed to query campaign status: ${err.message}`,
        );
        continue;
      }

      if (!campaignRow || campaignRow.status !== "active") {
        queueLog(
          "info",
          "dm_queue",
          job.id,
          `Skipping job since campaign is no longer active.`,
        );
        continue;
      }

      // ── 2. ACTIVE WINDOW HOUR COMPLIANCE ──────────────────────────────────
      if (!isWithinActiveWindow(policy)) {
        const nextWindow = getNextDayBusinessHourWindow(normPlatform);
        try {
          db.prepare(
            `
            UPDATE dm_jobs 
            SET next_retry_at = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
          `,
          ).run(nextWindow, job.id);
          queueLog(
            "info",
            "dm_queue",
            job.id,
            `Postponed DM job to next business hour window (Snoozed until: ${nextWindow}).`,
          );
        } catch (err) {
          queueLog(
            "error",
            "dm_queue",
            job.id,
            `DB update failed during active window snooze: ${err.message}`,
          );
        }
        continue;
      }

      // ── 3. LINKEDIN CONNECTION GATING (WAITING BEHAVIOR) ────────────────────
      if (normPlatform === "linkedin") {
        const isAccepted =
          job.connection_job_status === "accepted" ||
          job.lead_status === "replied" ||
          job.lead_status === "messaged";
        if (!isAccepted) {
          // Snooze/postpone by standard check interval (e.g. 6 hours)
          const snoozeIntervalHours = options.snoozeIntervalHours || 6;
          const snoozeUntil = new Date(
            Date.now() + snoozeIntervalHours * 60 * 60 * 1000,
          ).toISOString();
          try {
            db.prepare(
              `
              UPDATE dm_jobs
              SET scheduled_at = ?, updated_at = CURRENT_TIMESTAMP, status = 'scheduled'
              WHERE id = ?
            `,
            ).run(snoozeUntil, job.id);
            queueLog(
              "info",
              "dm_queue",
              job.id,
              `LinkedIn connection invite not accepted yet. Snoozing DM check for ${snoozeIntervalHours} hours.`,
            );
          } catch (err) {
            queueLog(
              "error",
              "dm_queue",
              job.id,
              `Failed to update LinkedIn DM snooze: ${err.message}`,
            );
          }
          continue;
        }
      }

      // ── 4. ANTI-DUPLICATION SPAM PROTECTION ───────────────────────────────
      let isDuplicate = false;
      try {
        // Query touchpoints history for messages sent to this lead (by lead_id)
        const existingTouchpoint = db
          .prepare(
            `
          SELECT id FROM touchpoints 
          WHERE lead_id = ? 
            AND platform = ? 
            AND type = 'dm' 
            AND outcome = 'sent'
        `,
          )
          .get(job.lead_id, normPlatform);

        // Check if there is already a successfully completed dm_job for this lead
        const existingSuccessfulJob = db
          .prepare(
            `
          SELECT id FROM dm_jobs
          WHERE campaign_id = ? AND lead_id = ? AND status = 'sent' AND id != ?
        `,
          )
          .get(job.campaign_id, job.lead_id, job.id);

        if (existingTouchpoint || existingSuccessfulJob) {
          isDuplicate = true;
        }

        // ── URL-BASED CROSS-LEAD DEDUPLICATION ──────────────────────────
        // The lead_id checks above can miss cases where the SAME LinkedIn
        // person exists under multiple lead records with slightly different
        // profile_url formatting (trailing slash, query params, www prefix,
        // etc.).  We normalise the URL and scan across ALL leads so we never
        // message the same physical person twice, even if they somehow appear
        // in the database under more than one lead_id.
        if (!isDuplicate && job.profile_url) {
          const normalizedUrl = normalizeProfileUrl(job.profile_url);
          if (normalizedUrl) {
            const urlVariants = buildProfileUrlVariants(normalizedUrl);
            const variantPlaceholders = urlVariants.map(() => "?").join(",");

            // Find any OTHER lead records whose stored URL normalises to the
            // same person.  LOWER + TRIM(url, '/') in SQLite removes trailing
            // slashes and case differences; the IN clause covers protocol and
            // www variants.
            const duplicateLeads = db
              .prepare(
                `
                SELECT id FROM leads
                WHERE id != ?
                  AND LOWER(TRIM(profile_url, '/')) IN (${variantPlaceholders})
              `,
              )
              .all(job.lead_id, ...urlVariants);

            if (duplicateLeads.length > 0) {
              const dupIds = duplicateLeads.map((l) => l.id);
              const idPlaceholders = dupIds.map(() => "?").join(",");

              // Were any of those duplicate-person lead records already DM'd?
              const alreadyMessaged = db
                .prepare(
                  `
                  SELECT id FROM touchpoints
                  WHERE lead_id IN (${idPlaceholders})
                    AND platform = ?
                    AND type = 'dm'
                    AND outcome = 'sent'
                `,
                )
                .get(...dupIds, normPlatform);

              if (alreadyMessaged) {
                isDuplicate = true;
                queueLog(
                  "warn",
                  "dm_queue",
                  job.id,
                  `Cross-lead duplicate blocked: profile URL "${job.profile_url}" ` +
                    `was already messaged under a different lead record. ` +
                    `Duplicate lead IDs found: [${dupIds.join(", ")}].`,
                );
              }
            }
          }
        }
      } catch (err) {
        queueLog(
          "error",
          "dm_queue",
          job.id,
          `Failed to check anti-duplication records: ${err.message}`,
        );
      }

      if (isDuplicate) {
        try {
          db.prepare(
            `
            UPDATE dm_jobs 
            SET status = 'sent', error_message = 'Duplicate message blocked', updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
          `,
          ).run(job.id);

          recordCampaignEvent(db, job.campaign_id, job.lead_id, "dm_skipped", {
            reason:
              "Anti-duplication check blocked repeated outreach to prevent account spam",
          });

          queueLog(
            "warn",
            "dm_queue",
            job.id,
            `Prevented duplicate DM send to lead ${job.lead_id}. Skipping.`,
          );
          report.skipped++;
        } catch (err) {
          queueLog(
            "error",
            "dm_queue",
            job.id,
            `Failed to register skipped duplicate job: ${err.message}`,
          );
        }
        continue;
      }

      // ── 5. DAILY LIMIT & WARMUP CALCULATOR ─────────────────────────────────
      let limitToday = platformLimits.dms || platformLimits.messages || 20;
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

      // Query daily messaging actions count performed today
      let todayActionsCount = 0;
      try {
        const countRow = db
          .prepare(
            `
          SELECT COUNT(*) as count 
          FROM daily_actions 
          WHERE platform = ? 
            AND action_type = 'dm' 
            AND outcome = 'sent'
            AND date(performed_at) = date('now')
        `,
          )
          .get(normPlatform);
        todayActionsCount = countRow ? countRow.count : 0;
      } catch (err) {
        queueLog(
          "error",
          "dm_queue",
          job.id,
          `Failed to query daily_actions count: ${err.message}`,
        );
      }

      if (todayActionsCount >= limitToday) {
        const nextWindow = getNextDayBusinessHourWindow(normPlatform);
        try {
          db.prepare(
            `
            UPDATE dm_jobs 
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
            "dm_queue",
            job.id,
            `Daily outreach rate limit met for campaign (${todayActionsCount}/${limitToday}). Snoozed.`,
          );
        } catch (err) {
          queueLog(
            "error",
            "dm_queue",
            job.id,
            `Failed to record limit_reached event: ${err.message}`,
          );
        }
        continue;
      }

      // ── 6. CONCURRENCY JOB LOCKING (RUNNING STATE) ─────────────────────────
      try {
        db.prepare(
          "UPDATE dm_jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        ).run(job.id);
      } catch (err) {
        queueLog(
          "error",
          "dm_queue",
          job.id,
          `Database lock write failed, skipping item to prevent concurrent clashes: ${err.message}`,
        );
        continue;
      }

      // ── 7. TEXT Outreach / MESSAGE BODY GENERATOR ───────────────────────────
      let messageBody = null;
      let messageId = job.message_id;
      let skipJob = false;

      try {
        const firstName =
          String(job.lead_name || "there")
            .trim()
            .split(/\s+/)[0] || "there";

        // ── FIX A: Honour the pinned message_id ──────────────────────────
        // When a dm_job already has a message_id, use THAT specific message.
        // The old code always re-queried for the "latest approved" message,
        // which caused message drift: if lead B's message was approved after
        // lead A's job was queued, lead A's job would silently pick up lead
        // B's message and send it.  Pinning prevents this entirely.
        if (job.message_id) {
          const pinnedMessage = db
            .prepare("SELECT id, body, lead_id FROM messages WHERE id = ?")
            .get(job.message_id);

          if (pinnedMessage) {
            // ── FIX B: Cross-lead ownership validation ─────────────────
            // A pinned message must belong to the SAME lead as the job.
            // If it doesn't, the message was mis-assigned and sending it
            // would deliver content written for a completely different person.
            if (pinnedMessage.lead_id !== job.lead_id) {
              queueLog(
                "error",
                "dm_queue",
                job.id,
                `SAFETY BLOCK: Pinned message #${job.message_id} belongs to lead ` +
                  `#${pinnedMessage.lead_id}, not the current lead #${job.lead_id} ` +
                  `("${job.lead_name}"). Job failed to prevent a wrong-person send.`,
              );
              db.prepare(
                `UPDATE dm_jobs
                 SET status = 'failed',
                     error_message = ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
              ).run(
                `Safety: message #${job.message_id} is owned by lead #${pinnedMessage.lead_id}, not lead #${job.lead_id}`,
                job.id,
              );
              report.failed++;
              skipJob = true;
            } else {
              // Ownership confirmed — use this exact message body
              messageBody = pinnedMessage.body;
              messageId = pinnedMessage.id;
            }
          }
        }

        // Only search for an approved message if nothing is pinned yet
        if (!skipJob && !messageBody) {
          const approvedMessage = db
            .prepare(
              `
            SELECT id, body FROM messages 
            WHERE lead_id = ? AND platform = ? AND status = 'approved' 
            ORDER BY approved_at DESC LIMIT 1
          `,
            )
            .get(job.lead_id, normPlatform);

          if (approvedMessage) {
            messageBody = approvedMessage.body;
            messageId = approvedMessage.id;
            // Pin this message to the job so retries never drift to a
            // different approved message that appears later.
            db.prepare("UPDATE dm_jobs SET message_id = ? WHERE id = ?").run(
              messageId,
              job.id,
            );
          } else {
            // Last-resort generic fallback — always uses THIS lead's name,
            // never a name from another lead's message body.
            messageBody = `Hi ${firstName}, I wanted to reach out and say hi! Hope you are doing great.`;
          }
        }

        // ── FIX C: Greeting-name mismatch guard ──────────────────────────
        // This catches the "Hi Lilian → Brian" bug at the last possible
        // moment before the browser send: if the message body's opening
        // greeting names someone other than this job's lead, we abort
        // rather than humiliate the user with a misaddressed DM.
        //
        // Pattern covers: "Hi Brian," / "Hi Brian!" / "Hi Brian\n" / "Hi Brian "
        // It intentionally skips "Hi there" (generic fallback) to avoid
        // false-positives on template messages without a personalised name.
        if (!skipJob && messageBody) {
          const greetingMatch = messageBody.match(
            /^Hi\s+([A-Za-zÀ-ÖØ-öø-ÿ''-]+)/i,
          );
          if (greetingMatch) {
            const messageFirstName = greetingMatch[1].toLowerCase();
            const leadFirstName = firstName.toLowerCase();

            if (
              messageFirstName !== leadFirstName &&
              messageFirstName !== "there"
            ) {
              queueLog(
                "error",
                "dm_queue",
                job.id,
                `SAFETY BLOCK: Message opens with "Hi ${greetingMatch[1]}" ` +
                  `but the lead is "${job.lead_name}" (lead #${job.lead_id}). ` +
                  `This is a wrong-person message. Job failed to prevent sending.`,
              );
              db.prepare(
                `UPDATE dm_jobs
                 SET status = 'failed',
                     error_message = ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
              ).run(
                `Safety: name mismatch — message says "Hi ${greetingMatch[1]}" but lead is "${firstName}"`,
                job.id,
              );
              report.failed++;
              skipJob = true;
            }
          }
        }
      } catch (err) {
        queueLog(
          "error",
          "dm_queue",
          job.id,
          `Failed to check approved templates: ${err.message}`,
        );
        const firstName =
          String(job.lead_name || "there")
            .trim()
            .split(/\s+/)[0] || "there";
        messageBody = `Hi ${firstName}, I wanted to reach out and say hi! Hope you are doing great.`;
      }

      // Skip this job if any safety guard triggered above
      if (skipJob) continue;

      report.processed++;
      queueLog(
        "info",
        "dm_queue",
        job.id,
        `Processing DM job for lead ${job.lead_id} (${job.profile_url}).`,
      );

      // ── 8. BROWSER OUTREACH EXECUTION via platformAdapter ───────────────────
      //
      // In-loop retry: previously a single failure would immediately mark the
      // job as failed and snooze it for 30+ minutes. Now we retry the action
      // up to MAX_INLOOP_RETRIES times with a short interruptible delay
      // between attempts. Only retryable outcomes are retried — sent,
      // premium_required, not_connected, already_connected, session_required,
      // no_posts, and skipped are NOT retried.
      const MAX_INLOOP_RETRIES = 2; // 1 initial + 2 retries = 3 attempts max
      const NON_RETRYABLE_OUTCOMES = new Set([
        "sent",
        "premium_required",
        "not_connected",
        "already_connected",
        "session_required",
        "no_posts",
        "skipped",
        "blocked",
      ]);
      let res;
      for (let attempt = 1; attempt <= MAX_INLOOP_RETRIES + 1; attempt++) {
        if (DM_QUEUE_STOPPED) {
          res = { outcome: "skipped", error: "Stopped by user", metadata: {}, retryable: false };
          break;
        }
        try {
          res = await platformAdapter.runDmAction(
            job.platform,
            page,
            job,
            messageBody,
            (type, msg) => {
              queueLog(type, "dm_queue", job.id, `[ADAPTER LOG] ${msg}`);
            },
          );
        } catch (err) {
          res = {
            outcome: "failed",
            error: `Uncaught DM adapter crash: ${err.message}`,
            metadata: {},
            retryable: true,
          };
        }
        // Success or non-retryable → done.
        if (
          !res ||
          res.outcome === "sent" ||
          NON_RETRYABLE_OUTCOMES.has(res.outcome)
        ) {
          break;
        }
        // Retryable failure — try again if we have attempts left.
        if (attempt <= MAX_INLOOP_RETRIES) {
          queueLog(
            "warn",
            "dm_queue",
            job.id,
            `Attempt ${attempt} failed (${res.outcome}: ${res.error || ""}). Retrying (${attempt}/${MAX_INLOOP_RETRIES})...`,
          );
          await sleep(2000 + Math.floor(Math.random() * 1500));
          if (DM_QUEUE_STOPPED) break;
        }
      }

      // ── 9. ATOMIC MULTI-TABLE TRANSACTION STATE UPDATE ──────────────────────
      try {
        if (res.outcome === "sent") {
          db.transaction(() => {
            // Update DM Job Status
            db.prepare(
              `
              UPDATE dm_jobs 
              SET status = 'sent', sent_at = CURRENT_TIMESTAMP, error_message = NULL, updated_at = CURRENT_TIMESTAMP 
              WHERE id = ?
            `,
            ).run(job.id);

            // Update Lead Outreach Stage Status
            db.prepare(
              `
              UPDATE leads 
              SET status = 'messaged', updated_at = CURRENT_TIMESTAMP 
              WHERE id = ?
            `,
            ).run(job.lead_id);

            // Register Touchpoints Action Tracking
            db.prepare(
              `
              INSERT INTO touchpoints (lead_id, type, platform, message_id, outcome, sent_at, notes)
              VALUES (?, 'dm', ?, ?, 'sent', CURRENT_TIMESTAMP, ?)
            `,
            ).run(job.lead_id, normPlatform, messageId, messageBody);

            // Record inside daily_actions
            db.prepare(
              `
              INSERT INTO daily_actions (platform, action_type, lead_id, outcome, campaign_id)
              VALUES (?, 'dm', ?, 'sent', ?)
            `,
            ).run(normPlatform, job.lead_id, job.campaign_id);

            // Update original approved message status to 'sent'
            if (messageId) {
              db.prepare(
                `
                UPDATE messages 
                SET status = 'sent', sent_at = CURRENT_TIMESTAMP 
                WHERE id = ?
              `,
              ).run(messageId);
            }

            // Record Campaign Event
            recordCampaignEvent(db, job.campaign_id, job.lead_id, "dm_sent", {
              platform: job.platform,
              message_id: messageId,
              metadata: res.metadata,
            });
          })();

          queueLog("info", "dm_queue", job.id, "Successfully sent DM to lead.");
          report.success++;
          dmsSentThisRun++;
        } else if (res.outcome === "skipped") {
          db.transaction(() => {
            db.prepare(
              `
              UPDATE dm_jobs 
              SET status = 'sent', error_message = ?, updated_at = CURRENT_TIMESTAMP 
              WHERE id = ?
            `,
            ).run(res.error || "Bypassed / Already messaged", job.id);

            db.prepare(
              `
              INSERT INTO touchpoints (lead_id, type, platform, message_id, outcome, sent_at, notes)
              VALUES (?, 'dm', ?, ?, 'skipped', CURRENT_TIMESTAMP, ?)
            `,
            ).run(
              job.lead_id,
              normPlatform,
              messageId,
              res.error || "Already messaged",
            );

            recordCampaignEvent(
              db,
              job.campaign_id,
              job.lead_id,
              "dm_skipped",
              {
                reason: res.error || "Already messaged",
                metadata: res.metadata,
              },
            );
          })();

          queueLog(
            "info",
            "dm_queue",
            job.id,
            `DM skipped (Reason: ${res.error || "Already messaged"}).`,
          );
          report.skipped++;
        } else if (res.outcome === "session_required") {
          expiredPlatforms.add(normPlatform);
          db.prepare(
            `
            UPDATE dm_jobs 
            SET status = 'pending', next_retry_at = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
          `,
          ).run(getNextDayBusinessHourWindow(normPlatform), job.id);

          recordCampaignEvent(
            db,
            job.campaign_id,
            job.lead_id,
            "session_expired",
            {
              error: res.error,
            },
          );

          // Async session expiry email notification (Gracefully isolated)
          const ctx = getContext();
          sendNotification(
            `${ctx.ctx_biz_name} Session Expired - ${normPlatform}`,
            `The DM queue worker detected that the session for platform '${normPlatform}' has expired or is invalid.\n\nError: ${res.error || "No error details available."}\n\nPlease check the automation settings dashboard to re-authenticate.`,
          ).catch((err) => {
            console.error(
              "[CAMPAIGN-OBSERVABILITY] Failed to send session expiry notification: ",
              err.message,
            );
          });

          queueLog(
            "warn",
            "dm_queue",
            job.id,
            "Platform session validation expired. Postponing job.",
          );
          report.sessionExpired++;
        } else if (res.outcome === "blocked") {
          const nextWindow = getNextDayBusinessHourWindow(normPlatform);
          db.prepare(
            `
            UPDATE dm_jobs 
            SET status = 'failed', next_retry_at = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
          `,
          ).run(nextWindow, job.id);

          recordCampaignEvent(
            db,
            job.campaign_id,
            job.lead_id,
            "captcha_detected",
            {
              error: res.error,
            },
          );

          queueLog(
            "error",
            "dm_queue",
            job.id,
            `Automation limit or captcha active (Error: ${res.error}). Snoozed.`,
          );
          report.blocked++;
        } else if (res.outcome === "premium_required") {
          // This lead requires LinkedIn Premium to message — skip permanently.
          // Previously this fell through to the generic retry handler, causing
          // up to 5 wasteful re-visits (each ~5 s) before hitting maxRetries.
          db.transaction(() => {
            db.prepare(
              `
              UPDATE dm_jobs
              SET status = 'skipped', error_message = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `,
            ).run(
              res.error || "LinkedIn Premium required to message this profile",
              job.id,
            );

            db.prepare(
              `
              INSERT INTO touchpoints (lead_id, type, platform, message_id, outcome, sent_at, notes)
              VALUES (?, 'dm', ?, ?, 'skipped', CURRENT_TIMESTAMP, ?)
            `,
            ).run(
              job.lead_id,
              normPlatform,
              messageId,
              res.error || "LinkedIn Premium required",
            );

            recordCampaignEvent(
              db,
              job.campaign_id,
              job.lead_id,
              "dm_skipped",
              {
                reason: "premium_required",
                error: res.error,
              },
            );
          })();

          queueLog(
            "warn",
            "dm_queue",
            job.id,
            `Lead ${job.lead_id} requires LinkedIn Premium — skipping permanently.`,
          );
          report.skipped++;
        } else {
          // General interaction failures - handled independently from connection queue
          const newRetryCount = (job.retry_count || 0) + 1;
          if (newRetryCount >= maxRetries) {
            // Terminal failure
            db.transaction(() => {
              db.prepare(
                `
                UPDATE dm_jobs 
                SET status = 'failed', retry_count = ?, error_message = ?, next_retry_at = NULL, updated_at = CURRENT_TIMESTAMP 
                WHERE id = ?
              `,
              ).run(
                newRetryCount,
                res.error || "Interaction failure cap reached",
                job.id,
              );

              db.prepare(
                `
                INSERT INTO touchpoints (lead_id, type, platform, message_id, outcome, sent_at, notes)
                VALUES (?, 'dm', ?, ?, 'failed', CURRENT_TIMESTAMP, ?)
              `,
              ).run(
                job.lead_id,
                normPlatform,
                messageId,
                res.error || "Terminal interactions crash",
              );

              recordCampaignEvent(
                db,
                job.campaign_id,
                job.lead_id,
                "dm_failed_terminal",
                {
                  error: res.error || "Max retries hit",
                },
              );
            })();

            queueLog(
              "error",
              "dm_queue",
              job.id,
              `Terminal DM failure: ${res.error || "Max retries hit"}`,
            );
            report.failed++;
          } else {
            // Retryable failure - apply progressive backoff
            const backoffTime = calculateBackoffDelay(newRetryCount);
            db.prepare(
              `
              UPDATE dm_jobs 
              SET status = 'failed', retry_count = ?, error_message = ?, next_retry_at = ?, updated_at = CURRENT_TIMESTAMP 
              WHERE id = ?
            `,
            ).run(
              newRetryCount,
              res.error || "Interaction timeout",
              backoffTime,
              job.id,
            );

            recordCampaignEvent(
              db,
              job.campaign_id,
              job.lead_id,
              "dm_failed_retryable",
              {
                error: res.error || "Temporary timeout",
                next_attempt: backoffTime,
              },
            );

            queueLog(
              "warn",
              "dm_queue",
              job.id,
              `Retryable DM failure: ${res.error}. Scheduled retry at: ${backoffTime}`,
            );
            report.failed++;

            // CRITICAL: Force execution tab state disposal so following leads do not
            // inherit a corrupt DOM view (e.g. a half-open DM overlay from this failed run).
            if (page && typeof page.reload === "function") {
              queueLog(
                "info",
                "dm_queue",
                job.id,
                "Reloading page to purge stale overlay state after failed DM.",
              );
              await page
                .reload({ waitUntil: "domcontentloaded" })
                .catch(() => {});
            }
          }
        }
      } catch (err) {
        queueLog(
          "error",
          "dm_queue",
          job.id,
          `Failed to persist transaction outcomes in database: ${err.message}`,
        );
      }

      // ── 10. HUMAN-LIKE INTER-ACTION DELAY ─────────────────────────────────
      //
      // SKIP the cooldown entirely for outcomes where no DM was actually sent
      // — premium_required, not_connected, already_connected, no_posts,
      // skipped, session_required. The user explicitly asked for this so the
      // queue doesn't waste 30-45 seconds on every premium-required profile.
      const SKIP_COOLDOWN_OUTCOMES = new Set([
        "premium_required",
        "not_connected",
        "already_connected",
        "no_posts",
        "skipped",
        "session_required",
      ]);
      const lastOutcome = res?.outcome;
      const shouldSkipCooldown =
        lastOutcome && SKIP_COOLDOWN_OUTCOMES.has(lastOutcome);

      if (options.skipDelays) {
        continue;
      }
      if (shouldSkipCooldown) {
        // Brief pause only — enough for the browser to settle, not enough to
        // waste time. Lets us move to the next profile almost immediately.
        queueLog(
          "info",
          "dm_queue",
          job.id,
          `Skipping cooldown for outcome=${lastOutcome} — moving to next lead.`,
        );
        await sleep(800 + Math.floor(Math.random() * 700));
        continue;
      }
      const minSec = policy.delays?.actionMinSeconds || 20;
      const maxSec = policy.delays?.actionMaxSeconds || 60;
      const randomDelay =
        Math.floor(Math.random() * (maxSec - minSec + 1) + minSec) * 1000;

      queueLog(
        "info",
        "dm_queue",
        job.id,
        `Simulating human browser delay: sleeping for ${(randomDelay / 1000).toFixed(1)} seconds.`,
      );
      await sleep(randomDelay);

      // ── 11. STRAY-TAB CLEANUP ─────────────────────────────────────────────
      // LinkedIn may have spawned a /job-posting tab during this action (e.g.
      // by auto-redirecting after a premium dialog). Close any stray tabs
      // before moving to the next lead so they don't accumulate.
      try {
        const { closeStrayTabs } = require("../automation/browserBase");
        if (page && page.context && typeof page.context === "function") {
          await closeStrayTabs(page.context(), job.platform);
        } else if (page && page._context) {
          await closeStrayTabs(page._context, job.platform);
        }
      } catch (_) {}
    } catch (err) {
      queueLog(
        "error",
        "dm_queue",
        job.id,
        `Uncaught isolated item execution exception: ${err.message}`,
      );
    }
  }

  queueLog(
    "info",
    "dm_queue",
    "SYSTEM",
    `DM messaging queue batch finished: ${JSON.stringify(report)}`,
  );
  return report;
}

module.exports = {
  processDmQueue,
  stopDmQueue,
  resetDmQueueStopFlag,
  isDmQueueStopped,
};
