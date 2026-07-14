/**
 * backgroundJobs/gracefulShutdown.js
 *
 * Signal-handler-driven shutdown for the background-jobs worker.
 * Latched via state.shuttingDown so a second SIGINT during a slow
 * shutdown (e.g. browser close taking 5+ seconds) doesn't double-fire
 * process.exit().
 *
 * Flow: stopAllJobs() (interrupts the action-queue executor's current
 * sleep) → browserBase.closeAllBrowsers() (closes every Playwright
 * context the worker opened) → process.exit(0). On any error,
 * process.exit(1) so the supervisor (systemd / pm2 / electron) restarts
 * us cleanly.
 */

const { stopAllJobs } = require("../../automation/executor");
const browserBase = require("../../automation/browserBase");
const logger = require("../../utils/logger");
const { state } = require("./state");

/**
 * Graceful shutdown handler. Idempotent via the state.shuttingDown latch.
 *
 * @param {string} signal - 'SIGINT' | 'SIGTERM' | 'SIGHUP' etc.
 */
async function gracefulShutdown(signal) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  logger.warn(
    "SERVER",
    `Background automation worker received ${signal}. Shutting down.`,
  );

  try {
    stopAllJobs();
    await browserBase.closeAllBrowsers();
    logger.info("SERVER", "Background automation worker shutdown complete.");
    process.exit(0);
  } catch (error) {
    logger.error(
      "SERVER",
      "Background automation worker shutdown failed",
      error,
    );
    process.exit(1);
  }
}

module.exports = { gracefulShutdown };
