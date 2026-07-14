/**
 * Automation Routes — Skip / Retry Queue Actions
 *
 * Express handlers for re-queuing individual or bulk message actions:
 *   PATCH /api/automation/queue/:messageId/skip          — Mark a message as 'skipped'
 *   PATCH /api/automation/queue/:messageId/retry         — Re-queue a single blocked/skipped/sent message
 *   POST  /api/automation/queue/retry-selected           — Bulk retry a specific list of messageIds
 *   POST  /api/automation/queue/retry-all                — Bulk retry by mode (all/blocked/waiting) and optional fail_category
 *
 * All retry handlers release the action's idempotency fingerprint so the
 * re-run is not treated as a duplicate of the original attempt.
 *
 * Cross-file dependencies: ../../db/database (getDb), ../../automation/executor
 * (determineActionType), ../../automation/idempotency (createActionFingerprint,
 * releaseActionFingerprint), ../../services/socketService (broadcast).
 *
 * Extracted from the original routes/automation.js for maintainability.
 */

const { getDb } = require("../../db/database");
const { determineActionType } = require("../../automation/executor");
const {
  createActionFingerprint,
  releaseActionFingerprint,
} = require("../../automation/idempotency");
const { broadcast } = require("../../services/socketService");

/**
 * Register skip / retry routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerRetryRoutes(router) {
  // Skip an action
  router.patch("/api/automation/queue/:messageId/skip", (req, res) => {
    try {
      const db = getDb();
      db.prepare(`UPDATE messages SET status = 'skipped' WHERE id = ?`).run(
        req.params.messageId,
      );
      broadcast('automation:queue', { action: 'skip', messageId: req.params.messageId });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch("/api/automation/queue/:messageId/retry", (req, res) => {
    try {
      const db = getDb();
      const msg = db
        .prepare(
          `
        SELECT m.*, l.profile_url
        FROM messages m
        JOIN leads l ON l.id = m.lead_id
        WHERE m.id = ?
      `,
        )
        .get(req.params.messageId);

      if (!msg) return res.status(404).json({ error: "Queue message not found" });

      if (!["approved", "blocked", "skipped", "sent"].includes(msg.status)) {
        return res
          .status(400)
          .json({ error: `Cannot retry message with status '${msg.status}'` });
      }

      // Clear the fingerprint so this action is not treated as a duplicate
      const actionType = determineActionType(msg);
      const fingerprint = createActionFingerprint(
        {
          platform: msg.platform,
          profile_url: msg.profile_url,
          lead_id: msg.lead_id,
          message_id: msg.id,
        },
        actionType,
      );
      releaseActionFingerprint(fingerprint);

      const result = db
        .prepare(
          `
        UPDATE messages
        SET status = 'approved',
            blocked_reason = NULL,
            fail_category = NULL,
            last_error = NULL,
            snooze_until = NULL,
            retry_count = 0
        WHERE id = ?
      `,
        )
        .run(req.params.messageId);

      res.json({ success: true });
      broadcast('automation:queue', { action: 'retry', messageId: req.params.messageId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


  router.post("/api/automation/queue/retry-selected", (req, res) => {
    try {
      const ids = Array.isArray(req.body?.messageIds)
        ? req.body.messageIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
        : [];

      if (ids.length === 0) {
        return res.status(400).json({ error: "Select at least one action to retry" });
      }

      const db = getDb();
      const placeholders = ids.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT m.id, m.platform, m.lead_id, m.status, m.fail_category, m.is_follow_up, l.profile_url
           FROM messages m
           JOIN leads l ON l.id = m.lead_id
           WHERE m.id IN (${placeholders})
             AND (m.status IN ('blocked', 'skipped', 'sent')
               OR (m.status = 'approved' AND m.snooze_until IS NOT NULL AND datetime(m.snooze_until) > datetime('now')))`
        )
        .all(...ids);

      const update = db.prepare(`
        UPDATE messages
        SET status = 'approved',
            blocked_reason = NULL,
            fail_category = NULL,
            last_error = NULL,
            snooze_until = NULL,
            retry_count = 0
        WHERE id = ?
      `);

      const updated = db.transaction((items) => {
        let count = 0;
        for (const item of items) {
          const actionType = determineActionType(item);
          releaseActionFingerprint(createActionFingerprint({
            platform: item.platform,
            profile_url: item.profile_url,
            lead_id: item.lead_id,
            message_id: item.id,
          }, actionType));
          count += update.run(item.id).changes;
        }
        return count;
      })(rows);

      broadcast('automation:queue', { action: 'retry-selected', updated, messageIds: ids });
      res.json({ success: true, updated, requested: ids.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/automation/queue/retry-all", (req, res) => {
    try {
      const db = getDb();
      const { mode = "all", category = null } = req.body || {};
      const filters = [];
      const params = [];

      if (mode === "blocked") {
        filters.push("m.status = 'blocked'");
      } else if (mode === "waiting") {
        filters.push("m.status = 'approved'");
        filters.push("m.snooze_until IS NOT NULL");
        filters.push("datetime(m.snooze_until) > datetime('now')");
      } else {
        filters.push(
          "(m.status = 'blocked' OR (m.status = 'approved' AND m.snooze_until IS NOT NULL AND datetime(m.snooze_until) > datetime('now')))",
        );
      }

      if (category) {
        filters.push("m.fail_category = ?");
        params.push(category);
      }

      const rows = db
        .prepare(
          `SELECT m.id, m.platform, m.lead_id, m.status, m.fail_category, l.profile_url
                   , m.is_follow_up
           FROM messages m
           JOIN leads l ON l.id = m.lead_id
           WHERE ${filters.join(" AND ")}
           ORDER BY m.generated_at DESC`,
        )
        .all(...params);

      if (rows.length === 0) {
        return res.json({ success: true, updated: 0 });
      }

      const update = db.prepare(`
        UPDATE messages
        SET status = 'approved',
            blocked_reason = NULL,
            fail_category = NULL,
            last_error = NULL,
            snooze_until = NULL,
            retry_count = 0
        WHERE id = ?
      `);

      const transaction = db.transaction((items) => {
        let updated = 0;
        for (const item of items) {
          const actionType = determineActionType(item);
          const fingerprint = createActionFingerprint(
            {
              platform: item.platform,
              profile_url: item.profile_url,
              lead_id: item.lead_id,
              message_id: item.id,
            },
            actionType,
          );
          releaseActionFingerprint(fingerprint);
          updated += update.run(item.id).changes;
        }
        return updated;
      });

      const updated = transaction(rows);
      broadcast('automation:queue', { action: 'retry-all', updated });
      res.json({ success: true, updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRetryRoutes };
