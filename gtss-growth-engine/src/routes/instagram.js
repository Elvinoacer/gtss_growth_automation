const express = require("express");
const { getDb } = require("../db/database");
const { renderPage } = require("./pageRenderer");
const { completeWarmup } = require("../automation/instagramWarmup");
const instagramWarmupJob = require("../jobs/instagramWarmupJob");
const logger = require("../utils/logger");

const router = express.Router();

// Helper to log orchestration events matching standard structure
const getDummyEmitter = () => {
  return (eventObj) => {
    const { type, message } = eventObj || {};
    logger.info("WARMUP_API_DISPATCH", `[${type || "info"}] ${message || ""}`);
  };
};

// ---------------------------------------------------------------------------
// Page Route
// ---------------------------------------------------------------------------
router.get("/instagram/warmup", (req, res) => {
  renderPage(res, {
    title: "InstagramWarmup",
    primaryHeading: "Instagram Warmup Pipeline",
    primaryCopy: "Warm up prospects progressively before triggering outbound drafts.",
  });
});

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

// 1. GET /api/instagram/warmup-pipeline (data payload for stats, cards, and current settings)
router.get("/api/instagram/warmup-pipeline", (req, res) => {
  try {
    const db = getDb();

    // -- Fetch stats --
    const total = db.prepare("SELECT COUNT(*) as c FROM ig_warmup_sequences WHERE status != 'skipped'").get().c;
    const following = db.prepare("SELECT COUNT(*) as c FROM ig_warmup_sequences WHERE status IN ('pending', 'following')").get().c;
    const story_viewed = db.prepare("SELECT COUNT(*) as c FROM ig_warmup_sequences WHERE status = 'story_viewed'").get().c;
    const liked = db.prepare("SELECT COUNT(*) as c FROM ig_warmup_sequences WHERE status = 'liked'").get().c;
    const dm_ready = db.prepare("SELECT COUNT(*) as c FROM ig_warmup_sequences WHERE status = 'warmup_complete'").get().c;

    const avgRow = db.prepare(`
      SELECT AVG(julianday(completed_at) - julianday(created_at)) as avg_days
      FROM ig_warmup_sequences
      WHERE status = 'warmup_complete' AND completed_at IS NOT NULL
    `).get();
    const avg_warmup_days = avgRow && avgRow.avg_days ? Math.round(avgRow.avg_days * 10) / 10 : 0;

    const completedCount = db.prepare("SELECT COUNT(*) as c FROM ig_warmup_sequences WHERE status = 'warmup_complete'").get().c;
    const abandonedCount = db.prepare("SELECT COUNT(*) as c FROM ig_warmup_sequences WHERE status = 'skipped'").get().c;
    const completionRate = (completedCount + abandonedCount) > 0 
      ? Math.round((completedCount / (completedCount + abandonedCount)) * 100) 
      : 0;

    const stats = {
      total,
      following,
      story_viewed,
      liked,
      dm_ready,
      avg_warmup_days,
      completionRate
    };

    // -- Fetch pipeline cards --
    const rows = db.prepare(`
      SELECT 
        s.id AS sequenceId,
        s.lead_id AS leadId,
        s.status AS currentStatus,
        COALESCE(s.last_action_at, s.created_at) AS enteredStepAt,
        l.ig_username AS username,
        l.name AS displayName,
        l.ig_follower_count AS followersCount,
        l.company AS company,
        s.next_step AS nextStep
      FROM ig_warmup_sequences s
      JOIN leads l ON s.lead_id = l.id
      WHERE s.status != 'skipped'
      ORDER BY s.id DESC
    `).all();

    const pipeline = rows.map(row => {
      const diffTime = Math.abs(Date.now() - new Date(row.enteredStepAt).getTime());
      const daysInStep = Math.max(0, Math.floor(diffTime / (1000 * 60 * 60 * 24)));
      const canSkipToDm = row.currentStatus !== "warmup_complete";

      return {
        sequenceId: row.sequenceId,
        leadId: row.leadId,
        username: row.username,
        displayName: row.displayName || row.username,
        company: row.company || "",
        followersCount: row.followersCount || 0,
        currentStatus: row.currentStatus,
        daysInStep,
        canSkipToDm
      };
    });

    // -- Fetch step delay settings --
    const settingRows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'warmup_%' OR key IN ('fast_warmup_enabled', 'auto_warmup_on_qualify')").all();
    const settings = {
      warmup_min_follow_to_story_hours: 24,
      warmup_max_follow_to_story_hours: 48,
      warmup_min_story_to_like_hours: 12,
      warmup_max_story_to_like_hours: 24,
      warmup_min_like_to_dm_hours: 24,
      warmup_max_like_to_dm_hours: 48,
      fast_warmup_enabled: 0,
      auto_warmup_on_qualify: 1
    };

    settingRows.forEach(r => {
      if (settings[r.key] !== undefined) {
        settings[r.key] = Number(r.value);
      }
    });

    return res.json({
      success: true,
      stats,
      pipeline,
      settings
    });
  } catch (err) {
    logger.error("WARMUP_API_ERROR", `Failed yielding pipeline data: ${err.message}`);
    return res.status(500).json({ error: "Failed to load warmup pipeline" });
  }
});

// 2. POST /api/instagram/warmup/:sequenceId/skip
router.post("/api/instagram/warmup/:sequenceId/skip", (req, res) => {
  const { sequenceId } = req.params;
  try {
    const db = getDb();
    const seq = db.prepare("SELECT lead_id FROM ig_warmup_sequences WHERE id = ?").get(sequenceId);

    if (!seq) {
      return res.status(404).json({ error: "Warmup sequence not found" });
    }

    // Set sequence step to done
    db.prepare("UPDATE ig_warmup_sequences SET next_step = 'done' WHERE id = ?").run(sequenceId);

    // Call completeWarmup to sync state and generate DMs
    const emitter = getDummyEmitter();
    completeWarmup(seq.lead_id, emitter);

    logger.info("WARMUP_API_DISPATCH", `Manually skipped sequence ID ${sequenceId} to DM Ready.`);
    return res.json({ success: true });
  } catch (err) {
    logger.error("WARMUP_API_ERROR", `Failed skipping sequence ${sequenceId}: ${err.message}`);
    return res.status(500).json({ error: "Failed to skip warmup step" });
  }
});

// 3. POST /api/instagram/warmup/:sequenceId/abandon
router.post("/api/instagram/warmup/:sequenceId/abandon", (req, res) => {
  const { sequenceId } = req.params;
  try {
    const db = getDb();
    const seq = db.prepare("SELECT lead_id FROM ig_warmup_sequences WHERE id = ?").get(sequenceId);

    if (!seq) {
      return res.status(404).json({ error: "Warmup sequence not found" });
    }

    db.transaction(() => {
      db.prepare(`
        UPDATE ig_warmup_sequences
        SET status = 'skipped',
            next_step = 'none',
            next_step_after = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(sequenceId);

      db.prepare(`
        UPDATE leads
        SET ig_warmup_status = 'skipped'
        WHERE id = ?
      `).run(seq.lead_id);
    })();

    logger.info("WARMUP_API_DISPATCH", `Abandoned sequence ID ${sequenceId} (lead ID ${seq.lead_id}).`);
    return res.json({ success: true });
  } catch (err) {
    logger.error("WARMUP_API_ERROR", `Failed abandoning sequence ${sequenceId}: ${err.message}`);
    return res.status(500).json({ error: "Failed to abandon warmup sequence" });
  }
});

// 4. POST /api/jobs/instagram-warmup/run (triggers instagramWarmupJob.run() asynchronously)
router.post("/api/jobs/instagram-warmup/run", (req, res) => {
  try {
    const emitter = getDummyEmitter();
    logger.info("WARMUP_API_DISPATCH", "Manual execution of Instagram warmup job triggered.");

    // Run asynchronously
    setImmediate(() => {
      instagramWarmupJob.run(emitter).catch(err => {
        logger.error("WARMUP_JOB_ERROR", `Manual warmup job failed asynchronously: ${err.message}`);
      });
    });

    return res.status(202).json({ success: true, message: "Warmup job runner triggered successfully." });
  } catch (err) {
    logger.error("WARMUP_API_ERROR", `Failed triggering job execution: ${err.message}`);
    return res.status(500).json({ error: "Failed to trigger warmup job" });
  }
});

// 5. POST /api/settings/instagram (save delay parameters)
router.post("/api/settings/instagram", (req, res) => {
  try {
    const db = getDb();
    const keys = [
      "warmup_min_follow_to_story_hours",
      "warmup_max_follow_to_story_hours",
      "warmup_min_story_to_like_hours",
      "warmup_max_story_to_like_hours",
      "warmup_min_like_to_dm_hours",
      "warmup_max_like_to_dm_hours",
      "fast_warmup_enabled",
      "auto_warmup_on_qualify",
      "unfollow_after_days",
      "unfollow_pending_after_days",
      "max_following_ratio",
      "discovery_max_per_hashtag",
      "discovery_min_followers",
      "discovery_max_followers",
      "ig_selector_version",
      "ig_blocked_until"
    ];

    db.transaction(() => {
      for (const key of keys) {
        if (req.body[key] !== undefined) {
          const val = String(req.body[key]).trim();
          db.prepare(`
            INSERT INTO settings (key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `).run(key, val);
        }
      }
    })();

    logger.info("WARMUP_API_DISPATCH", "Instagram warmup step delay settings updated.");
    return res.json({ success: true });
  } catch (err) {
    logger.error("WARMUP_API_ERROR", `Failed saving step delay settings: ${err.message}`);
    return res.status(500).json({ error: "Failed to save delay settings" });
  }
});

// 6. GET /api/settings/instagram (retrieve settings parameters)
router.get("/api/settings/instagram", (req, res) => {
  try {
    const db = getDb();
    const keys = [
      "warmup_min_follow_to_story_hours",
      "warmup_max_follow_to_story_hours",
      "warmup_min_story_to_like_hours",
      "warmup_max_story_to_like_hours",
      "warmup_min_like_to_dm_hours",
      "warmup_max_like_to_dm_hours",
      "fast_warmup_enabled",
      "auto_warmup_on_qualify",
      "unfollow_after_days",
      "unfollow_pending_after_days",
      "max_following_ratio",
      "discovery_max_per_hashtag",
      "discovery_min_followers",
      "discovery_max_followers",
      "ig_selector_version",
      "ig_blocked_until"
    ];

    const placeholders = keys.map(() => "?").join(",");
    const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`).all(...keys);
    
    const settings = {};
    for (const key of keys) {
      settings[key] = null;
    }
    for (const row of rows) {
      if (row.key === "ig_selector_version" || row.key === "ig_blocked_until") {
        settings[row.key] = row.value;
      } else {
        settings[row.key] = Number(row.value);
      }
    }
    return res.json(settings);
  } catch (err) {
    logger.error("WARMUP_API_ERROR", `Failed yielding delay settings: ${err.message}`);
    return res.status(500).json({ error: "Failed to fetch settings" });
  }
});

module.exports = router;
