/**
 * backgroundJobs/cleanupArtifacts.js
 *
 * Cron-triggered cleanup for debug / automation artifacts. These piles
 * up fast during posting, discovery, and failure screenshots:
 *   - artifacts/automation/   (failure screenshots, DOM dumps, facebook-debug)
 *   - artifacts/dom-captures/ (manual + automatic DOM recorder captures)
 *   - artifacts/gemini-images/ (raw Gemini image-gen intermediates)
 *
 * Paths come from env when the desktop launcher is running
 * (AUTOMATION_ARTIFACTS_DIR / DOM_CAPTURE_DIR / GEMINI_IMAGE_SAVE_DIR),
 * with sensible project-local fallbacks for standalone `npm start`.
 *
 * Default retention: 7 days (override with ARTIFACTS_RETENTION_DAYS).
 * Only files older than the cutoff are removed; empty subdirectories
 * left behind are pruned. Never touches uploads/ or the asset library.
 */

const fs = require("fs");
const path = require("path");
const logger = require("../../utils/logger");

const DEFAULT_RETENTION_DAYS = 7;

/**
 * @param {{ force?: boolean, retentionDays?: number }} [opts]
 * @returns {number} milliseconds; 0 when force (delete everything eligible)
 */
function retentionMs(opts = {}) {
  if (opts.force) return 0;
  if (opts.retentionDays !== undefined) {
    const days = Number(opts.retentionDays);
    if (Number.isFinite(days) && days >= 0) return days * 24 * 60 * 60 * 1000;
  }
  const days = Number(process.env.ARTIFACTS_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
  // Allow 0 via env for "delete everything"; invalid values fall back to default.
  if (Number.isFinite(days) && days >= 0) return days * 24 * 60 * 60 * 1000;
  return DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

function projectRoot() {
  // src/jobs/backgroundJobs → ../../../ = gtss-growth-engine/
  return path.resolve(__dirname, "..", "..", "..");
}

/**
 * Collect the artifact roots that should be swept. Dedupes by absolute
 * path so overlapping env defaults don't get processed twice.
 */
function resolveArtifactRoots() {
  const root = projectRoot();
  const candidates = [
    process.env.AUTOMATION_ARTIFACTS_DIR,
    process.env.DOM_CAPTURE_DIR,
    process.env.GEMINI_IMAGE_SAVE_DIR,
    path.join(root, "artifacts", "automation"),
    path.join(root, "artifacts", "dom-captures"),
    path.join(root, "artifacts", "gemini-images"),
    path.join(root, "artifacts"),
  ].filter(Boolean);

  const seen = new Set();
  const roots = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (fs.existsSync(resolved)) roots.push(resolved);
  }
  return roots;
}

/**
 * Recursively walk a directory and delete files older than cutoff.
 * Returns { deletedFiles, deletedBytes, prunedDirs }.
 */
function sweepDir(dir, cutoffMs, stats) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    logger.debug("SERVER", `Artifact cleanup skip (unreadable): ${dir} (${err.message})`);
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        sweepDir(full, cutoffMs, stats);
        // Prune empty directories after children are cleaned.
        try {
          const remaining = fs.readdirSync(full);
          if (remaining.length === 0) {
            fs.rmdirSync(full);
            stats.prunedDirs += 1;
          }
        } catch (_) {
          /* ignore */
        }
        continue;
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) continue;

      const st = fs.statSync(full);
      if (st.mtimeMs >= cutoffMs) continue;

      fs.unlinkSync(full);
      stats.deletedFiles += 1;
      stats.deletedBytes += st.size || 0;
    } catch (err) {
      logger.debug(
        "SERVER",
        `Artifact cleanup could not remove ${full}: ${err.message}`,
      );
    }
  }
}

/**
 * Delete artifact files older than ARTIFACTS_RETENTION_DAYS (default 7).
 * Safe to call repeatedly; best-effort per file.
 *
 * @param {{ force?: boolean, retentionDays?: number }} [opts]
 *   force=true → ignore age retention (delete all files under artifact roots).
 * @returns {{ deletedFiles: number, deletedBytes: number, prunedDirs: number, roots: string[], force: boolean }}
 */
function cleanupArtifacts(opts = {}) {
  const force = Boolean(opts.force);
  const cutoffMs = Date.now() - retentionMs(opts);
  const roots = resolveArtifactRoots();
  const stats = {
    deletedFiles: 0,
    deletedBytes: 0,
    prunedDirs: 0,
    roots,
    force,
  };

  if (roots.length === 0) {
    logger.debug("SERVER", "Artifact cleanup: no artifact directories found");
    return stats;
  }

  for (const root of roots) {
    // If we include the parent `artifacts/` root AND its children in the
    // list, sweeping the parent already covers children. Skip a root that
    // is nested under another root we already plan to sweep.
    const nestedUnderOther = roots.some(
      (other) =>
        other !== root &&
        (root === other || root.startsWith(`${other}${path.sep}`)),
    );
    if (nestedUnderOther) continue;

    sweepDir(root, cutoffMs, stats);
  }

  const mb = (stats.deletedBytes / (1024 * 1024)).toFixed(2);
  logger.info(
    "SERVER",
    `Artifact cleanup finished${force ? " (force)" : ""}: deleted ${stats.deletedFiles} file(s) (${mb} MB), pruned ${stats.prunedDirs} empty dir(s) across ${roots.length} root(s)`,
  );

  return stats;
}

module.exports = { cleanupArtifacts, resolveArtifactRoots, retentionMs };
