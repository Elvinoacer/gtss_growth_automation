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

// STATIC frontend files (HTML/CSS/JS, pages, partials) live in the bundled
// <serverRoot>/public/ directory. This is read-only when packaged — that's
// fine, we only READ from it via express.static.
const PUBLIC_DIR = path.join(__dirname, "..", "public");

// WRITABLE paths for user-uploaded files and generated media. These MUST
// point into the writable userData dir (set by the desktop launcher via
// env vars), NOT into the bundled <serverRoot>/ — which is read-only on
// Linux (.deb installs to /opt/) and macOS (.app bundle).
//
// When running the server standalone (i.e., `npm start` inside
// gtss-growth-engine/), the env vars are typically unset and we fall back
// to the legacy relative paths, which resolve to <cwd>/public/uploads and
// <cwd>/media — writable in development.
const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.resolve(__dirname, "../../public/uploads");
const MEDIA_DIR = process.env.MEDIA_DIR
  ? path.resolve(process.env.MEDIA_DIR)
  : path.resolve("./media");

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

  // 4. Check/Create media & uploads directory — these MUST be writable.
  // The desktop launcher sets UPLOADS_DIR / MEDIA_DIR env vars to point at
  // the writable userData dir; if they're unset (dev mode), we fall back
  // to the legacy relative paths. Either way, we create the dir if it
  // doesn't yet exist.
  if (!fs.existsSync(MEDIA_DIR)) {
    logger.info("SERVER", `Creating media directory: ${MEDIA_DIR}`);
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
  }
  if (!fs.existsSync(UPLOADS_DIR)) {
    logger.info("SERVER", `Creating uploads directory: ${UPLOADS_DIR}`);
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
  // Sanity-check that the uploads dir is actually writable — if the env
  // var pointed at a read-only location (the classic bug when the desktop
  // launcher didn't set UPLOADS_DIR and the server's cwd was the read-only
  // <resources>/server/), the server would crash later when multer tried
  // to write uploaded files. Fail fast with a clear error instead.
  try {
    const probe = path.join(UPLOADS_DIR, `.gtss-write-probe-${Date.now()}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
  } catch (error) {
    console.error(
      `STARTUP ERROR: Uploads directory is not writable at ${UPLOADS_DIR}: ${error.message}. ` +
        `Set UPLOADS_DIR to a writable path (the desktop launcher does this automatically).`,
    );
    process.exit(1);
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
    logger.error(
      "SERVER",
      "Background automation worker failed to start",
      error,
    );
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

// Serve uploaded files (user-uploaded media, asset library, scheduler
// previews) from the WRITABLE UPLOADS_DIR. The bundled PUBLIC_DIR is
// read-only when packaged, so uploaded files live in the userData dir
// (set via the UPLOADS_DIR env var by the desktop launcher). We mount
// /uploads/ separately so requests for /uploads/library/foo.jpg resolve
// to ${UPLOADS_DIR}/library/foo.jpg (NOT ${PUBLIC_DIR}/uploads/library/...).
//
// This MUST be registered BEFORE the catch-all page routes (which mount
// after the authMiddleware below) so it isn't shadowed by them.
app.use(
  "/uploads",
  express.static(UPLOADS_DIR, {
    fallthrough: true,
    setHeaders: (res) => {
      // Uploaded media is typically cached briefly by the browser.
      res.setHeader("Cache-Control", "private, max-age=300");
    },
  }),
);

// Public Routes
app.use("/", require("./routes/auth"));

// Protected API Routes
app.use("/api", require("./routes/api"));
app.use("/api/settings", require("./routes/settings").apiRouter);
app.use("/api/context", require("./routes/context"));
app.use("/api/discovery", require("./routes/discovery"));
app.use("/api/campaigns", require("./routes/campaigns"));
app.use("/api/pipelines", authMiddleware, require("./routes/pipelines"));
app.use("/api/monitoring", authMiddleware, require("./routes/monitoring"));
app.use("/api/assets", authMiddleware, require("./routes/assets"));
app.use("/api/audit", authMiddleware, require("./routes/audit"));
app.use("/api/maintenance", authMiddleware, require("./routes/maintenance"));

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
app.use("/", require("./routes/monitoringPage"));
app.use("/", require("./routes/assetsPage"));
app.use("/", require("./routes/auditPage"));

// Global Error Handlers
app.use(notFoundHandler);
app.use(errorHandler);

// Bind to localhost only — this is a local-first app; the passphrase-gated
// UI and automation controls must not be reachable from the LAN. Matches
// the bridge-server pattern (desktop/main/bridge-server/).
const server = app.listen(PORT, "127.0.0.1", () => {
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
