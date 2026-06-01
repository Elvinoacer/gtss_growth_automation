const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const { getDb } = require("../db/database");
const { pickNextAsset } = require("../services/assetRotationService");

const router = express.Router();
const uploadDir = path.resolve(__dirname, "../../public/uploads/library");
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
  return row ? { ...row, tags: parseArray(row.tags) } : null;
}

router.get("/", (req, res) => {
  const where = [];
  const params = {};
  if (req.query.media_type && req.query.media_type !== "both") {
    where.push("media_type = @mediaType");
    params.mediaType = String(req.query.media_type);
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
  const insert = db.prepare(
    `INSERT INTO asset_library
      (name, file_path, file_url, media_type, mime_type, size_bytes, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const assets = (req.files || []).map((file) => {
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
    );
    return normalize(db.prepare("SELECT * FROM asset_library WHERE id = ?").get(result.lastInsertRowid));
  });

  res.status(201).json({ assets });
});

router.patch("/:id", (req, res) => {
  const db = getDb();
  const asset = db.prepare("SELECT * FROM asset_library WHERE id = ?").get(req.params.id);
  if (!asset) return res.status(404).json({ error: "Asset not found" });

  const name = req.body.name !== undefined ? String(req.body.name).trim() : asset.name;
  const tags = Array.isArray(req.body.tags)
    ? req.body.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : parseArray(asset.tags);

  db.prepare(
    "UPDATE asset_library SET name = ?, tags = ? WHERE id = ?",
  ).run(name || asset.name, JSON.stringify(tags), asset.id);
  res.json({ asset: normalize(db.prepare("SELECT * FROM asset_library WHERE id = ?").get(asset.id)) });
});

router.delete("/:id", (req, res) => {
  const db = getDb();
  const asset = db.prepare("SELECT * FROM asset_library WHERE id = ?").get(req.params.id);
  if (!asset) return res.status(404).json({ error: "Asset not found" });
  db.prepare("DELETE FROM asset_usage_log WHERE asset_id = ?").run(asset.id);
  db.prepare("DELETE FROM asset_library WHERE id = ?").run(asset.id);
  fs.promises.unlink(asset.file_path).catch(() => {});
  res.json({ deleted: true });
});

router.get("/stats", (_req, res) => {
  const db = getDb();
  const counts = db
    .prepare("SELECT media_type, COUNT(*) AS count FROM asset_library GROUP BY media_type")
    .all();
  const next = pickNextAsset({ mediaType: "both" });
  res.json({
    counts,
    total: counts.reduce((sum, row) => sum + row.count, 0),
    next,
  });
});

module.exports = router;
