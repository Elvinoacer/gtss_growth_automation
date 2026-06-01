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

module.exports = {
  pickNextAsset,
  markAssetUsed,
};
