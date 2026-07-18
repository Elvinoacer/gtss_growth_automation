/**
 * Maintenance routes — run cleanup jobs on demand (same work as the
 * nightly crons, but immediately).
 *
 *   POST /api/maintenance/cleanup
 *     Body (optional):
 *       { targets?: ['artifacts' | 'orphan_uploads'], force?: boolean }
 *     Defaults to both targets. force=true ignores age retention.
 *
 *   POST /api/maintenance/cleanup-artifacts
 *   POST /api/maintenance/cleanup-orphan-uploads
 *
 * These call the same functions the 3:00 / 3:30 AM crons use, so
 * behaviour stays consistent whether the job is scheduled or manual.
 */

const express = require("express");
const { asyncHandler } = require("../utils/errorHandlers");
const logger = require("../utils/logger");
const {
  cleanupArtifacts,
} = require("../jobs/backgroundJobs/cleanupArtifacts");
const {
  cleanupOrphanUploads,
} = require("../jobs/backgroundJobs/cleanupOrphanUploads");

const router = express.Router();

const VALID_TARGETS = new Set(["artifacts", "orphan_uploads"]);

function parseTargets(body) {
  if (!body || body.targets == null) {
    return ["artifacts", "orphan_uploads"];
  }
  const raw = Array.isArray(body.targets) ? body.targets : [body.targets];
  const targets = raw
    .map((t) => String(t || "").trim())
    .filter((t) => VALID_TARGETS.has(t));
  if (targets.length === 0) {
    const err = new Error(
      `targets must include one of: ${[...VALID_TARGETS].join(", ")}`,
    );
    err.status = 400;
    throw err;
  }
  return targets;
}

function runCleanup(targets, { force = false } = {}) {
  const result = {
    triggeredAt: new Date().toISOString(),
    force: Boolean(force),
    artifacts: null,
    orphan_uploads: null,
  };

  if (targets.includes("artifacts")) {
    result.artifacts = cleanupArtifacts({ force: Boolean(force) });
  }

  if (targets.includes("orphan_uploads")) {
    result.orphan_uploads = cleanupOrphanUploads({ force: Boolean(force) });
  }

  return result;
}

router.post(
  "/cleanup",
  asyncHandler(async (req, res) => {
    const targets = parseTargets(req.body);
    const force = Boolean(req.body?.force);
    logger.info(
      "SERVER",
      `Manual maintenance cleanup triggered (targets=${targets.join(",")}, force=${force})`,
    );
    const result = runCleanup(targets, { force });
    res.json({ ok: true, ...result });
  }),
);

router.post(
  "/cleanup-artifacts",
  asyncHandler(async (req, res) => {
    const force = Boolean(req.body?.force);
    logger.info(
      "SERVER",
      `Manual artifact cleanup triggered (force=${force})`,
    );
    const result = runCleanup(["artifacts"], { force });
    res.json({ ok: true, ...result });
  }),
);

router.post(
  "/cleanup-orphan-uploads",
  asyncHandler(async (req, res) => {
    const force = Boolean(req.body?.force);
    logger.info(
      "SERVER",
      `Manual orphan-upload cleanup triggered (force=${force})`,
    );
    const result = runCleanup(["orphan_uploads"], { force });
    res.json({ ok: true, ...result });
  }),
);

module.exports = router;
