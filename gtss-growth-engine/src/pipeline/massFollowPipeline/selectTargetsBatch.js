/**
 * massFollowPipeline/selectTargetsBatch.js
 *
 * Stage-1 helper: pull a batch of pending mass_follow_targets rows for the
 * configured platforms.
 *
 * Honors per-platform active windows and daily/hourly/weekly caps. If a
 * platform has hit any of its caps (or is outside its active window), that
 * platform is excluded from this batch — its targets stay 'pending' for the
 * next run.
 *
 * Returns: { targets, skippedPlatforms }
 *   - targets:           Array of mass_follow_targets rows (capped at maxFollowsPerRun)
 *   - skippedPlatforms:  Array of { platform, reason, ...metrics } for diagnostics
 */

const { getDb } = require("../../db/database");
const platformPolicies = require("../../config/platformPolicies");
const logger = require("../../utils/logger");
const { SUPPORTED_PLATFORMS, isWithinActiveWindow } = require("./shared");
const {
  getDailyFollowCount,
  getHourlyFollowCount,
  getWeeklyFollowCount,
  getEffectiveDailyLimit,
  getEffectiveHourlyLimit,
  getEffectiveWeeklyLimit,
} = require("./followLimits");

function selectTargetsBatch(platforms, maxFollowsPerRun, respectActiveWindow, maxFollowsPerPlatform = {}) {
  const db = getDb();
  const skippedPlatforms = [];
  const eligiblePlatforms = [];

  for (const platform of platforms) {
    if (!SUPPORTED_PLATFORMS.has(platform)) {
      logger.warn(
        "MASS-FOLLOW-PIPELINE",
        `Skipping unsupported platform: ${platform}`,
      );
      skippedPlatforms.push({ platform, reason: "unsupported" });
      continue;
    }
    const policy = platformPolicies[platform];
    if (respectActiveWindow && !isWithinActiveWindow(policy)) {
      skippedPlatforms.push({ platform, reason: "outside_active_window" });
      continue;
    }
    const daily = getDailyFollowCount(platform);
    const dailyLimit = getEffectiveDailyLimit(platform);
    if (daily >= dailyLimit) {
      skippedPlatforms.push({ platform, reason: "daily_limit_reached", daily, dailyLimit });
      continue;
    }
    const hourly = getHourlyFollowCount(platform);
    const hourlyLimit = getEffectiveHourlyLimit(platform);
    if (hourly >= hourlyLimit) {
      skippedPlatforms.push({ platform, reason: "hourly_limit_reached", hourly, hourlyLimit });
      continue;
    }
    const weekly = getWeeklyFollowCount(platform);
    const weeklyLimit = getEffectiveWeeklyLimit(platform);
    if (weekly >= weeklyLimit) {
      skippedPlatforms.push({ platform, reason: "weekly_limit_reached", weekly, weeklyLimit });
      continue;
    }
    eligiblePlatforms.push({
      platform,
      remainingDaily: Math.max(0, dailyLimit - daily),
      remainingHourly: Math.max(0, hourlyLimit - hourly),
      remainingWeekly: Math.max(0, weeklyLimit - weekly),
    });
  }

  if (eligiblePlatforms.length === 0) {
    return { targets: [], skippedPlatforms };
  }

  // Pull pending or retryable rows for the eligible platforms, oldest first.
  // Retryable = status='failed' AND retry_count < max_retries AND
  // (next_retry_at IS NULL OR next_retry_at <= now).
  const placeholders = eligiblePlatforms.map(() => "?").join(",");
  const platformArgs = eligiblePlatforms.map((p) => p.platform);

  // Per-platform caps so a single platform doesn't starve the others.
  // The effective cap for each platform is the MIN of:
  //   - remaining hourly headroom
  //   - remaining daily headroom
  //   - remaining weekly headroom
  //   - the global maxFollowsPerRun ceiling
  //   - the user-configured per-platform override (maxFollowsPerPlatform[p])
  //     if it is set and > 0. A value of 0 means "fall back to the global cap".
  const perPlatformCap = eligiblePlatforms.map((p) => {
    const configured = Number(maxFollowsPerPlatform[p.platform] || 0);
    const effectiveConfigured = configured > 0 ? configured : maxFollowsPerRun;
    return Math.min(p.remainingHourly, p.remainingDaily, p.remainingWeekly, maxFollowsPerRun, effectiveConfigured);
  });

  // Pull a generous superset then trim per-platform in JS. Fetch the
  // largest cap across platforms so each bucket has enough rows to fill.
  const fetchLimit = Math.max(maxFollowsPerRun * 2, ...perPlatformCap, maxFollowsPerRun);
  const superset = db
    .prepare(
      `SELECT id, platform, profile_url, handle, source, campaign_id, lead_id,
              retry_count, max_retries, next_retry_at
       FROM mass_follow_targets
       WHERE platform IN (${placeholders})
         AND (
           status = 'pending'
           OR (status = 'failed'
               AND retry_count < COALESCE(max_retries, 3)
               AND (next_retry_at IS NULL OR datetime(next_retry_at) <= datetime('now')))
         )
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(...platformArgs, fetchLimit);

  // Bucket by platform, trim to per-platform cap, preserve chronological order
  const buckets = new Map(eligiblePlatforms.map((p) => [p.platform, []]));
  for (const row of superset) {
    if (!buckets.has(row.platform)) continue;
    buckets.get(row.platform).push(row);
  }
  const targets = [];
  eligiblePlatforms.forEach((p, idx) => {
    const cap = perPlatformCap[idx];
    const bucket = buckets.get(p.platform).slice(0, cap);
    targets.push(...bucket);
  });

  // Final trim to overall maxFollowsPerRun (in case several platforms each
  // contributed their full cap and the total exceeds the run-level ceiling).
  return { targets: targets.slice(0, maxFollowsPerRun), skippedPlatforms };
}

module.exports = { selectTargetsBatch };
