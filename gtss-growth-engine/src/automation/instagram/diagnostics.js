/**
 * Instagram Diagnostics
 * Debug-directory setup, DOM snapshot capture, action-log append, and the
 * traceInstagramAction wrapper that records before/success/error states for
 * each automation step.
 * Extracted from the original instagram.js for maintainability.
 */

const fs = require("fs");
const path = require("path");

const logger = require("../../utils/logger");
const { INSTAGRAM_DEBUG_RUN_ID } = require("./constants");

function getInstagramDebugDir() {
  const configured = path.resolve(
    process.env.AUTOMATION_ARTIFACTS_DIR || "./artifacts/automation",
    "instagram-debug",
  );
  // Try the configured dir; if it can't be created (e.g. user pointed
  // AUTOMATION_ARTIFACTS_DIR at /var/log/... without root), fall back to
  // ./artifacts/automation/instagram-debug under the process cwd. NEVER
  // throw — getInstagramDebugPath() is called outside try/catch in several
  // places, and a throw here would mask the original automation outcome.
  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (_) {}
  const fallback = path.resolve(
    process.cwd(),
    "artifacts",
    "automation",
    "instagram-debug",
  );
  try {
    fs.mkdirSync(fallback, { recursive: true });
  } catch (_) {}
  return fallback;
}

function getInstagramDebugPath(label, extension) {
  const safeLabel = String(label || "step")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return path.join(
    getInstagramDebugDir(),
    `${INSTAGRAM_DEBUG_RUN_ID}-${safeLabel}.${extension}`,
  );
}

async function captureInstagramDomSnapshot(page, label) {
  if (
    !page ||
    (typeof page.isClosed === "function" && page.isClosed())
  ) {
    return null;
  }
  if (typeof page.content !== "function") return null;

  const htmlPath = getInstagramDebugPath(label, "html");
  const metaPath = getInstagramDebugPath(label, "json");
  const payload = {
    label,
    capturedAt: new Date().toISOString(),
    url: page.url(),
    htmlPath,
  };

  try {
    fs.writeFileSync(htmlPath, await page.content(), "utf8");
    fs.writeFileSync(metaPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    logger.info("INSTAGRAM_TRACE", "Captured DOM snapshot", payload);
    return payload;
  } catch (error) {
    logger.warn("INSTAGRAM_TRACE", "Failed to capture DOM snapshot", {
      label,
      error: error.message,
    });
    return null;
  }
}

function appendInstagramActionLog(entry) {
  const logPath = getInstagramDebugPath("actions", "jsonl");
  fs.appendFileSync(
    logPath,
    `${JSON.stringify({
      runId: INSTAGRAM_DEBUG_RUN_ID,
      timestamp: new Date().toISOString(),
      ...entry,
    })}\n`,
    "utf8",
  );
  return logPath;
}

async function traceInstagramAction(page, action, fn, emitter, details = {}) {
  const beforeSnapshot = await captureInstagramDomSnapshot(
    page,
    `${action}-before`,
  );
  appendInstagramActionLog({
    action,
    status: "start",
    url: page && typeof page.url === "function" ? page.url() : null,
    details,
    beforeSnapshot,
  });

  try {
    const result = await fn();
    appendInstagramActionLog({
      action,
      status: "success",
      url: page && typeof page.url === "function" ? page.url() : null,
      details,
    });
    return result;
  } catch (error) {
    const errorSnapshot = await captureInstagramDomSnapshot(
      page,
      `${action}-error`,
    );
    appendInstagramActionLog({
      action,
      status: "error",
      url: page && typeof page.url === "function" ? page.url() : null,
      details,
      error: {
        message: error.message,
        stack: error.stack,
      },
      errorSnapshot,
    });
    logger.error("INSTAGRAM_TRACE", `Action failed: ${action}`, {
      error: error.message,
      url: page && typeof page.url === "function" ? page.url() : null,
    });
    if (typeof emitter === "function") {
      try {
        emitter(
          "error",
          `Instagram action failed: ${action} - ${error.message}`,
        );
      } catch (_) {}
    } else if (emitter && typeof emitter.emit === "function") {
      try {
        emitter.emit(
          "error",
          `Instagram action failed: ${action} - ${error.message}`,
        );
      } catch (_) {}
    }
    throw error;
  }
}

module.exports = {
  getInstagramDebugDir,
  getInstagramDebugPath,
  captureInstagramDomSnapshot,
  appendInstagramActionLog,
  traceInstagramAction,
};
