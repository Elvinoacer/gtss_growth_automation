/**
 * Shared Campaign Utility Functions
 *
 * Implements high-integrity, reusable utility functions supporting both
 * connection and direct messaging queues in the social outreach campaigns.
 *
 * Designed with strict separation between pure calculations (deterministic)
 * and side-effecting helper functions (database writes and logging).
 */

const crypto = require("crypto");

// ── 1. RETRY / BACKOFF CALCULATION (PURE) ────────────────────────────────────
/**
 * Calculates next retry timestamp using progressive exponential backoff
 * with custom random jitter to avoid thundering herd requests.
 *
 * @param {number} retryCount - Current attempt index (0-indexed)
 * @param {number} [baseDelayMs=1800000] - Base retry delay (default: 30 minutes)
 * @param {number} [maxDelayMs=21600000] - Cap on delay (default: 6 hours)
 * @returns {string} ISO 8601 string of calculated snooze timestamp
 */
function calculateBackoffDelay(retryCount, baseDelayMs = 30 * 60 * 1000, maxDelayMs = 6 * 60 * 60 * 1000) {
  const exponent = Math.min(retryCount, 10); // Cap exponent to avoid overflow
  const rawDelay = baseDelayMs * Math.pow(2, exponent);
  
  // Apply a +/- 15% random jitter window to humanize request timing
  const jitterFactor = 0.85 + Math.random() * 0.3; 
  const jitteredDelay = Math.min(rawDelay * jitterFactor, maxDelayMs);
  
  return new Date(Date.now() + jitteredDelay).toISOString();
}

// In-memory registry of active Server-Sent Events (SSE) client response streams
const campaignSseStreams = {};

/**
 * Register a client's response stream for Server-Sent Events (SSE) campaign logs.
 * Cleans up listeners and removes connections upon socket close.
 *
 * @param {number|string} campaignId - Target campaign ID
 * @param {object} res - Express response object
 */
function registerCampaignStream(campaignId, res) {
  const idKey = String(campaignId);
  if (!campaignSseStreams[idKey]) {
    campaignSseStreams[idKey] = new Set();
  }
  campaignSseStreams[idKey].add(res);

  res.on("close", () => {
    const streams = campaignSseStreams[idKey];
    if (streams) {
      streams.delete(res);
      if (streams.size === 0) {
        delete campaignSseStreams[idKey];
      }
    }
  });
}

// ── 2. CAMPAIGN EVENT RECORDING (SIDE-EFFECTING) ─────────────────────────────
/**
 * Inserts a structured historical record inside the campaign_events table.
 *
 * @param {object} db - Active better-sqlite3 database context
 * @param {number} campaignId - Identifier of target campaign
 * @param {number|null} leadId - Lead context identifier
 * @param {string} eventType - Action occurrence code (e.g. 'dm_sent', 'connection_accepted')
 * @param {object} [details={}] - Optional metadata envelope
 */
function recordCampaignEvent(db, campaignId, leadId, eventType, details = {}) {
  if (!db) throw new Error("Database context is required to record campaign events.");
  if (!campaignId) throw new Error("Campaign ID is required to record campaign events.");
  if (!eventType) throw new Error("Event type is required to record campaign events.");

  const stmt = db.prepare(`
    INSERT INTO campaign_events (campaign_id, lead_id, event_type, details_json)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(campaignId, leadId || null, eventType, JSON.stringify(details));

  const eventPayload = {
    campaign_id: campaignId,
    lead_id: leadId || null,
    event_type: eventType,
    metadata: details,
    created_at: new Date().toISOString()
  };

  // 1. Real-time Socket.IO Broadcast (Gracefully isolated)
  try {
    const socketService = require("../../services/socketService");
    socketService.emitTo("campaigns", "campaign:event", eventPayload);
    socketService.emitTo(`campaigns:${campaignId}`, "event", eventPayload);
  } catch (err) {
    console.error("[CAMPAIGN-OBSERVABILITY] Failed Socket.IO broadcast: ", err.message);
  }

  // 2. Real-time SSE Broadcast (Gracefully isolated)
  try {
    const idKey = String(campaignId);
    const streams = campaignSseStreams[idKey];
    if (streams && streams.size > 0) {
      const sseMessage = `data: ${JSON.stringify(eventPayload)}\n\n`;
      for (const res of streams) {
        try {
          res.write(sseMessage);
        } catch (writeErr) {
          console.error("[CAMPAIGN-OBSERVABILITY] Failed to write to SSE client: ", writeErr.message);
        }
      }
    }
  } catch (err) {
    console.error("[CAMPAIGN-OBSERVABILITY] Failed SSE broadcast: ", err.message);
  }
}

// ── 3. JOB STATUS UPDATES (SIDE-EFFECTING) ───────────────────────────────────
/**
 * Transaction-safe update for a Connection Job row.
 *
 * @param {object} db - Database context
 * @param {number} jobId - Target connection job ID
 * @param {string} status - Target status state ('pending', 'sent', 'failed', 'accepted')
 * @param {string|null} [errorMessage=null] - Failure log description
 */
function updateConnectionJobStatus(db, jobId, status, errorMessage = null) {
  if (!db) throw new Error("Database context is required to update connection job status.");
  if (!jobId) throw new Error("Job ID is required to update connection job status.");

  const stmt = db.prepare(`
    UPDATE connection_jobs
    SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  stmt.run(status, errorMessage || null, jobId);
}

/**
 * Transaction-safe update for a DM Job row.
 *
 * @param {object} db - Database context
 * @param {number} jobId - Target DM job ID
 * @param {string} status - Target status state ('pending', 'scheduled', 'sent', 'failed')
 * @param {string|null} [errorMessage=null] - Failure log description
 * @param {string|null} [sentAt=null] - ISO timestamp when message successfully delivered
 */
function updateDmJobStatus(db, jobId, status, errorMessage = null, sentAt = null) {
  if (!db) throw new Error("Database context is required to update DM job status.");
  if (!jobId) throw new Error("Job ID is required to update DM job status.");

  const stmt = db.prepare(`
    UPDATE dm_jobs
    SET status = ?, error_message = ?, sent_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  stmt.run(status, errorMessage || null, sentAt || null, jobId);
}

// ── 4. LIMIT-REACHED HANDLING (SIDE-EFFECTING & DETERMINISTIC) ───────────────
/**
 * Computes a target execution timestamp set to the next business day's window
 * (specifically, 9:00 AM local time tomorrow) when daily outreach rate limits are met.
 *
 * @param {string} platform - Target platform label (e.g. 'linkedin')
 * @returns {string} ISO 8601 string of next morning's active window kickoff time
 */
function getNextDayBusinessHourWindow(platform) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0); // 9:00 AM Tomorrow morning
  return tomorrow.toISOString();
}

// ── 5. FINGERPRINT GENERATION (PURE) ─────────────────────────────────────────
/**
 * Pure cryptographic SHA-256 fingerprint generation ensuring idempotency constraints.
 *
 * @param {string} platform - Outreach platform label
 * @param {number} campaignId - Source campaign ID
 * @param {number} leadId - Target lead ID
 * @param {string} actionType - Connection/DM action classifier
 * @param {number} [step=1] - Sequence step identifier
 * @returns {string} SHA-256 hash representation
 */
function generateCampaignFingerprint(platform, campaignId, leadId, actionType, step = 1) {
  if (!platform || !campaignId || !leadId || !actionType) {
    throw new Error("Missing parameters for campaign fingerprint generation.");
  }
  const cleanPlatform = platform.toLowerCase().trim();
  const cleanAction = actionType.toLowerCase().trim();
  const seed = `${cleanPlatform}:${campaignId}:${leadId}:${cleanAction}:${step}`;
  
  return crypto.createHash("sha256").update(seed).digest("hex");
}

// ── 6. CAMPAIGN PAUSE CHECKING (SIDE-EFFECTING) ──────────────────────────────
/**
 * Introspects campaigns table status to confirm if automation should continue.
 *
 * @param {object} db - Database context
 * @param {number} campaignId - Target campaign ID
 * @returns {boolean} True if campaign is draft, paused, or completed
 */
function isCampaignPaused(db, campaignId) {
  if (!db) throw new Error("Database context is required for pause checks.");
  if (!campaignId) return true; // Default pause for unspecified campaign ID

  const row = db.prepare("SELECT status FROM campaigns WHERE id = ?").get(campaignId);
  if (!row) return true; // If campaign does not exist, consider it paused/bypassed
  
  return row.status !== "active";
}

// ── 7. DM PROMOTION LOGIC (PURE) ─────────────────────────────────────────────
/**
 * Evaluates lead qualification status and connection job outcomes to confirm
 * if the lead's path is promoted to the DM sequence stage.
 *
 * @param {string} leadStatus - Lead status record ('replied', 'messaged', etc.)
 * @param {string} connectionJobStatus - Connection job outcomes ('accepted', 'sent')
 * @returns {boolean} True if DM scheduling is allowed
 */
function shouldPromoteToDm(leadStatus, connectionJobStatus) {
  const normalizedLead = String(leadStatus).trim().toLowerCase();
  const normalizedJob = String(connectionJobStatus).trim().toLowerCase();

  // If connection is verified as accepted OR status indicates manual/auto qualification replies
  return normalizedJob === "accepted" || normalizedLead === "replied";
}

// ── 8. SAFE DATABASE TRANSACTIONS (SIDE-EFFECTING) ───────────────────────────
/**
 * Executes operations within an isolated, atomic Database Transaction block.
 *
 * @param {object} db - Database context
 * @param {function} operation - Execution logic function (db) => {}
 * @returns {*} Results returned by target execution logic
 */
function runInTransaction(db, operation) {
  if (!db) throw new Error("Database context is required to execute transactions.");
  if (typeof operation !== "function") throw new Error("Operation must be a valid callback function.");

  const transaction = db.transaction((...args) => {
    return operation(db, ...args);
  });

  return transaction();
}

// ── 9. QUEUE-SAFE LOGGING (SIDE-EFFECTING) ───────────────────────────────────
/**
 * Prints fully structured, timestamped logs with uniform queue and job contexts.
 *
 * @param {string} level - Log category ('info', 'warn', 'error')
 * @param {string} queueName - Source queue controller
 * @param {number|string} jobId - Associated queue item ID
 * @param {string} message - Primary log description
 * @param {object} [context={}] - Optional metadata parameters
 */
function queueLog(level, queueName, jobId, message, context = {}) {
  const timestamp = new Date().toISOString();
  const cleanLevel = String(level).toUpperCase();
  const cleanQueue = String(queueName).toUpperCase();

  const output = {
    timestamp,
    level: cleanLevel,
    queue: cleanQueue,
    jobId,
    message,
    ...context
  };

  const formattedStr = `[${timestamp}] [${cleanLevel}] [QUEUE:${cleanQueue}] [JOB:${jobId}] ${message}`;

  if (level === "error") {
    console.error(formattedStr, Object.keys(context).length ? context : "");
  } else if (level === "warn") {
    console.warn(formattedStr, Object.keys(context).length ? context : "");
  } else {
    console.log(formattedStr, Object.keys(context).length ? context : "");
  }

  // Broadcast the queue log to Socket.IO real-time clients (Gracefully isolated)
  try {
    const socketService = require("../../services/socketService");
    socketService.emitTo("campaigns", "queue:log", output);
  } catch (err) {
    // Graceful degradation
  }

  return output; // Return logs payload for analytical validations
}

// ── 10. TERMINAL VS RETRYABLE OUTCOME CLASSIFICATION (PURE) ──────────────────
/**
 * Logical evaluation classifier reading message scripts or exception strings
 * to determine if a failure requires progressive retries or terminal aborts.
 *
 * @param {string|Error} errorInput - Caught error message or object
 * @returns {object} { isTerminal: boolean, action: 'fail' | 'retry' }
 */
function classifyOutcome(errorInput) {
  const errorMsg = String(errorInput?.message || errorInput || "").toLowerCase();

  // Define patterns indicating permanent account/target issues (Terminal)
  const terminalPatterns = [
    "invalid credentials",
    "account suspended",
    "profile not found",
    "no longer exists",
    "deactivated",
    "unauthorized",
    "invalid user",
    "blocked access",
    "premium required"
  ];

  for (const pattern of terminalPatterns) {
    if (errorMsg.includes(pattern)) {
      return { isTerminal: true, action: "fail" };
    }
  }

  // Otherwise, default to retryable delays (network drops, rate limits, browser page crashes)
  return { isTerminal: false, action: "retry" };
}

module.exports = {
  calculateBackoffDelay,
  recordCampaignEvent,
  updateConnectionJobStatus,
  updateDmJobStatus,
  getNextDayBusinessHourWindow,
  generateCampaignFingerprint,
  isCampaignPaused,
  shouldPromoteToDm,
  runInTransaction,
  queueLog,
  classifyOutcome,
  registerCampaignStream,
  campaignSseStreams
};
