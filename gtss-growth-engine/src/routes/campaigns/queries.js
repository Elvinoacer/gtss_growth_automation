/**
 * campaigns/queries.js
 *
 * Registers the read-only campaign-query routes on the campaigns API
 * router:
 *   GET /api/campaigns          — paginated list (filterable by status)
 *   GET /api/campaigns/:id      — single campaign + aggregate metrics
 *   GET /api/campaigns/:id/events — paginated campaign event log
 *
 * Required deps (passed in via `requireDeps`):
 *   - getDb, asyncHandler
 */

function register({ router, requireDeps }) {
  const { getDb, asyncHandler } = requireDeps();

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/campaigns — paginated list, optional status filter.
  // ─────────────────────────────────────────────────────────────────────────
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

      // Attach per-campaign aggregate stats so the listing cards can show
      // real progress (connections initiated, DMs sent, etc.) without making
      // the user click into each campaign. This mirrors the per-detail
      // metrics returned by GET /:id, but is computed in bulk for the page.
      if (campaigns.length > 0) {
        const campaignIds = campaigns.map((c) => c.id);
        const placeholders = campaignIds.map(() => "?").join(",");

        const connStats = db
          .prepare(
            `SELECT campaign_id, status, COUNT(*) as count
             FROM connection_jobs
             WHERE campaign_id IN (${placeholders})
             GROUP BY campaign_id, status`,
          )
          .all(...campaignIds);
        const dmStats = db
          .prepare(
            `SELECT campaign_id, status, COUNT(*) as count
             FROM dm_jobs
             WHERE campaign_id IN (${placeholders})
             GROUP BY campaign_id, status`,
          )
          .all(...campaignIds);

        const statsByCampaign = new Map();
        for (const c of campaigns) {
          statsByCampaign.set(c.id, {
            connection_jobs: { total: 0, by_status: {} },
            dm_jobs: { total: 0, by_status: {} },
          });
        }
        for (const row of connStats) {
          const s = statsByCampaign.get(row.campaign_id);
          if (!s) continue;
          s.connection_jobs.total += row.count;
          s.connection_jobs.by_status[row.status] =
            (s.connection_jobs.by_status[row.status] || 0) + row.count;
        }
        for (const row of dmStats) {
          const s = statsByCampaign.get(row.campaign_id);
          if (!s) continue;
          s.dm_jobs.total += row.count;
          s.dm_jobs.by_status[row.status] =
            (s.dm_jobs.by_status[row.status] || 0) + row.count;
        }
        for (const c of campaigns) {
          c.stats = statsByCampaign.get(c.id);
        }
      }

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

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/campaigns/:id — single campaign + aggregate performance metrics.
  // ─────────────────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/campaigns/:id/events — paginated campaign event log.
  // ─────────────────────────────────────────────────────────────────────────
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
}

module.exports = { register };
