/**
 * Browser Base — Browser Profile Locks
 * isPidRunning, readLock, acquireBrowserLock, releaseBrowserLock,
 * releaseLockOnClose — file-system lock primitives that prevent two
 * automation runs from sharing the same browser profile (or CDP endpoint)
 * at the same time. Stale locks left by dead processes are reclaimed
 * automatically.
 * Extracted from the original browserBase.js for maintainability.
 */

const fs = require("fs");
const logger = require("../../utils/logger");
const { lockPath } = require("./artifacts");

function isPidRunning(pid) {
  if (!pid || Number.isNaN(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readLock(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return null;
  }
}

function acquireBrowserLock(platform, mode, target) {
  const filePath = lockPath(platform, mode, target);
  const payload = {
    pid: process.pid,
    platform,
    mode,
    target,
    createdAt: new Date().toISOString(),
  };

  try {
    const fd = fs.openSync(filePath, "wx");
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
    fs.closeSync(fd);
    return { filePath };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;

    const existing = readLock(filePath);
    if (existing && !isPidRunning(existing.pid)) {
      logger.warn("BROWSER", "Removing stale browser lock", {
        platform,
        mode,
        filePath,
        pid: existing.pid,
      });
      fs.unlinkSync(filePath);
      return acquireBrowserLock(platform, mode, target);
    }

    throw new Error(
      `Browser profile is already in use for ${platform} (${mode}). ` +
        `Stop the active run or remove stale lock ${filePath}.`,
    );
  }
}

function releaseBrowserLock(lock) {
  if (!lock || !lock.filePath) return;
  try {
    const existing = readLock(lock.filePath);
    if (!existing || existing.pid === process.pid) {
      fs.unlinkSync(lock.filePath);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn("BROWSER", "Failed to release browser lock", {
        filePath: lock.filePath,
        error: error.message,
      });
    }
  }
}

function releaseLockOnClose(browser, context, lock) {
  if (!lock) return;
  if (context && typeof context.once === "function") {
    context.once("close", () => releaseBrowserLock(lock));
  }
  if (browser && typeof browser.once === "function") {
    browser.once("disconnected", () => releaseBrowserLock(lock));
  }
}

module.exports = {
  isPidRunning,
  readLock,
  acquireBrowserLock,
  releaseBrowserLock,
  releaseLockOnClose,
};
