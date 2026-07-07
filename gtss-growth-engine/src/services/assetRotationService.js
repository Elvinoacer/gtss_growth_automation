const { getDb } = require("../db/database");
const { logActivity } = require("./auditService");

function parseTags(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function normalizeAsset(row) {
  if (!row) return null;
  return {
    ...row,
    tags: parseTags(row.tags),
  };
}

function buildMediaWhere(mediaType) {
  if (!mediaType || mediaType === "both") {
    return { sql: "1 = 1", params: {} };
  }
  return { sql: "media_type = @mediaType", params: { mediaType } };
}

function pickNextAsset({ mediaType = "image", tags = [] } = {}) {
  const db = getDb();
  const where = buildMediaWhere(mediaType);
  const candidates = db
    .prepare(
      `SELECT *
       FROM asset_library
       WHERE ${where.sql}
       ORDER BY times_used ASC, COALESCE(last_used_at, '1970-01-01') ASC, id ASC`,
    )
    .all(where.params)
    .map(normalizeAsset);

  const filtered = Array.isArray(tags) && tags.length > 0
    ? candidates.filter((asset) => tags.every((tag) => asset.tags.includes(tag)))
    : candidates;

  if (filtered.length === 0) return null;

  const lowestUseCount = Math.min(...filtered.map((asset) => asset.times_used || 0));
  const leastUsed = filtered.filter((asset) => (asset.times_used || 0) === lowestUseCount);

  const lastUsed = db
    .prepare("SELECT asset_id FROM asset_usage_log ORDER BY used_at DESC, id DESC LIMIT 1")
    .get();
  const next =
    leastUsed.find((asset) => !lastUsed || asset.id !== lastUsed.asset_id) ||
    leastUsed[0];

  logActivity({
    activityType: "asset_used",
    entityType: "asset",
    entityId: next.id,
    status: "selected",
    summary: `Selected asset for rotation: ${next.name}`,
    details: { mediaType, fileUrl: next.file_url },
  });

  return next;
}

function markAssetUsed(assetId, postId = null) {
  const db = getDb();
  const asset = db.prepare("SELECT * FROM asset_library WHERE id = ?").get(assetId);
  if (!asset) return false;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE asset_library
       SET times_used = COALESCE(times_used, 0) + 1,
           last_used_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(assetId);
    db.prepare(
      "INSERT INTO asset_usage_log (asset_id, post_id) VALUES (?, ?)",
    ).run(assetId, postId);
  });

  tx();
  logActivity({
    activityType: "asset_used",
    entityType: "asset",
    entityId: assetId,
    status: "success",
    summary: `Asset used: ${asset.name}`,
    details: { postId, fileUrl: asset.file_url },
  });
  return true;
}

/**
 * Pick the next least-recently-used asset GROUP for posting.
 *
 * Returns { group, assets: [...] } where assets is an ordered array
 * (by asset_library.position, then id). Returns null if no groups exist.
 *
 * The content pipeline prefers groups over single assets when the user
 * has organised their library into groups — this lets the user explicitly
 * mark which images belong together as one multi-image post (carousel)
 * or which video to post with which thumbnail.
 *
 * @param {Object} opts
 * @param {string} [opts.postType='carousel'] - 'carousel' | 'video' | 'single' | 'any'
 * @param {string[]} [opts.tags=[]]
 * @returns {{group: Object, assets: Object[]} | null}
 */
function pickNextAssetGroup({ postType = "any", tags = [] } = {}) {
  const db = getDb();
  const where = postType && postType !== "any" ? "WHERE post_type = ?" : "";
  const params = postType && postType !== "any" ? [postType] : [];
  const groups = db
    .prepare(
      `SELECT * FROM asset_groups ${where}
       ORDER BY times_used ASC, COALESCE(last_used_at, '1970-01-01') ASC, id ASC`,
    )
    .all(...params);

  if (groups.length === 0) return null;

  const lowestUseCount = Math.min(...groups.map((g) => g.times_used || 0));
  const leastUsed = groups.filter((g) => (g.times_used || 0) === lowestUseCount);

  // Avoid the most-recently-used group if possible.
  const lastUsed = db
    .prepare("SELECT asset_id FROM asset_usage_log ORDER BY used_at DESC, id DESC LIMIT 1")
    .get();
  const chosen =
    leastUsed.find((g) => {
      if (!lastUsed) return true;
      // Check if any asset in this group was the last used.
      const inGroup = db
        .prepare("SELECT 1 FROM asset_library WHERE id = ? AND group_id = ?")
        .get(lastUsed.asset_id, g.id);
      return !inGroup;
    }) || leastUsed[0];

  // Load the group's assets, ordered by position then id.
  let assets = db
    .prepare(
      `SELECT * FROM asset_library WHERE group_id = ? ORDER BY position ASC, id ASC`,
    )
    .all(chosen.id)
    .map(normalizeAsset);

  // Optional tag filter (client-side).
  if (Array.isArray(tags) && tags.length > 0) {
    assets = assets.filter((asset) => tags.every((tag) => asset.tags.includes(tag)));
  }

  if (assets.length === 0) return null;

  logActivity({
    activityType: "asset_used",
    entityType: "asset_group",
    entityId: chosen.id,
    status: "selected",
    summary: `Selected asset group for rotation: ${chosen.name}`,
    details: { postType: chosen.post_type, assetCount: assets.length },
  });

  return { group: chosen, assets };
}

/**
 * Bump times_used + log usage for every asset in a group after a successful
 * publish. Also bumps the group's own times_used counter.
 */
function markAssetGroupUsed(groupId, postId = null) {
  const db = getDb();
  const group = db.prepare("SELECT * FROM asset_groups WHERE id = ?").get(groupId);
  if (!group) return false;

  const assets = db
    .prepare("SELECT * FROM asset_library WHERE group_id = ?")
    .all(groupId);

  const tx = db.transaction(() => {
    for (const asset of assets) {
      db.prepare(
        `UPDATE asset_library
         SET times_used = COALESCE(times_used, 0) + 1,
             last_used_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      ).run(asset.id);
      db.prepare(
        "INSERT INTO asset_usage_log (asset_id, post_id) VALUES (?, ?)",
      ).run(asset.id, postId);
    }
    db.prepare(
      `UPDATE asset_groups
       SET times_used = COALESCE(times_used, 0) + 1,
           last_used_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(groupId);
  });
  tx();

  logActivity({
    activityType: "asset_used",
    entityType: "asset_group",
    entityId: groupId,
    status: "success",
    summary: `Asset group used: ${group.name}`,
    details: { postId, assetCount: assets.length },
  });
  return true;
}

/**
 * Pick the next "publishable unit" for posting, treating both asset GROUPS
 * and UNGROUPED assets as equal citizens in a single rotation queue.
 *
 * Why this exists:
 *   The previous flow called `pickNextAssetGroup()` first and only fell
 *   back to `pickNextAsset()` when NO groups existed. That meant: as long
 *   as the user had even one group, every single ungrouped asset was
 *   STARVED — it never got picked, because a group was always returned.
 *   The user explicitly asked for both kinds to be used in sequence:
 *     "those [ungrouped] ones that have not been grouped together, I need
 *      you to be using them as they are whenever it's necessary."
 *   And: "ensure every asset eventually gets posted without unnecessary
 *   repetition."
 *
 * This function returns a unified result object:
 *   {
 *     kind: 'group' | 'single',
 *     group?: <asset_groups row>,          // present when kind === 'group'
 *     asset?: <asset_library row>,         // present when kind === 'single'
 *     assets: [<asset_library rows>],      // always present, ordered
 *   }
 *
 * Selection algorithm:
 *   1. Gather all groups (with their assets) and all ungrouped assets.
 *   2. Treat each as a "unit" with a `times_used` counter and a
 *      `last_used_at` timestamp.
 *   3. Pick the unit with the lowest `times_used`. Break ties by oldest
 *      `last_used_at`. Break further ties by lowest id.
 *   4. Avoid the unit that was used most recently (matches the
 *      behaviour of pickNextAsset / pickNextAssetGroup).
 *
 * This guarantees:
 *   - Every asset eventually gets posted (lowest times_used wins).
 *   - Both grouped and ungrouped assets rotate through (they share the
 *     same queue).
 *   - No unit is picked twice in a row when alternatives exist.
 *
 * @param {Object} opts
 * @param {string} [opts.mediaType='image'] - 'image' | 'video' | 'both'
 *   (applies only to UNGROUPED assets — grouped assets are returned as-is
 *   because the user explicitly chose what goes in each group).
 * @param {string[]} [opts.tags=[]]
 * @returns {{kind, group?, asset?, assets} | null}
 */
function pickNextAssetOrGroup({ mediaType = "image", tags = [] } = {}) {
  const db = getDb();

  // ── Build a unified list of publishable units ──────────────────────────
  const units = [];

  // 1. Asset groups (each group is one unit containing N assets).
  const groups = db
    .prepare(
      `SELECT * FROM asset_groups
       ORDER BY times_used ASC, COALESCE(last_used_at, '1970-01-01') ASC, id ASC`,
    )
    .all();
  for (const group of groups) {
    let assets = db
      .prepare(
        `SELECT * FROM asset_library WHERE group_id = ? ORDER BY position ASC, id ASC`,
      )
      .all(group.id)
      .map(normalizeAsset);
    // Optional tag filter (client-side).
    if (Array.isArray(tags) && tags.length > 0) {
      assets = assets.filter((asset) => tags.every((tag) => asset.tags.includes(tag)));
    }
    if (assets.length === 0) continue;
    units.push({
      kind: "group",
      group,
      assets,
      times_used: group.times_used || 0,
      last_used_at: group.last_used_at || null,
      unit_id: group.id, // for "avoid most-recently-used" comparison
    });
  }

  // 2. Ungrouped assets (each is its own single-asset unit).
  const where = buildMediaWhere(mediaType);
  const ungrouped = db
    .prepare(
      `SELECT * FROM asset_library
       WHERE group_id IS NULL AND ${where.sql}
       ORDER BY times_used ASC, COALESCE(last_used_at, '1970-01-01') ASC, id ASC`,
    )
    .all(where.params)
    .map(normalizeAsset);
  let filtered = ungrouped;
  if (Array.isArray(tags) && tags.length > 0) {
    filtered = ungrouped.filter((asset) => tags.every((tag) => asset.tags.includes(tag)));
  }
  for (const asset of filtered) {
    units.push({
      kind: "single",
      asset,
      assets: [asset],
      times_used: asset.times_used || 0,
      last_used_at: asset.last_used_at || null,
      unit_id: asset.id,
    });
  }

  if (units.length === 0) return null;

  // ── Pick the least-used unit (sequential queue behaviour) ──────────────
  const lowestUseCount = Math.min(...units.map((u) => u.times_used || 0));
  let leastUsed = units.filter((u) => (u.times_used || 0) === lowestUseCount);

  // Sort by last_used_at ASC (oldest first), then by unit_id ASC for
  // deterministic ordering.
  leastUsed.sort((a, b) => {
    const aTime = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
    const bTime = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
    if (aTime !== bTime) return aTime - bTime;
    return a.unit_id - b.unit_id;
  });

  // Avoid the most-recently-used unit if possible. We look at the most
  // recent asset_usage_log row and skip the unit that contains that asset.
  const lastUsed = db
    .prepare("SELECT asset_id FROM asset_usage_log ORDER BY used_at DESC, id DESC LIMIT 1")
    .get();
  let chosen = leastUsed[0];
  if (lastUsed && leastUsed.length > 1) {
    const avoid = leastUsed.find((u) => {
      // For single-asset units, the unit_id IS the asset id.
      if (u.kind === "single") return u.unit_id === lastUsed.asset_id;
      // For group units, check if the last-used asset is in this group.
      const inGroup = db
        .prepare("SELECT 1 FROM asset_library WHERE id = ? AND group_id = ?")
        .get(lastUsed.asset_id, u.unit_id);
      return Boolean(inGroup);
    });
    // If the first unit (leastUsed[0]) is the one we want to avoid, pick
    // the next one. Otherwise keep leastUsed[0].
    if (avoid && avoid.unit_id === leastUsed[0].unit_id) {
      chosen = leastUsed[1] || leastUsed[0];
    }
  }

  // Log the selection for audit purposes.
  if (chosen.kind === "group") {
    logActivity({
      activityType: "asset_used",
      entityType: "asset_group",
      entityId: chosen.group.id,
      status: "selected",
      summary: `Selected asset group for rotation: ${chosen.group.name}`,
      details: {
        postType: chosen.group.post_type,
        assetCount: chosen.assets.length,
      },
    });
  } else {
    logActivity({
      activityType: "asset_used",
      entityType: "asset",
      entityId: chosen.asset.id,
      status: "selected",
      summary: `Selected library asset for rotation: ${chosen.asset.name}`,
      details: { mediaType, fileUrl: chosen.asset.file_url },
    });
  }

  return chosen;
}

module.exports = {
  pickNextAsset,
  pickNextAssetGroup,
  pickNextAssetOrGroup,
  markAssetUsed,
  markAssetGroupUsed,
};
