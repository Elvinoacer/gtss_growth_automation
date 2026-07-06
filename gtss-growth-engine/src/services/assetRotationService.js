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

module.exports = {
  pickNextAsset,
  pickNextAssetGroup,
  markAssetUsed,
  markAssetGroupUsed,
};
