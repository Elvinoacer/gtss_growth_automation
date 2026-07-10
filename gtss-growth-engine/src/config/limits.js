/**
 * System Operational Limits Configuration
 *
 * Defines daily outreach rate limits and nests action/queue-specific hourly constraints
 * per social platform to guarantee strict anti-automation system compliance.
 *
 * Outer properties (e.g. `limits.linkedin.connections = 15`) are fully preserved
 * to maintain 100% backward compatibility with all existing warm-up calculators,
 * rate limiters, settings dashboard widgets, and platform queues.
 */

module.exports = {
  // ── LINKEDIN ENGAGEMENT LIMITS ───────────────────────────────────────────
  linkedin: {
    // Preserved Daily Limit Thresholds (Backward Compatible)
    connections: 15,       // Max connection invites per day
    dms: 20,               // Max direct messages per day
    likes: 10,             // Max posts liked per day
    visits: 40,            // Max profiles visited per day

    // Queue-Specific/Hourly Limits Extension
    hourly: {
      connections: 3,      // Max connections per hour
      dms: 4,              // Max direct messages per hour
      likes: 2,            // Max likes per hour
      visits: 5            // Max visits per hour
    }
  },

  // ── X (TWITTER) ENGAGEMENT LIMITS ────────────────────────────────────────
  x: {
    // Preserved Daily Limit Thresholds (Backward Compatible)
    dms: 10,               // Max direct messages per day
    follows: 30,           // Max account follows per day
    likes: 20,             // Max posts liked per day

    // Queue-Specific/Hourly Limits Extension
    hourly: {
      dms: 2,              // Max direct messages per hour
      follows: 5,          // Max follows per hour
      likes: 4             // Max likes per hour
    }
  },

  // ── INSTAGRAM ENGAGEMENT LIMITS ──────────────────────────────────────────
  instagram: {
    // Preserved Daily Limit Thresholds (Backward Compatible)
    dms: 15,               // Max direct messages per day
    follows: 20,           // Max account follows per day
    likes: 15,             // Max posts liked per day

    // Queue-Specific/Hourly Limits Extension
    hourly: {
      dms: 3,              // Max direct messages per hour
      follows: 4,          // Max follows per hour
      likes: 3             // Max likes per hour
    }
  },

  // ── FACEBOOK ENGAGEMENT LIMITS ───────────────────────────────────────────
  facebook: {
    // Preserved Daily Limit Thresholds (Backward Compatible)
    dms: 10,               // Max direct messages per day
    likes: 10,             // Max posts liked per day

    // Queue-Specific/Hourly Limits Extension
    hourly: {
      dms: 2,              // Max direct messages per hour
      likes: 2             // Max likes per hour
    }
  },

  // ── TIKTOK ENGAGEMENT LIMITS ─────────────────────────────────────────────
  tiktok: {
    // Preserved Daily Limit Thresholds (Backward Compatible)
    follows: 25,           // Max account follows per day (conservative — TikTok is aggressive on follow-spam)
    likes: 20,             // Max videos liked per day
    dms: 10,               // Max direct messages per day (DMs require mutual follow on TikTok)

    // Queue-Specific/Hourly Limits Extension
    hourly: {
      follows: 4,          // Max follows per hour
      likes: 4,            // Max likes per hour
      dms: 2               // Max direct messages per hour
    }
  }
};
