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
const {
  createActionFingerprint,
  releaseActionFingerprint,
} = require("../automation/idempotency");
const { determineActionType } = require("../automation/executor");
const {
  runFullPipeline,
  getPipelineRun,
  listPipelineRuns,
  registerPipelineStream,
} = require("../pipeline/pipelineRunner");

const router = express.Router();
const { broadcast } = require("../services/socketService");

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

// Store pending executor calls, keyed by jobId
const pendingExecutors = new Map();

// Run automation queue
router.post("/api/automation/run", (req, res) => {
  const jobId = crypto.randomUUID();
  res.json({ jobId });

  // Mark as pending — executor will be triggered when SSE connects
  pendingExecutors.set(jobId, true);

  // Safety fallback: if SSE never connects within 5s, run headless
  setTimeout(() => {
    if (pendingExecutors.has(jobId)) {
      pendingExecutors.delete(jobId);
      enqueueActionQueue(jobId, null).catch(console.error);
    }
  }, 5000);
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

  // If executor is pending, start it now that SSE is connected
  if (pendingExecutors.has(jobId)) {
    pendingExecutors.delete(jobId);
    enqueueActionQueue(jobId, res).catch(console.error);
  }

  req.on("close", () => {
    activeStreams.delete(jobId);
    // Automation continues — user can reconnect or it completes on its own
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

// ---------------------------------------------------------------------------
// Pipeline API Routes
// ---------------------------------------------------------------------------

// POST /api/pipeline/run — trigger full or partial pipeline
router.post("/api/pipeline/run", async (req, res) => {
  const { mode, stages } = req.body || {};
  const options = {};

  if (mode === 'ai' || mode === 'manual') {
    options.mode = mode;
  }
  if (Array.isArray(stages) && stages.length > 0) {
    const validStages = ['discovery', 'qualification', 'messages', 'send'];
    options.stages = stages.filter(s => validStages.includes(s));
    if (options.stages.length === 0) delete options.stages;
  }

  try {
    const runId = await runFullPipeline('manual', options);
    res.json({ success: true, runId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/pipeline/stream/:runId — SSE stream for pipeline events
router.get("/api/pipeline/stream/:runId", (req, res) => {
  const runId = req.params.runId;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  registerPipelineStream(runId, res);
});

// GET /api/pipeline/runs — list recent pipeline runs
router.get("/api/pipeline/runs", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const runs = listPipelineRuns(limit);
  res.json(runs);
});

// GET /api/pipeline/runs/:runId — single run detail
router.get("/api/pipeline/runs/:runId", (req, res) => {
  const run = getPipelineRun(Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Pipeline run not found' });
  res.json(run);
});

// ---------------------------------------------------------------------------
// Instagram Automation Settings API
// ---------------------------------------------------------------------------

// GET /api/automation/instagram/settings - Fetch Instagram settings, action block status, and selector health
router.get("/api/automation/instagram/settings", (req, res) => {
  try {
    const db = getDb();
    const { isInstagramBlocked, getSelectorHealthReport } = require("../automation/browserBase");

    const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ig_%' OR key LIKE 'warmup_%'").all();
    const settings = {};
    rows.forEach(r => {
      settings[r.key] = r.value;
    });

    res.json({
      success: true,
      settings,
      blockedStatus: isInstagramBlocked(),
      healthReport: getSelectorHealthReport()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/automation/instagram/settings - Update Instagram settings or reset blocks
router.post("/api/automation/instagram/settings", (req, res) => {
  try {
    const db = getDb();
    const { isInstagramBlocked, getSelectorHealthReport } = require("../automation/browserBase");
    const updates = req.body || {};

    const insertStmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    const deleteStmt = db.prepare("DELETE FROM settings WHERE key = ?");

    const transaction = db.transaction((settingsObj) => {
      for (const [key, value] of Object.entries(settingsObj)) {
        if (key.startsWith("ig_") || key.startsWith("warmup_")) {
          if (value === null || value === "") {
            deleteStmt.run(key);
          } else {
            insertStmt.run(key, String(value));
          }
        }
      }
    });

    transaction(updates);

    const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ig_%' OR key LIKE 'warmup_%'").all();
    const settings = {};
    rows.forEach(r => {
      settings[r.key] = r.value;
    });

    res.json({
      success: true,
      settings,
      blockedStatus: isInstagramBlocked(),
      healthReport: getSelectorHealthReport()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
