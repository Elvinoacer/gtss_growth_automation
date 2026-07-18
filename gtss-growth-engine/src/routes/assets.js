const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const { getDb } = require("../db/database");
const { pickNextAsset, pickNextAssetGroup } = require("../services/assetRotationService");

const router = express.Router();

// Resolve the writable uploads directory. The desktop launcher sets
// UPLOADS_DIR=<userData>/public/uploads (writable); in standalone dev mode
// (running `npm start` inside gtss-growth-engine/), UPLOADS_DIR is unset
// and we fall back to the bundled <serverRoot>/public/uploads (writable
// in dev because the dev's clone is owned by them).
//
// We DO NOT use path.resolve(__dirname, "../../public/uploads/library")
// directly because when the server is bundled inside the desktop app,
// __dirname points at the read-only <resources>/server/src/routes/
// directory, and the resulting path would be inside the read-only
// <resources>/server/public/uploads/library/ — multer would fail to
// write uploaded files (EROFS).
const UPLOADS_BASE = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.resolve(__dirname, "../../public/uploads");
const uploadDir = path.join(UPLOADS_BASE, "library");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safeBase = path
      .basename(file.originalname, path.extname(file.originalname))
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    cb(null, `${Date.now()}-${safeBase || "asset"}${path.extname(file.originalname).toLowerCase()}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^(image|video)\//.test(file.mimetype || "")) cb(null, true);
    else cb(new Error("Only image and video uploads are supported"));
  },
});

function parseArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function normalize(row) {
  if (!row) return null;
  return {
    ...row,
    tags: parseArray(row.tags),
  };
}

function normalizeGroup(row) {
  if (!row) return null;
  return {
    ...row,
    label: row.label || row.name,
  };
}

// ── Asset CRUD ────────────────────────────────────────────────────────────

router.get("/", (req, res) => {
  const where = [];
  const params = {};
  if (req.query.media_type && req.query.media_type !== "both") {
    where.push("media_type = @mediaType");
    params.mediaType = String(req.query.media_type);
  }
  if (req.query.group_id) {
    where.push("group_id = @groupId");
    params.groupId = Number(req.query.group_id);
  } else if (req.query.ungrouped === "1" || req.query.ungrouped === "true") {
    where.push("group_id IS NULL");
  }
  const sql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const assets = getDb()
    .prepare(`SELECT * FROM asset_library ${sql} ORDER BY times_used ASC, created_at DESC`)
    .all(params)
    .map(normalize);
  res.json({ assets });
});

router.post("/upload", upload.array("assets", 20), (req, res) => {
  const db = getDb();
  const tags = String(req.body.tags || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  // Optional group_id + starting position — lets the user upload
  // straight into an existing group.
  const groupId = req.body.group_id ? Number(req.body.group_id) : null;
  let startPosition = 0;
  if (groupId) {
    const row = db
      .prepare("SELECT MAX(position) AS maxPos FROM asset_library WHERE group_id = ?")
      .get(groupId);
    startPosition = (row && Number.isFinite(row.maxPos) ? row.maxPos : -1) + 1;
  }
  const insert = db.prepare(
    `INSERT INTO asset_library
      (name, file_path, file_url, media_type, mime_type, size_bytes, tags, group_id, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const assets = (req.files || []).map((file, idx) => {
    const mediaType = file.mimetype.startsWith("video/") ? "video" : "image";
    const fileUrl = `/uploads/library/${file.filename}`;
    const result = insert.run(
      file.originalname,
      file.path,
      fileUrl,
      mediaType,
      file.mimetype,
      file.size,
      JSON.stringify(tags),
      groupId,
      startPosition + idx,
    );
    return normalize(db.prepare("SELECT * FROM asset_library WHERE id = ?").get(result.lastInsertRowid));
  });

  res.status(201).json({ assets });
});

/**
 * Remove one asset from the library: usage log + DB row.
 * Returns the asset row when deleted (caller should unlink file_path),
 * or null when the id was not found.
 */
function deleteAssetRow(db, assetId) {
  const asset = db.prepare("SELECT * FROM asset_library WHERE id = ?").get(assetId);
  if (!asset) return null;
  db.prepare("DELETE FROM asset_usage_log WHERE asset_id = ?").run(asset.id);
  db.prepare("DELETE FROM asset_library WHERE id = ?").run(asset.id);
  return asset;
}

/** Best-effort disk cleanup for a library asset file path. */
function unlinkAssetFile(filePath) {
  if (!filePath) return;
  fs.promises.unlink(filePath).catch(() => {});
}

// Stats + bulk-delete must be registered before /:id so Express does not
// treat "stats" / "bulk-delete" as numeric ids.
router.get("/stats", (_req, res) => {
  const db = getDb();
  const counts = db
    .prepare("SELECT media_type, COUNT(*) AS count FROM asset_library GROUP BY media_type")
    .all();
  const groupCounts = db
    .prepare("SELECT COUNT(*) AS count FROM asset_groups")
    .get();
  const next = pickNextAsset({ mediaType: "both" });
  const nextGroup = pickNextAssetGroup({ postType: "any" });
  res.json({
    counts,
    total: counts.reduce((sum, row) => sum + row.count, 0),
    groupCount: groupCounts ? groupCounts.count : 0,
    next,
    nextGroup,
  });
});

// Body: { ids: [1, 2, 3] } — permanently remove multiple library assets.
router.post("/bulk-delete", (req, res) => {
  const db = getDb();
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
    : [];
  if (ids.length === 0) {
    return res.status(400).json({ error: "Provide at least one asset id in ids[]" });
  }

  const deleted = [];
  const tx = db.transaction(() => {
    for (const id of ids) {
      const asset = deleteAssetRow(db, id);
      if (asset) deleted.push(asset);
    }
  });
  tx();

  // Unlink disk files after the DB transaction commits.
  for (const asset of deleted) {
    unlinkAssetFile(asset.file_path);
  }

  res.json({
    deleted: true,
    deletedIds: deleted.map((a) => a.id),
    count: deleted.length,
  });
});

router.patch("/:id", (req, res) => {
  const db = getDb();
  const asset = db.prepare("SELECT * FROM asset_library WHERE id = ?").get(req.params.id);
  if (!asset) return res.status(404).json({ error: "Asset not found" });

  const name = req.body.name !== undefined ? String(req.body.name).trim() : asset.name;
  const tags = Array.isArray(req.body.tags)
    ? req.body.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : parseArray(asset.tags);
  const groupId =
    req.body.group_id === null || req.body.group_id === undefined
      ? asset.group_id
      : req.body.group_id === 0 || req.body.group_id === "0" || req.body.group_id === ""
        ? null
        : Number(req.body.group_id);
  const position =
    req.body.position !== undefined ? Number(req.body.position) : asset.position;

  db.prepare(
    "UPDATE asset_library SET name = ?, tags = ?, group_id = ?, position = ? WHERE id = ?",
  ).run(name || asset.name, JSON.stringify(tags), groupId, position, asset.id);
  res.json({ asset: normalize(db.prepare("SELECT * FROM asset_library WHERE id = ?").get(asset.id)) });
});

router.delete("/:id", (req, res) => {
  const db = getDb();
  const asset = deleteAssetRow(db, req.params.id);
  if (!asset) {
    return res.status(404).json({ error: "Asset not found" });
  }
  unlinkAssetFile(asset.file_path);
  res.json({ deleted: true });
});

// ── Asset Group CRUD ──────────────────────────────────────────────────────
// Groups let the user mark which images belong together as a single post
// (carousel / multi-image / video + thumbnail) and label them.

router.get("/groups", (_req, res) => {
  const db = getDb();
  const groups = db
    .prepare("SELECT * FROM asset_groups ORDER BY times_used ASC, created_at DESC")
    .all()
    .map(normalizeGroup);
  // Attach each group's asset list, ordered by position.
  const enriched = groups.map((group) => {
    const assets = db
      .prepare("SELECT * FROM asset_library WHERE group_id = ? ORDER BY position ASC, id ASC")
      .all(group.id)
      .map(normalize);
    return { ...group, assets };
  });
  res.json({ groups: enriched });
});

router.post("/groups", (req, res) => {
  const db = getDb();
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Group name is required" });
  const label = String(req.body.label || name).trim();
  const postType = ["carousel", "video", "single"].includes(req.body.post_type)
    ? req.body.post_type
    : "carousel";
  const result = db
    .prepare(
      `INSERT INTO asset_groups (name, label, post_type) VALUES (?, ?, ?)`,
    )
    .run(name, label, postType);
  const group = normalizeGroup(
    db.prepare("SELECT * FROM asset_groups WHERE id = ?").get(result.lastInsertRowid),
  );
  res.status(201).json({ group });
});

router.patch("/groups/:id", (req, res) => {
  const db = getDb();
  const group = db.prepare("SELECT * FROM asset_groups WHERE id = ?").get(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });

  const name = req.body.name !== undefined ? String(req.body.name).trim() : group.name;
  const label = req.body.label !== undefined ? String(req.body.label).trim() : group.label;
  const postType =
    req.body.post_type !== undefined
      ? (["carousel", "video", "single"].includes(req.body.post_type) ? req.body.post_type : group.post_type)
      : group.post_type;

  db.prepare(
    "UPDATE asset_groups SET name = ?, label = ?, post_type = ? WHERE id = ?",
  ).run(name, label, postType, group.id);
  res.json({
    group: normalizeGroup(db.prepare("SELECT * FROM asset_groups WHERE id = ?").get(group.id)),
  });
});

router.delete("/groups/:id", (req, res) => {
  const db = getDb();
  const group = db.prepare("SELECT * FROM asset_groups WHERE id = ?").get(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });
  // Unlink assets (don't delete them) so the user can re-group them later.
  db.prepare("UPDATE asset_library SET group_id = NULL, position = 0 WHERE group_id = ?").run(group.id);
  db.prepare("DELETE FROM asset_groups WHERE id = ?").run(group.id);
  res.json({ deleted: true });
});

// Bulk-assign a set of asset ids to a group, in the given order.
// Body: { assetIds: [1, 2, 3], groupId: 5 }
// If groupId is null/0, the assets are unassigned from any group.
router.post("/groups/:id/assets", (req, res) => {
  const db = getDb();
  const groupId = Number(req.params.id);
  const group = db.prepare("SELECT * FROM asset_groups WHERE id = ?").get(groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const assetIds = Array.isArray(req.body.assetIds)
    ? req.body.assetIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
    : [];

  const tx = db.transaction(() => {
    // First, clear any existing membership of these assets (in case they
    // were in another group). Then assign them to this group with new
    // positions in the order the client sent.
    for (const id of assetIds) {
      db.prepare("UPDATE asset_library SET group_id = NULL WHERE id = ?").run(id);
    }
    assetIds.forEach((id, idx) => {
      db.prepare("UPDATE asset_library SET group_id = ?, position = ? WHERE id = ?").run(
        groupId,
        idx,
        id,
      );
    });
  });
  tx();
  const assets = db
    .prepare("SELECT * FROM asset_library WHERE group_id = ? ORDER BY position ASC, id ASC")
    .all(groupId)
    .map(normalize);
  res.json({ group: normalizeGroup(group), assets });
});

module.exports = router;
