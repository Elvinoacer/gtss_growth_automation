const express = require("express");
const { getDb } = require("../db/database");
const { asyncHandler } = require("../utils/errorHandlers");
const { isValidPlatform } = require("../utils/validation");
const {
  startCampaign,
  pauseCampaign,
  resumeCampaign,
} = require("../campaign/campaignOrchestrator");
const { isCampaignQueueInProgress, __private } = require("../jobs/backgroundJobs");
const { registerCampaignStream } = require("../campaign/utils/campaignUtils");
const logger = require("../utils/logger");
const { broadcast } = require("../services/socketService");

const router = express.Router();

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/campaigns
 * Create and immediately start a campaign.
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { name, platform } = req.body;

    // 1. Inputs validation
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Campaign name is required and must be a non-empty string." });
    }
    if (!platform || typeof platform !== "string" || !platform.trim()) {
      return res.status(400).json({ error: "Platform key is required." });
    }

    const normPlatform = platform.toLowerCase().trim();
    if (!isValidPlatform(normPlatform)) {
      return res.status(400).json({ error: `Unsupported or invalid platform: '${platform}'.` });
    }

    const db = getDb();
    let campaignId;

    try {
      // 2. Perform safe SQLite transaction to insert campaign record in 'draft'
      const insertResult = db.prepare(`
        INSERT INTO campaigns (name, platform, status, created_at, updated_at)
        VALUES (?, ?, 'draft', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(name.trim(), normPlatform);
      
      campaignId = insertResult.lastInsertRowid;
    } catch (err) {
      logger.error("CAMPAIGNS-API", `Failed to insert campaign record: ${err.message}`, err);
      return res.status(500).json({ error: "Database error occurred during campaign creation." });
    }

    // 3. Kick off campaign execution (which switches state to active and enqueues jobs)
    try {
      startCampaign(campaignId);
    } catch (err) {
      logger.error("CAMPAIGNS-API", `Campaign created (#${campaignId}) but start action failed: ${err.message}`, err);
      // Retrieve whatever status the campaign has (usually draft or active if failed mid-way)
      const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId);
      return res.status(500).json({
        error: `Campaign created successfully but failed to execute start sequence: ${err.message}`,
        campaign
      });
    }

    // 4. Return successful 201 Created response
    const finalCampaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId);
    return res.status(201).json({
      success: true,
      campaign: finalCampaign
    });
  })
);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/campaigns
 * Retrieve a paginated list of campaigns, optionally filtered by status.
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
    const offset = (page - 1) * limit;
    
    const db = getDb();
    const whereClauses = [];
    const params = [];

    if (req.query.status && typeof req.query.status === "string" && req.query.status.trim()) {
      whereClauses.push("status = ?");
      params.push(req.query.status.toLowerCase().trim());
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    // Calculate total matching records
    const countQuery = `SELECT COUNT(*) as count FROM campaigns ${whereSql}`;
    const total = db.prepare(countQuery).get(params).count;

    // Retrieve matching records
    const selectQuery = `
      SELECT * FROM campaigns
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `;
    const selectParams = [...params, limit, offset];
    const campaigns = db.prepare(selectQuery).all(selectParams);

    return res.json({
      campaigns,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  })
);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/campaigns/:id
 * Retrieve details and performance metrics for a specific campaign by ID.
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid campaign ID parameter." });
    }

    const db = getDb();
    const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);

    if (!campaign) {
      return res.status(404).json({ error: `Campaign with ID ${id} not found.` });
    }

    // Retrieve aggregate performance metrics for premium UX
    const connectionMetrics = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM connection_jobs
      WHERE campaign_id = ?
      GROUP BY status
    `).all(id);

    const dmMetrics = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM dm_jobs
      WHERE campaign_id = ?
      GROUP BY status
    `).all(id);

    const metrics = {
      connection_jobs: {
        total: connectionMetrics.reduce((sum, row) => sum + row.count, 0),
        by_status: Object.fromEntries(connectionMetrics.map(r => [r.status, r.count]))
      },
      dm_jobs: {
        total: dmMetrics.reduce((sum, row) => sum + row.count, 0),
        by_status: Object.fromEntries(dmMetrics.map(r => [r.status, r.count]))
      }
    };

    return res.json({
      campaign: {
        ...campaign,
        metrics
      }
    });
  })
);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/campaigns/:id/pause
 * Pause execution of an active campaign.
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.post(
  "/:id/pause",
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid campaign ID parameter." });
    }

    const db = getDb();
    const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);

    if (!campaign) {
      return res.status(404).json({ error: `Campaign with ID ${id} not found.` });
    }

    try {
      pauseCampaign(id);
      broadcast("campaign:status", { campaignId: id, status: "paused" });
    } catch (err) {
      logger.error("CAMPAIGNS-API", `Failed to pause campaign #${id}: ${err.message}`, err);
      return res.status(500).json({ error: err.message });
    }

    return res.json({
      success: true,
      message: "Campaign paused successfully."
    });
  })
);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/campaigns/:id/resume
 * Resume execution of a paused campaign.
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.post(
  "/:id/resume",
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid campaign ID parameter." });
    }

    const db = getDb();
    const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);

    if (!campaign) {
      return res.status(404).json({ error: `Campaign with ID ${id} not found.` });
    }

    try {
      resumeCampaign(id);
      broadcast("campaign:status", { campaignId: id, status: "active" });
    } catch (err) {
      logger.error("CAMPAIGNS-API", `Failed to resume campaign #${id}: ${err.message}`, err);
      return res.status(500).json({ error: err.message });
    }

    return res.json({
      success: true,
      message: "Campaign resumed successfully."
    });
  })
);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/campaigns/:id/events
 * Retrieve a paginated log of events generated by a campaign.
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.get(
  "/:id/events",
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid campaign ID parameter." });
    }

    const db = getDb();
    const campaignExists = db.prepare("SELECT 1 FROM campaigns WHERE id = ?").get(id);
    if (!campaignExists) {
      return res.status(404).json({ error: `Campaign with ID ${id} not found.` });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;

    const total = db.prepare("SELECT COUNT(*) as count FROM campaign_events WHERE campaign_id = ?").get(id).count;
    const events = db.prepare(`
      SELECT * FROM campaign_events
      WHERE campaign_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(id, limit, offset);

    // Safely parse details_json into metadata
    const parsedEvents = events.map(evt => {
      let metadata = {};
      if (evt.details_json) {
        try {
          metadata = JSON.parse(evt.details_json);
        } catch (_) {}
      }
      return {
        id: evt.id,
        campaign_id: evt.campaign_id,
        lead_id: evt.lead_id,
        event_type: evt.event_type,
        created_at: evt.created_at,
        metadata
      };
    });

    return res.json({
      events: parsedEvents,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  })
);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/campaigns/:id/stream
 * Connect to a Server-Sent Events (SSE) live event stream for this campaign.
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.get(
  "/:id/stream",
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid campaign ID parameter." });
    }

    const db = getDb();
    const campaignExists = db.prepare("SELECT 1 FROM campaigns WHERE id = ?").get(id);
    if (!campaignExists) {
      return res.status(404).json({ error: `Campaign with ID ${id} not found.` });
    }

    // Set headers for Server-Sent Events (SSE) stream
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    // Register active SSE client stream
    registerCampaignStream(id, res);
  })
);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/campaigns/:id/connection-jobs
 * Retrieve a paginated list of connection jobs for a specific campaign.
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.get(
  "/:id/connection-jobs",
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid campaign ID parameter." });
    }

    const db = getDb();
    const campaignExists = db.prepare("SELECT 1 FROM campaigns WHERE id = ?").get(id);
    if (!campaignExists) {
      return res.status(404).json({ error: `Campaign with ID ${id} not found.` });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;

    const total = db.prepare("SELECT COUNT(*) as count FROM connection_jobs WHERE campaign_id = ?").get(id).count;
    const jobs = db.prepare(`
      SELECT cj.*, l.name as lead_name, l.profile_url, l.x_handle
      FROM connection_jobs cj
      JOIN leads l ON cj.lead_id = l.id
      WHERE cj.campaign_id = ?
      ORDER BY cj.id DESC
      LIMIT ? OFFSET ?
    `).all(id, limit, offset);

    return res.json({
      jobs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  })
);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/campaigns/:id/dm-jobs
 * Retrieve a paginated list of DM jobs for a specific campaign.
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.get(
  "/:id/dm-jobs",
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid campaign ID parameter." });
    }

    const db = getDb();
    const campaignExists = db.prepare("SELECT 1 FROM campaigns WHERE id = ?").get(id);
    if (!campaignExists) {
      return res.status(404).json({ error: `Campaign with ID ${id} not found.` });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;

    const total = db.prepare("SELECT COUNT(*) as count FROM dm_jobs WHERE campaign_id = ?").get(id).count;
    const jobs = db.prepare(`
      SELECT dj.*, l.name as lead_name, l.profile_url, l.x_handle
      FROM dm_jobs dj
      JOIN leads l ON dj.lead_id = l.id
      WHERE dj.campaign_id = ?
      ORDER BY dj.id DESC
      LIMIT ? OFFSET ?
    `).all(id, limit, offset);

    return res.json({
      jobs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  })
);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/campaigns/run-connection-queue
 * Instantly triggers the Connection Queue processing run in the background.
 * Enforces mutex lock protection to avoid multiple concurrent Playwright instances.
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.post(
  "/run-connection-queue",
  asyncHandler(async (req, res) => {
    // 1. Thread-safe concurrency check
    if (isCampaignQueueInProgress()) {
      return res.status(409).json({
        error: "Concurrency lock active: Another campaign outreach queue run is in progress.",
        code: 409
      });
    }

    // 2. Trigger connection queue asynchronously without blocking the HTTP request thread
    logger.info("API", "Manual run triggered for Connection Queue.");
    __private.runConnectionQueueJob().catch((err) => {
      logger.error("API", "Asynchronous manual connection queue processing failed", err);
    });

    // 3. Return 202 Accepted
    return res.status(202).json({
      success: true,
      status: "queued",
      message: "Connection queue processing run initiated."
    });
  })
);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/campaigns/run-dm-queue
 * Instantly triggers the DM Queue processing run in the background.
 * Enforces mutex lock protection to avoid multiple concurrent Playwright instances.
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.post(
  "/run-dm-queue",
  asyncHandler(async (req, res) => {
    // 1. Thread-safe concurrency check
    if (isCampaignQueueInProgress()) {
      return res.status(409).json({
        error: "Concurrency lock active: Another campaign outreach queue run is in progress.",
        code: 409
      });
    }

    // 2. Trigger DM queue asynchronously without blocking the HTTP request thread
    logger.info("API", "Manual run triggered for DM Queue.");
    __private.runDmQueueJob().catch((err) => {
      logger.error("API", "Asynchronous manual DM queue processing failed", err);
    });

    // 3. Return 202 Accepted
    return res.status(202).json({
      success: true,
      status: "queued",
      message: "DM queue processing run initiated."
    });
  })
);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/campaigns/queue-status/lock
 * Retrieve campaign queue advisory lock status and in-progress execution status.
 * ─────────────────────────────────────────────────────────────────────────────
 */
router.get(
  "/queue-status/lock",
  asyncHandler(async (req, res) => {
    const db = getDb();
    const lockRow = db.prepare("SELECT value FROM settings WHERE key = 'campaign_queue_lock'").get();
    const isLocked = lockRow ? lockRow.value === "true" : false;
    return res.json({
      locked: isLocked,
      inProgress: isCampaignQueueInProgress()
    });
  })
);

// ── Campaigns Page Views Router ──────────────────────────────────────────────
const pageRouter = express.Router();
const { renderPage } = require("./pageRenderer");

pageRouter.get("/campaigns", (req, res) => {
  renderPage(res, {
    title: "Campaigns",
    primaryHeading: "Campaign outreach pipelines",
    primaryCopy: "Create, configure, and monitor your multi-channel automated campaigns."
  });
});

pageRouter.get("/campaigns/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).send("Invalid campaign ID.");
  }
  const db = getDb();
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
  if (!campaign) {
    return res.status(404).send("Campaign not found.");
  }
  renderPage(res, {
    title: "CampaignDetail",
    primaryHeading: campaign.name,
    campaignId: campaign.id
  });
});

module.exports = router;
module.exports.pageRouter = pageRouter;
