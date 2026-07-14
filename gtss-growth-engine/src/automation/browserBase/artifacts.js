/**
 * Browser Base — Failure Artifacts & Tracing
 * getArtifactsDir, getLocksDir, safeName, artifactPath, lockPath,
 * captureFailureArtifact, captureFailureSnapshot, startTracing — file-system
 * helpers for persisting screenshots, HTML snapshots, and Playwright traces
 * when an automation run fails. All functions are best-effort and never
 * throw, so a screenshot failure can never mask the original automation
 * outcome.
 * Extracted from the original browserBase.js for maintainability.
 */

const fs = require("fs");
const path = require("path");
const logger = require("../../utils/logger");

function getArtifactsDir() {
  const configured = path.resolve(
    process.env.AUTOMATION_ARTIFACTS_DIR || "./artifacts/automation",
  );
  // Try the configured dir first; if it can't be created (e.g. user pointed
  // it at /var/log/... without root), fall back to ./artifacts/automation
  // under the process cwd. NEVER throw — this is called from many failure
  // paths (captureFailureArtifact) where an exception would mask the
  // original automation outcome and could abort the whole run.
  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (err) {
    logger.warn("BROWSER", `Configured AUTOMATION_ARTIFACTS_DIR unwritable: ${configured} (${err.message}); falling back to ./artifacts/automation`);
  }
  const fallback = path.resolve(process.cwd(), "artifacts", "automation");
  try {
    fs.mkdirSync(fallback, { recursive: true });
  } catch (err) {
    logger.warn("BROWSER", `Fallback artifacts dir unwritable: ${fallback} (${err.message})`);
  }
  return fallback;
}

function getLocksDir() {
  const dir = path.resolve(
    process.env.AUTOMATION_LOCKS_DIR || "./data/browser-locks",
  );
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    logger.warn("BROWSER", `Locks dir unwritable: ${dir} (${err.message})`);
  }
  return dir;
}

function safeName(value) {
  return String(value || "artifact")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function artifactPath(platform, label, extension) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    getArtifactsDir(),
    `${timestamp}-${safeName(platform)}-${safeName(label)}.${extension}`,
  );
}

function lockPath(platform, mode, target) {
  return path.join(
    getLocksDir(),
    `${safeName(platform)}-${safeName(mode)}-${safeName(target)}.lock`,
  );
}

async function captureFailureArtifact(page, platform, label) {
  if (!page || page.isClosed()) return null;
  // Resolve the path inside a try/catch — getArtifactsDir() is hardened but
  // this is the last-mile defense so a screenshot failure can never mask
  // the original automation outcome.
  let filePath;
  try {
    filePath = artifactPath(platform, label, "png");
  } catch (err) {
    logger.warn("BROWSER", `Could not resolve artifact path: ${err.message}`);
    return null;
  }
  try {
    await page.screenshot({ path: filePath, fullPage: true });
    logger.info("BROWSER", "Captured failure screenshot", {
      platform,
      filePath,
    });
    return filePath;
  } catch (error) {
    logger.warn("BROWSER", "Failed to capture failure screenshot", {
      platform,
      error: error.message,
    });
    return null;
  }
}

async function captureFailureSnapshot(page, platform, label) {
  if (!page || page.isClosed()) return {};

  const screenshotPath = await captureFailureArtifact(page, platform, label);
  let htmlPath = null;

  try {
    htmlPath = artifactPath(platform, `${label}-html`, "html");
    fs.writeFileSync(htmlPath, await page.content(), "utf8");
    logger.info("BROWSER", "Captured failure HTML", {
      platform,
      filePath: htmlPath,
    });
  } catch (error) {
    logger.warn("BROWSER", "Failed to capture failure HTML", {
      platform,
      error: error.message,
    });
  }

  return { screenshotPath, htmlPath };
}

async function startTracing(context, platform, options = {}) {
  if (options.trace === false || process.env.PLAYWRIGHT_TRACE === "false")
    return null;
  try {
    await context.tracing.start({ screenshots: true, snapshots: true });
    return artifactPath(platform, "trace", "zip");
  } catch (error) {
    logger.warn("BROWSER", "Failed to start Playwright tracing", {
      platform,
      error: error.message,
    });
    return null;
  }
}

module.exports = {
  getArtifactsDir,
  getLocksDir,
  safeName,
  artifactPath,
  lockPath,
  captureFailureArtifact,
  captureFailureSnapshot,
  startTracing,
};
