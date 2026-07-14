/**
 * campaigns/createAndLifecycle.js
 *
 * Registers the campaign-creation and campaign-lifecycle routes on the
 * campaigns API router:
 *   POST /api/campaigns              — create + immediately start a campaign
 *   POST /api/campaigns/:id/pause    — pause an active campaign
 *   POST /api/campaigns/:id/resume   — resume a paused campaign
 *
 * Each route handler is registered via the shared asyncHandler wrapper so
 * thrown errors propagate to Express's default error handler. The router
 * instance is passed in by `campaigns/index.js` so the split files stay
 * decoupled from how the router is constructed.
 *
 * Required deps (passed in via `requireDeps`):
 *   - getDb, asyncHandler, isValidPlatform
 *   - startCampaign, pauseCampaign, resumeCampaign (campaignOrchestrator)
 *   - broadcast (socketService)
 *   - logger
 */

function register({ router, requireDeps }) {
  const {
    getDb,
    asyncHandler,
    isValidPlatform,
    startCampaign,
    pauseCampaign,
    resumeCampaign,
    broadcast,
    logger,
  } = requireDeps();

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/campaigns — create and immediately start a campaign.
  // ─────────────────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/campaigns/:id/pause — pause execution of an active campaign.
  // ─────────────────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/campaigns/:id/resume — resume execution of a paused campaign.
  // ─────────────────────────────────────────────────────────────────────────
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
}

module.exports = { register };
