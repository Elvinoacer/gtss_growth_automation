const path = require("path");
const fs = require("fs");
const { getDb, increment_action_count } = require("../db/database");
const { followAccount, viewStory, likeRecentPost } = require("./instagram");
const { humanDelay } = require("./browserBase");

/**
 * Emit an orchestration event to the active emitter or fall back to native logger.
 */
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
 * Get a random interval in hours.
 */
function getRandomIntervalHours(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Format a Javascript Date object to SQLite's YYYY-MM-DD HH:MM:SS format in UTC.
 */
function formatSqliteDate(date) {
  return date.toISOString().replace("T", " ").substring(0, 19);
}

// ── TEMPLATES & PERSONALIZATION HELPERS ─────────────────────────────────────

function loadTemplates() {
  try {
    const filePath = path.join(__dirname, "..", "config", "templates.json");
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return {};
  }
}

function getTemplate(platform, type) {
  const db = getDb();
  const settingKey = `template_${platform}_${type || "dm"}`;
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(settingKey);
  if (row && row.value) return row.value;

  const templates = loadTemplates();
  const fileKey = type ? `${platform}_${type}` : `${platform}_dm`;
  return templates[fileKey] || "";
}

function fillTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value || "");
  }
  return result;
}

function getFirstName(name) {
  const cleaned = String(name || "").trim();
  if (!cleaned) return "there";
  return cleaned.split(/\s+/)[0];
}

function extractPainPoint(scoreReason) {
  if (!scoreReason) return "managing restaurant operations more efficiently";
  const lower = scoreReason.toLowerCase();
  if (lower.includes("restaurant") || lower.includes("food")) return "streamlining restaurant operations and orders";
  if (lower.includes("hotel")) return "optimising hotel staff scheduling and guest management";
  if (lower.includes("cafe") || lower.includes("coffee")) return "managing café orders and inventory efficiently";
  if (lower.includes("sme") || lower.includes("enterprise"))
    return "simplifying business operations with smart software";
  return "managing business operations more efficiently";
}

// ── CORE STATE MACHINE METHODS ──────────────────────────────────────────────

/**
 * Checks if a sequence already exists. If not, creates one with status 'pending'
 * and next_step 'follow' scheduled for immediate execution.
 *
 * @param {number} leadId - The lead identifier.
 * @returns {Object} { success: boolean, sequenceId?: number, error?: string }
 */
function startWarmupSequence(leadId) {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM ig_warmup_sequences WHERE lead_id = ?").get(leadId);
  if (existing) {
    return { success: false, error: "already_started" };
  }

  const now = new Date();
  const nextStepAfterStr = formatSqliteDate(now);

  const result = db
    .prepare(
      `
      INSERT INTO ig_warmup_sequences (
        lead_id, status, next_step, next_step_after, current_step,
        story_views_count, post_likes_count, comments_count, attempt_count,
        created_at, updated_at
      ) VALUES (?, 'pending', 'follow', ?, 0, 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `,
    )
    .run(leadId, nextStepAfterStr);

  // Set lead ig_warmup_status to 'pending'
  db.prepare(
    `
    UPDATE leads
    SET ig_warmup_status = 'pending'
    WHERE id = ?
  `,
  ).run(leadId);

  return { success: true, sequenceId: result.lastInsertRowid };
}

/**
 * Retrieves leads whose next_step_after is due (i.e. <= now),
 * ignoring completed, failed, or skipped states.
 *
 * @returns {Array<Object>} List of due leads.
 */
function getLeadsDueForStep() {
  const db = getDb();
  const rows = db
    .prepare(
      `
      SELECT s.id AS sequenceId, s.lead_id AS leadId, l.ig_username AS username,
             s.status AS currentStatus, s.next_step AS nextStep, s.attempt_count AS attemptCount
      FROM ig_warmup_sequences s
      JOIN leads l ON s.lead_id = l.id
      WHERE s.next_step_after <= datetime('now')
        AND s.status NOT IN ('warmup_complete', 'failed', 'skipped')
    `,
    )
    .all();
  return rows;
}

/**
 * Transitions the lead through the sequence:
 * Executes the correct Playwright action, updates state, and logs progress.
 *
 * @param {Object} page - Playwright page context.
 * @param {Object} params - { leadId }.
 * @param {Function} emitter - Orchestration event logger.
 */
async function advanceWarmupStep(page, { leadId }, emitter) {
  const db = getDb();
  const sequence = db.prepare("SELECT * FROM ig_warmup_sequences WHERE lead_id = ?").get(leadId);
  if (!sequence) {
    return { success: false, error: "sequence_not_found" };
  }

  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  if (!lead) {
    return { success: false, error: "lead_not_found" };
  }
  const username = lead.ig_username;
  if (!username) {
    return { success: false, error: "ig_username_missing" };
  }

  const status = sequence.status;
  let success = false;
  let stepExecuted = "";
  let nextStep = "";
  let nextStatus = "";
  let delayHours = 0;
  let actionResult = null;

  const now = new Date();

  if (status === "pending") {
    stepExecuted = "follow";
    safeEmit(emitter, "info", `[WARMUP] Starting follow step for @${username}`);
    actionResult = await followAccount(page, { username }, emitter);
    if (actionResult && actionResult.success) {
      success = true;
      nextStatus = "following";
      nextStep = "view_story";
      delayHours = getRandomIntervalHours(24, 48);
    }
  } else if (status === "following") {
    stepExecuted = "view_story";
    safeEmit(emitter, "info", `[WARMUP] Starting story view step for @${username}`);
    actionResult = await viewStory(page, { username }, emitter);
    if (actionResult && actionResult.success) {
      success = true;
      nextStatus = "story_viewed";
      nextStep = "like";
      delayHours = getRandomIntervalHours(12, 24);
    }
  } else if (status === "story_viewed") {
    stepExecuted = "like";
    safeEmit(emitter, "info", `[WARMUP] Starting post like step for @${username}`);
    actionResult = await likeRecentPost(page, { username }, emitter);
    if (actionResult && actionResult.success) {
      success = true;
      nextStatus = "liked";
      nextStep = "done";
      delayHours = getRandomIntervalHours(24, 48);
    }
  } else if (status === "liked") {
    stepExecuted = "complete";
    safeEmit(emitter, "info", `[WARMUP] Completing sequence for @${username}`);
    const res = completeWarmup(leadId, emitter);
    if (res.success) {
      return { success: true, stepExecuted: "complete", nextStep: "done" };
    } else {
      return { success: false, error: res.error };
    }
  } else {
    return {
      success: true,
      stepExecuted: "none",
      nextStep: sequence.next_step,
    };
  }

  if (success) {
    const nextDate = new Date(Date.now() + delayHours * 60 * 60 * 1000);
    const nextStepAfterStr = formatSqliteDate(nextDate);
    const lastActionAtStr = formatSqliteDate(now);

    db.prepare(
      `
      UPDATE ig_warmup_sequences
      SET status = ?,
          next_step = ?,
          next_step_after = ?,
          attempt_count = 0,
          current_step = current_step + 1,
          story_views_count = story_views_count + (CASE WHEN ? = 'view_story' THEN 1 ELSE 0 END),
          post_likes_count = post_likes_count + (CASE WHEN ? = 'like' THEN 1 ELSE 0 END),
          last_action_at = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE lead_id = ?
    `,
    ).run(nextStatus, nextStep, nextStepAfterStr, stepExecuted, stepExecuted, lastActionAtStr, leadId);

    // Record action in daily_actions for strict limit enforcement
    const dailyActionType = stepExecuted === "follow" ? "follows" : "likes";
    increment_action_count("instagram", dailyActionType, leadId, "sent");

    // Sync status to leads.ig_warmup_status
    db.prepare(
      `
      UPDATE leads
      SET ig_warmup_status = ?
      WHERE id = ?
    `,
    ).run(nextStatus, leadId);

    safeEmit(
      emitter,
      "done",
      `[WARMUP] Transitioned lead #${leadId} to status: ${nextStatus}. Next step: ${nextStep} scheduled for +${delayHours}h`,
    );

    return { success: true, stepExecuted, nextStep };
  } else {
    // Failure / Retry logic
    const attempt = sequence.attempt_count + 1;
    const isPermanentFailure = attempt >= 3;
    const nextDate = new Date(Date.now() + 2 * 60 * 60 * 1000); // retry in 2 hours
    const nextStepAfterStr = formatSqliteDate(nextDate);
    const lastActionAtStr = formatSqliteDate(now);

    const errorMsg = actionResult ? actionResult.error : "action_failed";

    if (isPermanentFailure) {
      db.prepare(
        `
        UPDATE ig_warmup_sequences
        SET status = 'skipped',
            next_step = 'none',
            next_step_after = NULL,
            attempt_count = ?,
            last_action_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE lead_id = ?
      `,
      ).run(attempt, lastActionAtStr, leadId);

      db.prepare(
        `
        UPDATE leads
        SET ig_warmup_status = 'skipped'
        WHERE id = ?
      `,
      ).run(leadId);

      safeEmit(
        emitter,
        "error",
        `[WARMUP] Step '${stepExecuted}' failed permanently after ${attempt} attempts: ${errorMsg}. Warmup status marked failed.`,
      );
    } else {
      db.prepare(
        `
        UPDATE ig_warmup_sequences
        SET attempt_count = ?,
            next_step_after = ?,
            last_action_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE lead_id = ?
      `,
      ).run(attempt, nextStepAfterStr, lastActionAtStr, leadId);

      safeEmit(
        emitter,
        "warn",
        `[WARMUP] Step '${stepExecuted}' failed (Attempt ${attempt}/3): ${errorMsg}. Retrying in 2 hours.`,
      );
    }

    return { success: false, stepExecuted, error: errorMsg };
  }
}

/**
 * Marks sequence as completed, creates a personalized draft DM,
 * and sets visibility tags based on whether they followed back.
 *
 * @param {number} leadId - The lead identifier.
 * @param {Function} emitter - Orchestration event logger.
 * @returns {Object} { success: boolean, error?: string }
 */
function completeWarmup(leadId, emitter) {
  const db = getDb();

  // Set sequence to warmup_complete
  db.prepare(
    `
    UPDATE ig_warmup_sequences
    SET status = 'warmup_complete',
        next_step = 'done',
        next_step_after = NULL,
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE lead_id = ?
  `,
  ).run(leadId);

  // Sync leads warmup status
  db.prepare(
    `
    UPDATE leads
    SET ig_warmup_status = 'warmup_complete'
    WHERE id = ?
  `,
  ).run(leadId);

  // Fetch the lead to check if they followed back
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  if (!lead) {
    return { success: false, error: "lead_not_found" };
  }

  // ig_is_message_request is 1 if follow_back_at is null, else 0
  const ig_is_message_request = lead.ig_follow_back_at === null || lead.ig_follow_back_at === undefined ? 1 : 0;

  // Generate personalized DM using template and details
  const template = getTemplate("instagram", "dm");
  const templateVars = {
    lead_name: getFirstName(lead.name),
    role: lead.role || "",
    company: lead.company || "your business",
    location: lead.location || "Kenya",
    product: "Restaurant Manager",
    pain_point: extractPainPoint(lead.score_reason),
  };
  let body = template
    ? fillTemplate(template, templateVars)
    : `Hi ${templateVars.lead_name},\n\nI'm reaching out because I know how much of a nightmare it is when a sudden ISP outage brings a busy dining room to a standstill. I develop localized management systems specifically designed to maintain 100% operational uptime during internet drops—meaning kitchen routing and mobile payments keep flowing no matter what.\n\nIs relying on a stable connection something that currently causes friction for your front-of-house team?\n\nWould love to connect!\n\nBest,\nElvin`;

  // Limit check (1000 characters for instagram_dm)
  if (body.length > 1000) {
    body = body.slice(0, 1000);
  }

  // Insert single draft message
  db.prepare(
    `
    INSERT INTO messages (
      lead_id, platform, status, variant, is_follow_up, body, action_type, ig_is_message_request, generated_at
    ) VALUES (?, 'instagram', 'draft', 'A', 0, ?, 'instagram_dm', ?, CURRENT_TIMESTAMP)
  `,
  ).run(leadId, body, ig_is_message_request);

  safeEmit(
    emitter,
    "info",
    `Warm-up complete for lead #${leadId} — DM draft created (Message Request: ${ig_is_message_request === 1 ? "Yes" : "No"})`,
  );

  return { success: true };
}

module.exports = {
  startWarmupSequence,
  getLeadsDueForStep,
  advanceWarmupStep,
  completeWarmup,
};
