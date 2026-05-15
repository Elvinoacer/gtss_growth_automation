require("dotenv").config();

const { initReplyChecker } = require("./replyChecker");
const { initScheduledPoster } = require("./scheduledPoster");
const { stopAllJobs } = require("../automation/executor");
const { closeAllBrowsers } = require("../automation/browserBase");
const logger = require("../utils/logger");

let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn(
    "SERVER",
    `Background automation worker received ${signal}. Shutting down.`,
  );

  try {
    stopAllJobs();
    await closeAllBrowsers();
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

function startBackgroundJobs() {
  logger.info("SERVER", "Background automation worker initializing.");
  initReplyChecker();
  initScheduledPoster();

  // Cleanup orphan uploads (older than 7 days) at 3 AM daily
  const cron = require('node-cron');
  const fs = require('fs');
  const path = require('path');
  cron.schedule('0 3 * * *', () => {
    const dir = path.join(__dirname, '../../public/uploads');
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    fs.readdirSync(dir).forEach((f) => {
      const fp = path.join(dir, f);
      try {
        const stats = fs.statSync(fp);
        if (stats.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          logger.info('SERVER', `Cleaned up orphan upload: ${f}`);
        }
      } catch (e) { /* ignore */ }
    });
  });

  logger.info("SERVER", "Background automation worker initialized.");
}

if (require.main === module && process.env.DISABLE_BACKGROUND_JOBS !== "true") {
  startBackgroundJobs();
}

process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

module.exports = {
  startBackgroundJobs,
};
