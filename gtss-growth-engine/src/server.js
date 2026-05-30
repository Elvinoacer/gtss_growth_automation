require("dotenv").config();

const { fork } = require("child_process");
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const { getDb, initializeDatabase } = require("./db/database");
const authMiddleware = require("./utils/authMiddleware");
const logger = require("./utils/logger");
const { sanitizeRequestBody } = require("./utils/validation");
const { notFoundHandler, errorHandler } = require("./utils/errorHandlers");
const { stopAllJobs } = require("./automation/executor");
const { closeAllBrowsers } = require("./automation/browserBase");
const { initSocketIO } = require("./services/socketService");
const { getContext } = require("./services/contextService");
const packageJson = require("../package.json");

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const BACKGROUND_JOBS_WORKER = path.join(
  __dirname,
  "jobs",
  "backgroundJobs.js",
);

let backgroundJobsProcess = null;

/**
 * Perform startup checks as requested.
 */
function performStartupChecks() {
  const dbPath = process.env.DB_PATH || "./data/gtss.db";
  const sessionDir = path.resolve(process.env.SESSION_DIR || "./sessions");
  const mediaDir = path.resolve("./media");
  const uploadsDir = path.resolve("./public/uploads");

  // 1. Check DB file readability/writability
  try {
    const resolvedDbPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
    // Try to open/create
    const fd = fs.openSync(resolvedDbPath, "a+");
    fs.closeSync(fd);
    fs.accessSync(resolvedDbPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    console.error(
      `STARTUP ERROR: Database file is not accessible at ${dbPath}: ${error.message}`,
    );
    process.exit(1);
  }

  // 2. Check ENCRYPTION_KEY
  if (!process.env.ENCRYPTION_KEY) {
    console.error(
      "STARTUP ERROR: ENCRYPTION_KEY is missing from environment variables (.env)",
    );
    process.exit(1);
  }

  // 3. Check/Create sessions directory
  if (!fs.existsSync(sessionDir)) {
    logger.info("SERVER", `Creating sessions directory: ${sessionDir}`);
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  // 4. Check/Create media & uploads directory
  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
}

const { startBackgroundJobs } = require("./jobs/backgroundJobs");

function startBackgroundJobsWorker() {
  if (
    process.env.NODE_ENV === "test" ||
    process.env.DISABLE_BACKGROUND_JOBS === "true"
  ) {
    logger.info("SERVER", "Background automation jobs disabled.");
    return null;
  }

  startBackgroundJobs().catch((error) => {
    logger.error("SERVER", "Background automation worker failed to start", error);
  }); // Run inline, no fork

  logger.info("SERVER", "Background automation worker started inline");

  return null;
}

// Run checks before everything else
performStartupChecks();
initializeDatabase();
getDb();

// Middlewares
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(sanitizeRequestBody);
app.use(
  session({
    secret: process.env.SESSION_SECRET || "gtss-growth-engine-secret-2026",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  }),
);

app.use(express.static(PUBLIC_DIR));

// Public Routes
app.use("/", require("./routes/auth"));

// Protected API Routes
app.use("/api", require("./routes/api"));
app.use("/api/settings", require("./routes/settings").apiRouter);
app.use("/api/context", require("./routes/context"));
app.use("/api/discovery", require("./routes/discovery"));
app.use("/api/campaigns", require("./routes/campaigns"));
app.use("/api/pipelines", authMiddleware, require("./routes/pipelines"));

// Protected Page Routes (wrapped in auth)
app.use(authMiddleware);
app.use("/", require("./routes/qualification"));
app.use("/discovery", require("./routes/discovery"));
app.use("/", require("./routes/messages"));
app.use("/", require("./routes/automation"));
app.use("/", require("./routes/crm"));
app.use("/", require("./routes/scheduler"));
app.use("/", require("./routes/home"));
app.use("/settings", require("./routes/settings")); // This is the pageRouter
app.use("/", require("./routes/campaigns").pageRouter);
app.use("/", require("./routes/instagram"));
app.use("/", require("./routes/pipelinesPage"));

// Global Error Handlers
app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(PORT, () => {
  logger.info(
    "SERVER",
    `${getContext().ctx_biz_name} Growth Engine v${packageJson.version} started on http://localhost:${PORT}`,
  );

  // Initialize Socket.IO on the HTTP server
  initSocketIO(server);

  backgroundJobsProcess = startBackgroundJobsWorker();
});

let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn("SERVER", `Received ${signal}. Shutting down gracefully.`);

  if (backgroundJobsProcess) {
    backgroundJobsProcess.kill("SIGTERM");
    backgroundJobsProcess = null;
  }

  server.close(async () => {
    try {
      stopAllJobs();
      await closeAllBrowsers();
      logger.info("SERVER", "Shutdown cleanup complete.");
      process.exit(0);
    } catch (error) {
      logger.error("SERVER", "Shutdown cleanup failed", error);
      process.exit(1);
    }
  });

  setTimeout(
    () => {
      logger.error("SERVER", "Forced shutdown after timeout.");
      process.exit(1);
    },
    Number(process.env.SHUTDOWN_TIMEOUT_MS || 30000),
  ).unref();
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

module.exports = app;
module.exports.server = server;
module.exports.gracefulShutdown = gracefulShutdown;
