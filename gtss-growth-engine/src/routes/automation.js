const express = require("express");
const crypto = require("crypto");
const { renderPage } = require("./pageRenderer");
const { getDb } = require("../db/database");
const { getDailyLimits } = require("../db/database");
const {
  enqueueActionQueue,
  stopJob,
  getQueuedActions,
} = require("../automation/executor");
const { getPlatformKeys } = require("../services/platformCatalog");

const router = express.Router();

// SSE response storage
const activeStreams = new Map();

// ---------------------------------------------------------------------------
// Page Routes
// ---------------------------------------------------------------------------

router.get("/automation", (req, res) => {
  renderPage(res, {
    title: "Automation",
    primaryHeading: "Automation Control",
    primaryCopy: "Manage and monitor active browser routines.",
  });
});

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

// Get limits and current usage
router.get("/api/automation/limits", (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `
    SELECT platform, action_type, COUNT(*) AS used
    FROM daily_actions
    WHERE DATE(performed_at) = DATE('now', 'localtime')
    GROUP BY platform, action_type
  `,
    )
    .all();

  const dailyLimits = getDailyLimits();
  const data = {};

  getPlatformKeys().forEach((platform) => {
    let totalUsed = 0;
    let totalLimit = 0;

    Object.entries(dailyLimits[platform] || {}).forEach(([action, limit]) => {
      const row = rows.find(
        (r) => r.platform === platform && r.action_type === action,
      );
      totalUsed += row ? row.used : 0;
      totalLimit += Number(limit || 0);
    });

    data[platform] = {
      used: totalUsed,
      limit: totalLimit,
    };
  });

  res.json(data);
});

// Get queued actions
router.get("/api/automation/queue", (req, res) => {
  try {
    const queue = getQueuedActions();
    res.json(queue);
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
      SELECT d.id, d.platform, d.action_type, d.performed_at, d.outcome,
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

// Run automation queue
router.post("/api/automation/run", (req, res) => {
  const jobId = crypto.randomUUID();

  // Return job ID immediately
  res.json({ jobId });

  // We'll pick up the SSE stream connection shortly, but for now we wait
  // 1 second before starting the executor to give the client time to connect
  setTimeout(() => {
    const sseRes = activeStreams.get(jobId);
    enqueueActionQueue(jobId, sseRes).catch(console.error);
  }, 1000);
});

// SSE stream endpoint
router.get("/api/automation/stream/:jobId", (req, res) => {
  const { jobId } = req.params;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  activeStreams.set(jobId, res);

  req.on("close", () => {
    activeStreams.delete(jobId);
    stopJob(jobId);
  });
});

// Stop a running job
router.post("/api/automation/stop/:jobId", (req, res) => {
  const { jobId } = req.params;
  const stopped = stopJob(jobId);
  res.json({ success: true, stopped });
});

// Skip an action
router.patch("/api/automation/queue/:messageId/skip", (req, res) => {
  try {
    const db = getDb();
    db.prepare(`UPDATE messages SET status = 'skipped' WHERE id = ?`).run(
      req.params.messageId,
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Note: /api/sessions/authenticate/:platform is handled in api.js

// Open a manual browser to fix captcha
router.post("/api/automation/open-browser/:platform", async (req, res) => {
  const { platform } = req.params;
  try {
    const {
      createBrowser,
      getProfileDir,
    } = require("../automation/browserBase");
    const browserState = await createBrowser(platform, {
      headless: false,
      trace: false,
    });
    const { page } = browserState;
    await page.goto(`https://www.${platform}.com`);

    res.json({
      success: true,
      mode: browserState.mode,
      profileDir:
        browserState.mode === "persistent" ? getProfileDir(platform) : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
