/**
 * Campaign Orchestrator Module
 *
 * Implements high-integrity orchestration routines to control campaign
 * lifecycles (start, pause, resume, and structural status audits).
 *
 * Enforces atomic transactions per lead enqueue, strict idempotency checks via
 * action fingerprints, and platform-policy compliant job scheduling.
 */

const { getDb } = require("../db/database");
const platformPolicies = require("../config/platformPolicies");
const {
  runInTransaction,
  recordCampaignEvent,
  generateCampaignFingerprint,
  isCampaignPaused,
  getNextDayBusinessHourWindow,
  queueLog
} = require("./utils/campaignUtils");
const { reclaimStuckRunningJobs } = require("./utils/reclaimStuckJobs");

/**
 * Checks if current hour matches target platform active execution hours.
 *
 * @param {object} policy - Target platform policy configuration
 * @returns {boolean} True if within active execution window
 */
function isWithinActiveWindow(policy) {
  if (!policy || !policy.activeWindow) return true;
  const currentHour = new Date().getHours();
  return currentHour >= policy.activeWindow.startHour && currentHour < policy.activeWindow.endHour;
}

/**
 * Calculates initial scheduled_at timestamp for a new DM job based on policy windows and jitter.
 *
 * @param {string} platform - Social platform key (e.g. 'linkedin')
 * @returns {string} ISO 8601 scheduled timestamp
 */
function calculateScheduledTime(platform) {
  const normPlatform = String(platform).toLowerCase().trim();
  const policy = platformPolicies[normPlatform];

  if (!policy) {
    // Default fallback: current time plus a 5 minute safety interval
    return new Date(Date.now() + 5 * 60 * 1000).toISOString();
  }

  // If outside active execution window, schedule for next morning active start time
  if (!isWithinActiveWindow(policy)) {
    return getNextDayBusinessHourWindow(normPlatform);
  }

  // If inside active window, add minimal jitter delay
  const minDelaySeconds = policy.delays?.actionMinSeconds || 30;
  return new Date(Date.now() + minDelaySeconds * 1000).toISOString();
}

/**
 * Transaction-safe enqueuer for an individual lead.
 *
 * @param {object} db - Database context
 * @param {object} campaign - Campaign configuration record
 * @param {object} lead - Target lead record
 */
function enqueueLeadJobPair(db, campaign, lead) {
  // 1. Defensively assert campaign state has not been paused concurrently
  if (isCampaignPaused(db, campaign.id)) {
    queueLog("warn", "orchestrator", campaign.id, `Skipping enqueue for lead ${lead.id} because campaign was paused.`);
    return;
  }

  // 2. Prevent duplicate jobs: check if jobs already exist for (campaign_id, lead_id)
  const existingConn = db.prepare("SELECT id FROM connection_jobs WHERE campaign_id = ? AND lead_id = ?").get(campaign.id, lead.id);
  const existingDm = db.prepare("SELECT id FROM dm_jobs WHERE campaign_id = ? AND lead_id = ?").get(campaign.id, lead.id);

  if (existingConn || existingDm) {
    queueLog("info", "orchestrator", campaign.id, `Lead ${lead.id} is already enqueued. Skipping.`);
    return;
  }

  // 3. Cryptographic Idempotency Fingerprint checks
  const connFp = generateCampaignFingerprint(campaign.platform, campaign.id, lead.id, "connection", 1);
  const dmFp = generateCampaignFingerprint(campaign.platform, campaign.id, lead.id, "dm", 1);

  const fpExistConn = db.prepare("SELECT fingerprint FROM action_fingerprints WHERE fingerprint = ? AND expires_at > datetime('now')").get(connFp);
  const fpExistDm = db.prepare("SELECT fingerprint FROM action_fingerprints WHERE fingerprint = ? AND expires_at > datetime('now')").get(dmFp);

  if (fpExistConn || fpExistDm) {
    queueLog("warn", "orchestrator", campaign.id, `Active idempotency fingerprint found for lead ${lead.id}. Skipping.`);
    return;
  }

  // Calculate scheduled time following platform policy boundaries
  const scheduledAt = calculateScheduledTime(campaign.platform);

  // 4. Register action fingerprints in database to secure concurrency lock
  db.prepare(`
    INSERT INTO action_fingerprints (fingerprint, platform, action_type, target, lead_id, expires_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', '+24 hours'))
  `).run(connFp, campaign.platform, "connection", lead.profile_url || String(lead.id), lead.id);

  db.prepare(`
    INSERT INTO action_fingerprints (fingerprint, platform, action_type, target, lead_id, expires_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', '+24 hours'))
  `).run(dmFp, campaign.platform, "dm", lead.profile_url || String(lead.id), lead.id);

  // 5. Simultaneously insert Connection and DM job records (No orphans)
  db.prepare(`
    INSERT INTO connection_jobs (campaign_id, lead_id, status)
    VALUES (?, ?, 'pending')
  `).run(campaign.id, lead.id);

  db.prepare(`
    INSERT INTO dm_jobs (campaign_id, lead_id, status, scheduled_at)
    VALUES (?, ?, 'pending', ?)
  `).run(campaign.id, lead.id, scheduledAt);

  // 6. Record campaign events
  recordCampaignEvent(db, campaign.id, lead.id, "job_enqueued", {
    platform: campaign.platform,
    scheduled_at: scheduledAt
  });

  queueLog("info", "orchestrator", campaign.id, `Successfully enqueued job pair for lead ${lead.id}.`);
}

/**
 * Initiates the campaign, transitioning status to active and enqueuing jobs for qualified leads.
 *
 * @param {number} campaignId - Target campaign ID
 */
function startCampaign(campaignId) {
  const db = getDb();
  if (!campaignId) throw new Error("Campaign ID is required to start a campaign.");

  // Fetch campaign config
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId);
  if (!campaign) throw new Error(`Campaign with ID ${campaignId} not found.`);

  // If already active, treat it as idempotent and return
  if (campaign.status === "active") {
    queueLog("info", "orchestrator", campaignId, "Campaign is already active.");
    return;
  }

  // Update status to active
  db.prepare("UPDATE campaigns SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(campaignId);

  // Record campaign kickoff event
  recordCampaignEvent(db, campaignId, null, "campaign_started", {
    previous_status: campaign.status
  });

  // Query qualified leads matching platform
  const leads = db.prepare("SELECT * FROM leads WHERE platform = ? AND status = 'qualified'").all(campaign.platform);

  queueLog("info", "orchestrator", campaignId, `Found ${leads.length} qualified leads. Commencing transactional enqueue.`);

  // Atomically enqueue connection and DM jobs per lead
  for (const lead of leads) {
    try {
      runInTransaction(db, (txDb) => {
        enqueueLeadJobPair(txDb, campaign, lead);
      });
    } catch (err) {
      queueLog("error", "orchestrator", campaignId, `Failed to atomically enqueue jobs for lead ${lead.id}: ${err.message}`);
    }
  }
}

/**
 * Pauses campaign execution by transitioning its status.
 *
 * @param {number} campaignId - Target campaign ID
 */
function pauseCampaign(campaignId) {
  const db = getDb();
  if (!campaignId) throw new Error("Campaign ID is required to pause a campaign.");

  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId);
  if (!campaign) throw new Error(`Campaign with ID ${campaignId} not found.`);

  db.prepare("UPDATE campaigns SET status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(campaignId);

  // Reclaim any in-flight jobs for THIS campaign so they don't sit forever
  // in `running` if the worker was mid-action when the operator paused.
  // The live queue loop also re-checks campaign status between jobs and
  // will skip further work for this campaign.
  let reclaimed = { connectionJobs: 0, dmJobs: 0 };
  try {
    reclaimed = reclaimStuckRunningJobs(db, {
      campaignId,
      reason: "Campaign paused by operator — job reclaimed to pending",
    });
  } catch (err) {
    queueLog(
      "warn",
      "orchestrator",
      campaignId,
      `Failed to reclaim running jobs on pause: ${err.message}`,
    );
  }

  const hasMessagesTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
    .get();
  if (hasMessagesTable) {
    db.prepare(`
      UPDATE messages
      SET snooze_until = datetime('now', '+365 days')
      WHERE lead_id IN (
        SELECT lead_id FROM connection_jobs WHERE campaign_id = ?
        UNION
        SELECT lead_id FROM dm_jobs WHERE campaign_id = ?
      ) AND status = 'approved'
    `).run(campaignId, campaignId);
  }

  recordCampaignEvent(db, campaignId, null, "campaign_paused", {
    previous_status: campaign.status,
    reclaimed,
  });

  queueLog(
    "info",
    "orchestrator",
    campaignId,
    `Campaign successfully paused (reclaimed conn=${reclaimed.connectionJobs} dm=${reclaimed.dmJobs}).`,
  );
}

/**
 * Resumes execution of a paused campaign, enqueuing new jobs for qualified leads.
 *
 * @param {number} campaignId - Target campaign ID
 */
function resumeCampaign(campaignId) {
  const db = getDb();
  if (!campaignId) throw new Error("Campaign ID is required to resume a campaign.");

  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId);
  if (!campaign) throw new Error(`Campaign with ID ${campaignId} not found.`);

  if (campaign.status === "active") {
    queueLog("info", "orchestrator", campaignId, "Campaign is already active.");
    return;
  }

  db.prepare("UPDATE campaigns SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(campaignId);

  const hasMessagesTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
    .get();
  if (hasMessagesTable) {
    db.prepare(`
      UPDATE messages
      SET snooze_until = NULL
      WHERE lead_id IN (
        SELECT lead_id FROM connection_jobs WHERE campaign_id = ?
        UNION
        SELECT lead_id FROM dm_jobs WHERE campaign_id = ?
      ) AND status = 'approved' AND snooze_until IS NOT NULL
    `).run(campaignId, campaignId);
  }

  recordCampaignEvent(db, campaignId, null, "campaign_resumed", {
    previous_status: campaign.status
  });

  // Query newly qualified leads that don't have connection or DM jobs yet
  const leads = db.prepare(`
    SELECT * FROM leads
    WHERE platform = ? AND status = 'qualified'
      AND id NOT IN (SELECT lead_id FROM connection_jobs WHERE campaign_id = ?)
      AND id NOT IN (SELECT lead_id FROM dm_jobs WHERE campaign_id = ?)
  `).all(campaign.platform, campaignId, campaignId);

  queueLog("info", "orchestrator", campaignId, `Found ${leads.length} newly qualified leads to enqueue upon campaign resume.`);

  for (const lead of leads) {
    try {
      runInTransaction(db, (txDb) => {
        enqueueLeadJobPair(txDb, campaign, lead);
      });
    } catch (err) {
      queueLog("error", "orchestrator", campaignId, `Failed to atomically enqueue jobs on resume for lead ${lead.id}: ${err.message}`);
    }
  }
}

/**
 * Retreives full campaign structural metrics and current runtime status.
 *
 * @param {number} campaignId - Target campaign ID
 * @returns {object} Status and metrics report
 */
function getCampaignStatus(campaignId) {
  const db = getDb();
  if (!campaignId) throw new Error("Campaign ID is required to check campaign status.");

  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId);
  if (!campaign) throw new Error(`Campaign with ID ${campaignId} not found.`);

  // Sum up job outcomes
  const connRows = db.prepare("SELECT status, COUNT(*) as count FROM connection_jobs WHERE campaign_id = ? GROUP BY status").all(campaignId);
  const dmRows = db.prepare("SELECT status, COUNT(*) as count FROM dm_jobs WHERE campaign_id = ? GROUP BY status").all(campaignId);

  const connectionJobs = { pending: 0, sent: 0, failed: 0, accepted: 0 };
  for (const row of connRows) {
    connectionJobs[row.status] = row.count;
  }

  const dmJobs = { pending: 0, scheduled: 0, sent: 0, failed: 0 };
  for (const row of dmRows) {
    dmJobs[row.status] = row.count;
  }

  const eventsCountRow = db.prepare("SELECT COUNT(*) as count FROM campaign_events WHERE campaign_id = ?").get(campaignId);

  return {
    id: campaign.id,
    name: campaign.name,
    platform: campaign.platform,
    status: campaign.status,
    connectionJobs,
    dmJobs,
    eventsCount: eventsCountRow ? eventsCountRow.count : 0,
    created_at: campaign.created_at,
    updated_at: campaign.updated_at
  };
}

module.exports = {
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  getCampaignStatus
};
