/**
 * messages/generateRoutes.js — Message generation + streaming + active-job
 * status routes.
 *
 * Routes:
 *   POST /api/messages/generate         (single-lead generation with caching)
 *   POST /api/messages/generate-all     (background bulk-generation job)
 *   GET  /api/messages/stream/:jobId    (SSE stream for a generate-all job)
 *   GET  /api/messages/active           (is a bulk generate-all job running?)
 *
 * The `nextJobId` counter (module-private mutable state in the original
 * routes/messages.js) is preserved here as a module-level `let` since it is
 * only referenced by the `/api/messages/generate-all` route.
 *
 * Original routes/messages.js was 561 lines; this is one of its thematic
 * splits. Relative require paths were updated for the new directory depth.
 */

const { getDb } = require("../../db/database");
const {
  generateMessages,
  generateAllMessages,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
} = require("../../services/messageService");

// Module-private counter for assigning unique job ids to bulk generate-all
// jobs. Survives for the lifetime of the process (matches the original
// `let nextJobId = 1` at the top of routes/messages.js).
let nextJobId = 1;

module.exports = function registerGenerateRoutes(router) {
  // ---------------------------------------------------------------------------
  // API: Generate messages for a single lead
  // ---------------------------------------------------------------------------
  router.post("/api/messages/generate", async (req, res) => {
    try {
      const { leadId, platform, productPitch, tone } = req.body;
      if (!leadId) return res.status(400).json({ error: "leadId is required" });

      const db = getDb();

      // Check for existing pending messages
      const existing = db
        .prepare(
          `SELECT * FROM messages
       WHERE lead_id = ? AND status = 'pending' AND is_follow_up = 0
       ORDER BY generated_at DESC`,
        )
        .all(leadId);

      if (existing.length >= 2) {
        const varA = existing.find((m) => m.variant === "A") || existing[0];
        const varB = existing.find((m) => m.variant === "B") || existing[1];
        return res.json({
          variantA: { id: varA.id, body: varA.body },
          variantB: varB ? { id: varB.id, body: varB.body } : null,
          cached: true,
        });
      }

      const result = await generateMessages(
        leadId,
        platform || null,
        null,
        tone || "friendly",
      );

      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // API: Generate messages for ALL qualified leads (background job)
  // ---------------------------------------------------------------------------
  router.post("/api/messages/generate-all", (req, res) => {
    const { productPitch, tone } = req.body || {};
    const jobId = `msg-${nextJobId++}`;

    const db = getDb();
    const pendingCount = db
      .prepare(
        `SELECT COUNT(*) AS c FROM leads l
     WHERE l.status = 'qualified'
       AND NOT EXISTS (
         SELECT 1 FROM messages m
         WHERE m.lead_id = l.id AND m.status IN ('pending', 'approved')
       )`,
      )
      .get().c;

    if (pendingCount === 0) {
      return res.json({
        jobId: null,
        message: "No qualified leads without messages",
      });
    }

    setImmediate(() => {
      generateAllMessages(jobId, productPitch, tone).catch((error) => {
        emitJobEvent(jobId, { type: "error", jobId, message: error.message });
        closeJobStream(jobId);
      });
    });

    return res.status(202).json({ jobId, pendingCount });
  });

  // ---------------------------------------------------------------------------
  // API: SSE stream
  // ---------------------------------------------------------------------------
  router.get("/api/messages/stream/:jobId", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    registerJobStream(req.params.jobId, res);
  });

  // GET /api/messages/active — is a bulk message-generation job currently
  // running? Backed by message_generation_jobs (completed_at IS NULL means
  // still in progress), so this survives a refresh and is visible to any
  // other tab, unlike the jobId that used to live only in page-local state.
  router.get("/api/messages/active", (req, res) => {
    const job = getDb()
      .prepare(
        `SELECT id, status, started_at FROM message_generation_jobs
       WHERE completed_at IS NULL
       ORDER BY started_at DESC
       LIMIT 1`,
      )
      .get();

    if (!job) {
      return res.json({ active: false });
    }

    return res.json({ active: true, jobId: job.id, status: job.status });
  });
};
