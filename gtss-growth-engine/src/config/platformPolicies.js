/**
 * Platform Outreach Policies Configuration
 *
 * This module defines the strict, platform-specific operational constraints,
 * human-like delays, action warm-up rules, daily rate caps, and acceptable
 * active execution windows (local timezone bounds). These policies are
 * carefully crafted to mirror human activity, mitigating risk factors and
 * bypassing automated scraper and message detector limits on target networks.
 *
 * Rules defined for:
 *   - LinkedIn
 *   - X (formerly Twitter)
 *   - Instagram
 *   - Facebook
 *   - TikTok
 */

module.exports = {
  // ── LINKEDIN POLICY PROFILE ──────────────────────────────────────────────
  linkedin: {
    name: "LinkedIn",
    // Acceptable time ranges in local time where automation is permitted to execute
    activeWindow: {
      startHour: 9, // Permissible start hour (24h format, e.g., 9 AM)
      endHour: 18, // Permissible end hour (24h format, e.g., 6 PM)
      timezone: "local", // Enforce bounds matching system's local clock
    },
    // Randomization delay parameters (jitter) between successive steps to mimic organic browsing behavior
    delays: {
      actionMinSeconds: 30, // Floor delay for any micro-action (visits, follows, connections)
      actionMaxSeconds: 45, // Ceiling delay with applied random distribution
      sessionPauseMinutes: 5, // Hold duration after a batch of queue items before polling again
    },
    // Ramp-up sequence parameters to slowly transition cold profiles into high qualification limits
    warmup: {
      enabled: true, // Is progressive warmup active for LinkedIn?
      startDailyCount: 5, // Initial daily allowance upon warmup kickoff
      dailyIncrement: 2, // Increment factor applied to daily limits per day
      warmupDays: 14, // Number of progressive ramp days before full limits apply
    },
    // Rate limit thresholds to prevent rate-limit blocks
    hourlyLimits: {
      connections: 3, // Max connections per hour
      dms: 4, // Max messages sent per hour
      likes: 2, // Max profile updates/likes per hour
      visits: 5, // Max target profile visits per hour
    },
    weeklyLimits: {
      connections: 80,
    },
  },

  // ── X (TWITTER) POLICY PROFILE ───────────────────────────────────────────
  x: {
    name: "X (Twitter)",
    activeWindow: {
      startHour: 8,
      endHour: 22,
      timezone: "local",
    },
    delays: {
      actionMinSeconds: 20,
      actionMaxSeconds: 60,
      sessionPauseMinutes: 10,
    },
    warmup: {
      enabled: true,
      startDailyCount: 3,
      dailyIncrement: 1,
      warmupDays: 20,
    },
    hourlyLimits: {
      dms: 2,
      follows: 5,
      likes: 4,
    },
    weeklyLimits: {
      follows: 150,
    },
  },

  // ── INSTAGRAM POLICY PROFILE ──────────────────────────────────────────────
  instagram: {
    name: "Instagram",
    activeWindow: {
      startHour: 8,
      endHour: 20,
      timezone: "local",
    },
    delays: {
      actionMinSeconds: 45,
      actionMaxSeconds: 120,
      sessionPauseMinutes: 20,
    },
    warmup: {
      enabled: true,
      startDailyCount: 5,
      dailyIncrement: 2,
      warmupDays: 10,
    },
    hourlyLimits: {
      dms: 3,
      follows: 4,
      likes: 3,
    },
    weeklyLimits: {
      follows: 100,
    },
  },

  // ── FACEBOOK POLICY PROFILE ───────────────────────────────────────────────
  facebook: {
    name: "Facebook",
    activeWindow: {
      startHour: 9,
      endHour: 17,
      timezone: "local",
    },
    delays: {
      actionMinSeconds: 60,
      actionMaxSeconds: 180,
      sessionPauseMinutes: 30,
    },
    warmup: {
      enabled: false,
      startDailyCount: 5,
      dailyIncrement: 1,
      warmupDays: 7,
    },
    hourlyLimits: {
      connections: 2,
      follows: 2,
      dms: 2,
      likes: 2,
    },
    weeklyLimits: {
      connections: 40,
      follows: 40,
    },
  },

  // ── TIKTOK POLICY PROFILE ─────────────────────────────────────────────────
  tiktok: {
    name: "TikTok",
    activeWindow: {
      startHour: 9,
      endHour: 22,
      timezone: "local",
    },
    delays: {
      actionMinSeconds: 40,
      actionMaxSeconds: 110,
      sessionPauseMinutes: 15,
    },
    warmup: {
      enabled: true,
      startDailyCount: 3,
      dailyIncrement: 2,
      warmupDays: 14,
    },
    hourlyLimits: {
      follows: 4,
      likes: 4,
      dms: 2,
    },
    weeklyLimits: {
      follows: 60,
    },
  },
};
