/**
 * campaigns/jobs.js
 *
 * Registers the paginated job-listing routes on the campaigns API router:
 *   GET /api/campaigns/:id/connection-jobs — paginated connection jobs
 *   GET /api/campaigns/:id/dm-jobs         — paginated DM jobs
 *
 * Both routes JOIN against the leads table so the response includes the
 * lead's name, profile URL, and X handle alongside the job row.
 *
 * Required deps (passed in via `requireDeps`):
 *   - getDb, asyncHandler
 */

function register({ router, requireDeps }) {
  const { getDb, asyncHandler } = requireDeps();

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/campaigns/:id/connection-jobs — paginated connection jobs.
  // ─────────────────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/campaigns/:id/dm-jobs — paginated DM jobs.
  // ─────────────────────────────────────────────────────────────────────────
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
}

module.exports = { register };
