const express = require("express");
const fs = require("fs");
const path = require("path");
const { getDb } = require("../db/database");
const { asyncHandler } = require("../utils/errorHandlers");
const { authenticatePlatform } = require("../automation/executor");
const logger = require("../utils/logger");
const { getDailyLimits } = require("../db/database");
const {
  getPlatformCatalog,
  getPlatformKeys,
} = require("../services/platformCatalog");
const igFollowTracker = require("../services/igFollowTracker");

const router = express.Router();

router.get("/platforms", (req, res) => {
  res.json({ platforms: getPlatformCatalog().entries });
});

router.get(
  "/sessions/status",
  asyncHandler(async (req, res) => {
    const rows = getDb()
      .prepare("SELECT platform, is_valid FROM platform_sessions")
      .all();
    const statusByPlatform = Object.fromEntries(
      getPlatformKeys().map((p) => [p, false]),
    );
    rows.forEach((row) => {
      if (
        Object.prototype.hasOwnProperty.call(statusByPlatform, row.platform)
      ) {
        statusByPlatform[row.platform] = Boolean(row.is_valid);
      }
    });
    res.json(statusByPlatform);
  }),
);

router.get(
  "/sessions/details",
  asyncHandler(async (req, res) => {
    const rows = getDb()
      .prepare("SELECT platform, last_active, is_valid FROM platform_sessions")
      .all();
    const byPlatform = Object.fromEntries(
      getPlatformKeys().map((p) => [
        p,
        {
          platform: p,
          status: "not_connected",
          last_active: null,
          is_valid: false,
        },
      ]),
    );
    rows.forEach((row) => {
      byPlatform[row.platform] = {
        platform: row.platform,
        status: row.is_valid ? "active" : "expired",
        last_active: row.last_active,
        is_valid: Boolean(row.is_valid),
      };
    });
    res.json(byPlatform);
  }),
);

router.post(
  "/sessions/clear/:platform",
  asyncHandler(async (req, res) => {
    const platform = req.params.platform;
    if (!getPlatformKeys().includes(platform))
      return res.status(404).json({ error: "Unknown platform" });
    const sessionPath = path.join(
      path.resolve(process.env.SESSION_DIR || "./sessions"),
      `${platform}.json`,
    );
    if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
    getDb()
      .prepare(
        `INSERT INTO platform_sessions (platform, cookie_blob, last_active, is_valid) VALUES (?, NULL, NULL, 0) ON CONFLICT(platform) DO UPDATE SET cookie_blob = NULL, last_active = NULL, is_valid = 0`,
      )
      .run(platform);
    res.json({ success: true });
  }),
);

router.post(
  "/sessions/authenticate/:platform",
  asyncHandler(async (req, res) => {
    const platform = req.params.platform;
    if (!getPlatformKeys().includes(platform))
      return res.status(404).json({ error: "Unknown platform" });

    try {
      await authenticatePlatform(platform);
      res.json({ success: true });
    } catch (error) {
      getDb()
        .prepare(
          `INSERT INTO platform_sessions (platform, cookie_blob, last_active, is_valid) VALUES (?, NULL, CURRENT_TIMESTAMP, 0) ON CONFLICT(platform) DO UPDATE SET last_active = CURRENT_TIMESTAMP, is_valid = 0`,
        )
        .run(platform);
      logger.error("AUTH", `Failed to authenticate ${platform}`, error);
      res.status(400).json({ error: error.message });
    }
  }),
);

router.get(
  "/stats/daily-actions",
  asyncHandler(async (req, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT platform, action_type, COUNT(*) AS used FROM daily_actions WHERE DATE(performed_at) = DATE('now', 'localtime') GROUP BY platform, action_type`,
      )
      .all();
    const limitsByPlatform = getDailyLimits();
    const byPlatform = Object.fromEntries(
      getPlatformKeys().map((platform) => [
        platform,
        { used: 0, limit: 0, byType: {} },
      ]),
    );

    rows.forEach((row) => {
      const bucket = byPlatform[row.platform] || {
        used: 0,
        limit: 0,
        byType: {},
      };
      bucket.used += Number(row.used || 0);
      bucket.byType[row.action_type] = Number(row.used || 0);
      byPlatform[row.platform] = bucket;
    });

    Object.entries(byPlatform).forEach(([platform, bucket]) => {
      bucket.limit = Object.values(limitsByPlatform[platform] || {}).reduce(
        (sum, value) => sum + Number(value || 0),
        0,
      );
    });

    const used = Object.values(byPlatform).reduce(
      (sum, bucket) => sum + bucket.used,
      0,
    );
    const limit = Object.values(byPlatform).reduce(
      (sum, bucket) => sum + bucket.limit,
      0,
    );

    res.json({ used, limit, byPlatform });
  }),
);

router.get(
  "/stats/instagram-follow-health",
  asyncHandler(async (req, res) => {
    const totalFollowing = igFollowTracker.getFollowingCount();
    const { followedBack, rate } = igFollowTracker.getFollowBackRate();
    const eligible = igFollowTracker.getUnfollowEligible();

    res.json({
      totalFollowing,
      totalFollowBacks: followedBack,
      followBackRate: rate,
      eligibleForUnfollow: eligible.length
    });
  })
);

module.exports = router;
