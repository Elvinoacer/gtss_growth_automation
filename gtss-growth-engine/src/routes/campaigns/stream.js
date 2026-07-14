/**
 * campaigns/stream.js
 *
 * Registers the Server-Sent Events (SSE) live event stream route:
 *   GET /api/campaigns/:id/stream — long-lived SSE connection forwarding
 *                                   campaign events to the client
 *
 * The handler sets the standard SSE response headers, flushes them so the
 * client can begin listening immediately, then registers the response
 * object with the campaign-utils stream registry (which is what actually
 * pushes subsequent events to the client as they happen).
 *
 * Required deps (passed in via `requireDeps`):
 *   - getDb, asyncHandler
 *   - registerCampaignStream (campaign/utils/campaignUtils)
 */

function register({ router, requireDeps }) {
  const { getDb, asyncHandler, registerCampaignStream } = requireDeps();

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/campaigns/:id/stream — Server-Sent Events live stream.
  // ─────────────────────────────────────────────────────────────────────────
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
}

module.exports = { register };
