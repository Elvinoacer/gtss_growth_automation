/**
 * Discovery Routes — Results + Queue Actions
 *
 * Express handlers for paginating through discovered leads and acting on
 * them in bulk:
 *   GET  /results       — Paginated leads list filtered by status='discovered' + optional platform/keyword/dateFrom/dateTo
 *   POST /add-to-queue  — Move selected leads to 'pending_qualification' status (next pipeline stage)
 *   POST /dismiss       — Mark selected leads as 'dismissed'
 *
 * Cross-file dependencies: ../../db/database (getDb), ./shared (sanitizeLeadIds,
 * updateLeadStatuses).
 *
 * Extracted from the original routes/discovery.js for maintainability.
 */

const { getDb } = require("../../db/database");
const { sanitizeLeadIds, updateLeadStatuses } = require("./shared");

/**
 * Register the results + queue-action routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerResultsRoutes(router) {
  router.get("/results", (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const offset = (page - 1) * limit;
    const where = ["status = 'discovered'"];
    const params = {};

    if (req.query.platform) {
      where.push("platform = @platform");
      params.platform = req.query.platform;
    }

    if (req.query.keyword) {
      where.push("source_keyword LIKE @keyword");
      params.keyword = `%${req.query.keyword}%`;
    }

    if (req.query.dateFrom) {
      where.push("DATE(created_at) >= DATE(@dateFrom)");
      params.dateFrom = req.query.dateFrom;
    }

    if (req.query.dateTo) {
      where.push("DATE(created_at) <= DATE(@dateTo)");
      params.dateTo = req.query.dateTo;
    }

    const whereSql = where.join(" AND ");
    const total = getDb()
      .prepare(`SELECT COUNT(*) AS total FROM leads WHERE ${whereSql}`)
      .get(params).total;
    const leads = getDb()
      .prepare(
        `SELECT *
         FROM leads
         WHERE ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit, offset });

    res.json({
      page,
      limit,
      total,
      leads,
    });
  });

  router.post("/add-to-queue", (req, res) => {
    const leadIds = sanitizeLeadIds(req.body.leadIds);
    if (leadIds.length === 0) {
      return res.status(400).json({ error: "leadIds is required" });
    }

    const updated = updateLeadStatuses(leadIds, "pending_qualification");
    return res.json({ updated });
  });

  router.post("/dismiss", (req, res) => {
    const leadIds = sanitizeLeadIds(req.body.leadIds);
    if (leadIds.length === 0) {
      return res.status(400).json({ error: "leadIds is required" });
    }

    const updated = updateLeadStatuses(leadIds, "dismissed");
    return res.json({ updated });
  });
}

module.exports = { registerResultsRoutes };
