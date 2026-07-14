/**
 * Automation Routes — Queue Inspection + History
 *
 * Express handlers for reading the current automation queue and recent
 * action history (read-only):
 *   GET /api/automation/queue          — List queued actions (blocked + waiting included)
 *   GET /api/automation/queue/summary  — Aggregate counts: runnable / waiting / blocked / byCategory
 *   GET /api/automation/history        — Last 50 daily_actions with lead name joined
 *
 * Cross-file dependencies: ../../db/database (getDb), ../../automation/executor
 * (getQueuedActions).
 *
 * Extracted from the original routes/automation.js for maintainability.
 */

const { getDb } = require("../../db/database");
const { getQueuedActions } = require("../../automation/executor");

/**
 * Register the queue + history read-only routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerQueueRoutes(router) {
  // Get queued actions
  router.get("/api/automation/queue", (req, res) => {
    try {
      const queue = getQueuedActions({
        includeBlocked: true,
        includeWaiting: true,
      });
      res.json(queue);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/api/automation/queue/summary", (req, res) => {
    try {
      const queue = getQueuedActions({
        includeBlocked: true,
        includeWaiting: true,
      });
      const summary = queue.reduce(
        (accumulator, action) => {
          if (action.status === "blocked") {
            accumulator.blocked += 1;
          } else if (action.status === "approved" && action.runnable) {
            accumulator.runnable += 1;
          } else if (action.status === "approved") {
            accumulator.waiting += 1;
          }

          if (action.fail_category) {
            const existing = accumulator.byCategory.find(
              (entry) => entry.fail_category === action.fail_category,
            );
            if (existing) existing.count += 1;
            else
              accumulator.byCategory.push({
                fail_category: action.fail_category,
                count: 1,
              });
          }

          return accumulator;
        },
        { runnable: 0, waiting: 0, blocked: 0, byCategory: [] },
      );

      summary.total = queue.length;
      res.json(summary);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get recent history
  router.get("/api/automation/history", (req, res) => {
    try {
      const db = getDb();
      const history = db
        .prepare(
          `
        SELECT d.id, d.platform, d.action_type, d.performed_at, d.outcome, d.reason,
               l.name AS lead_name
        FROM daily_actions d
        LEFT JOIN leads l ON d.lead_id = l.id
        ORDER BY d.performed_at DESC
        LIMIT 50
      `,
        )
        .all();
      res.json(history);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = { registerQueueRoutes };
