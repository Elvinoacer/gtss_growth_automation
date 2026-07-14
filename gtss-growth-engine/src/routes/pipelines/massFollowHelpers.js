/**
 * Pipelines Routes — Mass-Follow Helper Functions
 *
 * Pure (non-route) helpers that back the mass-follow pipeline:
 *   - normalizeLimits              : coerces + validates the per-pipeline limits blob
 *                                    (outreach / content / dm_check / mass_follow)
 *   - preflightMassFollowRun       : pre-flight check using massFollowPipeline._internal
 *   - inferMassFollowHandle        : pick the right per-platform handle from a lead row
 *   - importMassFollowTargetsFromLeads : bulk-import mass_follow_targets from CRM leads
 *   - preflightMassFollowWithImport: robust preflight + auto-import flow used by Run/Restart
 *   - normalizeMassFollowTarget    : validate a single (platform, profileUrl) pair
 *
 * Extracted from the original routes/pipelines.js for maintainability.
 */

const { getDb } = require('../../db/database');
const {
  ALLOWED_CONTENT_PLATFORMS,
  ALLOWED_OUTREACH_PLATFORMS,
  ALLOWED_MASS_FOLLOW_PLATFORMS,
} = require('./shared');

function normalizeLimits(id, limits) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    return {};
  }

  const next = { ...limits };
  for (const key of [
    'max_leads_per_keyword',
    'max_dms_per_run',
    'max_connections_per_run',
    'max_posts_per_run',
    'max_follows_per_run',
    'follow_interval_min_seconds',
    'follow_interval_max_seconds',
    'max_retries_per_target',
    'max_scrolls',
  ]) {
    if (next[key] !== undefined) {
      const numeric = Number(next[key]);
      if (!Number.isFinite(numeric) || numeric < 1) {
        throw new Error(`${key} must be a positive number`);
      }
      next[key] = Math.floor(numeric);
    }
  }

  if (id === 'content') {
    if (next.topic !== undefined) {
      next.topic = String(next.topic).trim();
    }
    if (next.style !== undefined) {
      next.style = String(next.style).trim() || 'photorealistic';
    }
    if (next.platforms !== undefined) {
      if (!Array.isArray(next.platforms)) {
        throw new Error('platforms must be an array');
      }
      next.platforms = next.platforms
        .map((platform) => String(platform).trim().toLowerCase())
        .filter((platform) => ALLOWED_CONTENT_PLATFORMS.has(platform));
      if (next.platforms.length === 0) {
        throw new Error('Select at least one content platform');
      }
    }
  }
  if (id === 'outreach') {
    if (next.platforms !== undefined) {
      if (!Array.isArray(next.platforms)) {
        throw new Error('platforms must be an array');
      }
      next.platforms = next.platforms
        .map((platform) => String(platform).trim().toLowerCase())
        .filter((platform) => ALLOWED_OUTREACH_PLATFORMS.has(platform));
      if (next.platforms.length === 0) {
        throw new Error('Select at least one outreach platform');
      }
    }
  }
  if (id === 'dm_check') {
    for (const key of ['active_hours_start', 'active_hours_end']) {
      if (next[key] !== undefined) next[key] = Number(next[key]);
    }
    if (next.platforms !== undefined && !Array.isArray(next.platforms)) {
      throw new Error('platforms must be an array');
    }
    if (Array.isArray(next.platforms)) {
      next.platforms = next.platforms.map((platform) => String(platform).trim().toLowerCase()).filter(Boolean);
    }
    if (next.timezone !== undefined) next.timezone = String(next.timezone).trim() || 'UTC';
    if (next.prompt !== undefined) next.prompt = String(next.prompt);
  }

  if (id === 'mass_follow') {
    if (next.platforms !== undefined) {
      if (!Array.isArray(next.platforms)) {
        throw new Error('platforms must be an array');
      }
      next.platforms = next.platforms
        .map((platform) => String(platform).trim().toLowerCase())
        .filter((platform) => ALLOWED_MASS_FOLLOW_PLATFORMS.has(platform));
      if (next.platforms.length === 0) {
        throw new Error('Select at least one mass-follow platform');
      }
    }
    // follow_interval_min_seconds must not exceed follow_interval_max_seconds
    if (
      next.follow_interval_min_seconds !== undefined &&
      next.follow_interval_max_seconds !== undefined &&
      Number(next.follow_interval_min_seconds) > Number(next.follow_interval_max_seconds)
    ) {
      throw new Error('follow_interval_min_seconds cannot exceed follow_interval_max_seconds');
    }
    for (const key of ['respect_active_window', 'skip_already_following', 'show_browser', 'auto_import_leads']) {
      if (next[key] !== undefined) {
        next[key] = next[key] === true || next[key] === 'true' || next[key] === 1 || next[key] === '1';
      }
    }
    // Per-platform max-follows overrides.
    // Shape: { instagram: 15, x: 10, linkedin: 8, facebook: 5 }
    // These cap how many targets the pipeline will follow on EACH platform
    // per run, independent of the global max_follows_per_run ceiling. A value
    // of 0 (or omission) means "fall back to the global cap for this platform".
    if (next.max_follows_per_platform !== undefined) {
      if (next.max_follows_per_platform === null) {
        next.max_follows_per_platform = {};
      } else if (typeof next.max_follows_per_platform === 'object' && !Array.isArray(next.max_follows_per_platform)) {
        const cleaned = {};
        for (const [platform, value] of Object.entries(next.max_follows_per_platform)) {
          const p = String(platform).trim().toLowerCase();
          if (!ALLOWED_MASS_FOLLOW_PLATFORMS.has(p)) continue;
          const n = Number(value);
          if (!Number.isFinite(n) || n < 0) {
            throw new Error(`max_follows_per_platform.${p} must be a non-negative number`);
          }
          cleaned[p] = Math.floor(n);
        }
        next.max_follows_per_platform = cleaned;
      } else {
        throw new Error('max_follows_per_platform must be an object like { instagram: 15, x: 10 }');
      }
    }
  }

  return next;
}

function preflightMassFollowRun(limits = {}) {
  const platforms = Array.isArray(limits.platforms)
    ? limits.platforms.map((platform) => String(platform).trim().toLowerCase()).filter((platform) => ALLOWED_MASS_FOLLOW_PLATFORMS.has(platform))
    : [];
  if (platforms.length === 0) {
    return {
      ok: false,
      error: 'No supported mass-follow platforms are configured. Select at least one of Instagram, LinkedIn, X, or Facebook.',
      reason: 'no_supported_platforms',
    };
  }

  const maxFollows = Math.max(1, Math.floor(Number(limits.max_follows_per_run) || 20));
  const respectActiveWindow = limits.respect_active_window !== false && limits.respect_active_window !== 'false';
  const maxFollowsPerPlatform = (limits.max_follows_per_platform && typeof limits.max_follows_per_platform === 'object')
    ? limits.max_follows_per_platform
    : {};
  const { _internal } = require('../../pipeline/massFollowPipeline');
  const selection = _internal.selectTargetsBatch(platforms, maxFollows, respectActiveWindow, maxFollowsPerPlatform);
  if (selection.targets.length > 0) {
    return { ok: true, eligibleCount: selection.targets.length };
  }

  const db = getDb();
  const placeholders = platforms.map(() => '?').join(',');
  const retryableCount = db.prepare(
    `SELECT COUNT(*) AS count
     FROM mass_follow_targets
     WHERE platform IN (${placeholders})
       AND (
         status = 'pending'
         OR (status = 'failed'
             AND retry_count < COALESCE(max_retries, 3)
             AND (next_retry_at IS NULL OR datetime(next_retry_at) <= datetime('now')))
       )`,
  ).get(...platforms)?.count || 0;

  if (retryableCount === 0) {
    return {
      ok: false,
      error: 'No eligible mass-follow targets. Add pending targets in Manage Targets, or retry failed targets whose backoff has expired.',
      reason: 'no_targets',
      skippedPlatforms: selection.skippedPlatforms,
    };
  }

  return {
    ok: false,
    error: 'Mass-follow has targets, but every configured platform is currently blocked by active-window or rate-limit rules.',
    reason: 'all_platforms_capped',
    skippedPlatforms: selection.skippedPlatforms,
  };
}

function inferMassFollowHandle(platform, lead) {
  if (platform === 'x' && lead.x_handle) return lead.x_handle;
  if (platform === 'instagram' && lead.ig_username) return lead.ig_username;
  if (lead.name) return lead.name;
  return null;
}

function importMassFollowTargetsFromLeads(options = {}) {
  const db = getDb();
  const platforms = Array.isArray(options.platforms) && options.platforms.length > 0
    ? options.platforms
        .map((platform) => String(platform).trim().toLowerCase())
        .filter((platform) => ALLOWED_MASS_FOLLOW_PLATFORMS.has(platform))
    : [...ALLOWED_MASS_FOLLOW_PLATFORMS];
  if (platforms.length === 0) {
    return { inserted: 0, updated: 0, considered: 0, platforms: [] };
  }

  const statuses = Array.isArray(options.statuses) && options.statuses.length > 0
    ? options.statuses.map((status) => String(status).trim()).filter(Boolean)
    : ['qualified', 'discovered', 'pending_qualification'];
  const limit = Math.max(1, Math.min(1000, Number(options.limit) || 200));
  const platformPlaceholders = platforms.map(() => '?').join(',');
  const statusPlaceholders = statuses.map(() => '?').join(',');

  const leads = db.prepare(
    `SELECT id, platform, name, profile_url, x_handle, ig_username, status
     FROM leads
     WHERE platform IN (${platformPlaceholders})
       AND status IN (${statusPlaceholders})
       AND profile_url IS NOT NULL
       AND TRIM(profile_url) != ''
       AND NOT EXISTS (
         SELECT 1 FROM mass_follow_targets m
         WHERE m.platform = leads.platform
           AND m.profile_url = leads.profile_url
           AND m.status IN ('pending', 'running', 'sent', 'accepted', 'skipped')
       )
     ORDER BY
       CASE status
         WHEN 'qualified' THEN 0
         WHEN 'discovered' THEN 1
         ELSE 2
       END,
       updated_at DESC,
       created_at DESC
     LIMIT ?`,
  ).all(...platforms, ...statuses, limit);

  const insertStmt = db.prepare(
    `INSERT INTO mass_follow_targets (platform, profile_url, handle, source, status, lead_id, max_retries)
     VALUES (?, ?, ?, 'lead_import', 'pending', ?, 3)
     ON CONFLICT(platform, profile_url) DO UPDATE SET
       handle = COALESCE(excluded.handle, mass_follow_targets.handle),
       lead_id = COALESCE(excluded.lead_id, mass_follow_targets.lead_id),
       source = 'lead_import',
       status = CASE WHEN mass_follow_targets.status IN ('sent','accepted','skipped') THEN mass_follow_targets.status ELSE 'pending' END,
       error_message = NULL,
       retry_count = 0,
       next_retry_at = NULL,
       updated_at = CURRENT_TIMESTAMP
     RETURNING id`,
  );

  let inserted = 0;
  let updated = 0;
  for (const lead of leads) {
    const before = db
      .prepare('SELECT id FROM mass_follow_targets WHERE platform = ? AND profile_url = ?')
      .get(lead.platform, lead.profile_url);
    insertStmt.get(
      lead.platform,
      lead.profile_url,
      inferMassFollowHandle(lead.platform, lead),
      lead.id,
    );
    if (before) updated += 1;
    else inserted += 1;
  }

  return { inserted, updated, considered: leads.length, platforms, statuses };
}

/**
 * Robust mass-follow preflight + auto-import flow.
 *
 * Behavior:
 *   1. If `auto_import_leads` is not explicitly false, ALWAYS top up the
 *      target pool from discovered/qualified leads (not just when empty).
 *      This makes "Run" reliably pick up freshly-discovered leads without
 *      requiring the user to manually click "Import from Leads".
 *   2. Run the preflight (selectTargetsBatch) to confirm there's work to do.
 *   3. If preflight still reports no_targets, try one more import pass
 *      (in case the first pass was skipped) and re-check.
 *   4. Return a structured result with a clear, user-facing `error` message
 *      that distinguishes between:
 *        - "no leads discovered yet" (considered === 0)
 *        - "all leads already messaged" (considered > 0 but inserted === 0)
 *        - "all platforms capped by rate limits / active window"
 *
 * Returns: { ok, reason?, error?, seeded, preflight }
 */
function preflightMassFollowWithImport(limits) {
  const autoImport = limits.auto_import_leads !== false && limits.auto_import_leads !== 'false';
  let seeded = null;

  const maxFollows = Math.max(1, Number(limits.max_follows_per_run || 20));
  // Import up to 3x the per-run cap so the pool has headroom for retry/failure backoff.
  const importLimit = Math.max(20, maxFollows * 3);

  if (autoImport) {
    seeded = importMassFollowTargetsFromLeads({
      platforms: limits.platforms,
      limit: importLimit,
    });
  }

  let preflight = preflightMassFollowRun(limits);

  // If still no targets and we haven't tried importing yet, try now.
  if (!preflight.ok && preflight.reason === 'no_targets' && !seeded) {
    seeded = importMassFollowTargetsFromLeads({
      platforms: limits.platforms,
      limit: importLimit,
    });
    if (seeded.inserted > 0 || seeded.updated > 0) {
      preflight = preflightMassFollowRun(limits);
    }
  }

  if (preflight.ok) {
    return { ok: true, seeded, preflight };
  }

  // Build a clear, actionable error message.
  let friendlyError = preflight.error;
  if (preflight.reason === 'no_targets') {
    if (!seeded || seeded.considered === 0) {
      friendlyError =
        'No mass-follow targets available. No discovered or qualified leads were found to import automatically. ' +
        'Run Lead Discovery first (and qualify the leads), or add targets manually via Manage Targets.';
    } else if (seeded.inserted === 0 && seeded.updated === 0) {
      friendlyError =
        'All discovered leads have already been followed or are currently in the mass-follow queue. ' +
        'Run Lead Discovery again to find new leads, or wait for the rate-limit / active-window caps to reset.';
    }
  } else if (preflight.reason === 'all_platforms_capped') {
    friendlyError =
      'Mass-follow has targets, but every configured platform is currently blocked by its active-window or rate-limit rules. ' +
      'Try again later, or adjust the platform active windows in Settings.';
  }

  return { ok: false, reason: preflight.reason, error: friendlyError, seeded, preflight };
}

/**
 * Validate a (platform, profileUrl) pair for mass-follow. Rejects empty
 * URLs and unsupported platforms. Returns the normalized pair.
 */
function normalizeMassFollowTarget(platform, profileUrl, handle, source) {
  const normPlatform = String(platform || '').trim().toLowerCase();
  if (!ALLOWED_MASS_FOLLOW_PLATFORMS.has(normPlatform)) {
    throw new Error(`Unsupported mass-follow platform: ${platform}`);
  }
  const url = String(profileUrl || '').trim();
  if (!url) {
    throw new Error('profile_url is required');
  }
  // Basic URL sanity check — accept full URLs and bare handles (e.g. @acme).
  if (!/^https?:\/\//i.test(url) && !/^@?[\w.\-]+$/i.test(url)) {
    throw new Error(`Invalid profile_url: ${url}`);
  }
  return {
    platform: normPlatform,
    profile_url: url,
    handle: handle ? String(handle).trim().slice(0, 200) : null,
    source: source ? String(source).trim().slice(0, 50) : 'manual',
  };
}

module.exports = {
  normalizeLimits,
  preflightMassFollowRun,
  inferMassFollowHandle,
  importMassFollowTargetsFromLeads,
  preflightMassFollowWithImport,
  normalizeMassFollowTarget,
};
