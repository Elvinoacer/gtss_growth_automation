/**
 * GTSS Growth Engine — Electron main process entry point.
 *
 * Responsibilities:
 *  - Create the control-center window (renderer UI).
 *  - Wire IPC channels to the lifecycle / server / CDP managers.
 *  - Run first-launch onboarding if no .env exists yet.
 *  - Start the auto-updater.
 *  - Keep the app alive in the tray when the window is closed.
 *
 * The actual server (gtss-growth-engine/src/server.js) runs as a forked child
 * process. We never spawn terminals — everything is orchestration in-process.
 */

const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");

const { ServerManager } = require("./server-manager");
const { CdpManager } = require("./cdp-manager");
const { Lifecycle } = require("./lifecycle");
const { LogStream } = require("./log-stream");
const { FirstRun } = require("./first-run");
const { AutoUpdater } = require("./auto-updater");
const { EnvBootstrap } = require("./env-bootstrap");
const { registerIpcHandlers } = require("./ipc-handlers");

const DEV = process.argv.includes("--dev");

// Where the gtss-growth-engine source lives at runtime.
// In development: <repo>/gtss-growth-engine
// In packaged app: <resources>/server
const SERVER_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "server")
  : path.resolve(__dirname, "..", "..", "gtss-growth-engine");

// All mutable state (DB, sessions, profiles, .env) lives in userData, NOT in
// the read-only resources dir. This survives app updates.
const DATA_ROOT = path.join(app.getPath("userData"), "engine-data");

// The Electron renderer HTML to load.
const RENDERER_INDEX = path.join(__dirname, "..", "renderer", "index.html");
const RENDERER_ONBOARD = path.join(__dirname, "..", "renderer", "onboarding.html");

let mainWindow = null;
let tray = null;
let lifecycle = null;
let logStream = null;
let envBootstrap = null;
let firstRun = null;
let updater = null;

// Single-instance lock — prevent two copies of the app from running.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on("window-all-closed", (event) => {
  // On all platforms, keep the tray alive when the window is closed.
  // The user explicitly quits via tray menu or app menu.
  event.preventDefault();
});

app.on("before-quit", async (event) => {
  if (lifecycle && lifecycle.isRunning()) {
    event.preventDefault();
    try {
      await lifecycle.stopAll("app-quit");
    } catch (err) {
      console.error("Stop-on-quit failed:", err);
    } finally {
      app.exit(0);
    }
  }
});

app.whenReady().then(async () => {
  // 1. Set up runtime directories and generate .env on first launch.
  envBootstrap = new EnvBootstrap(SERVER_ROOT, DATA_ROOT);
  await envBootstrap.ensure();

  // 2. Wire up managers.
  logStream = new LogStream({ maxLines: 5000 });
  const serverManager = new ServerManager({ serverRoot: envBootstrap.resolvedServerRoot, dataRoot: DATA_ROOT, logStream });
  const cdpManager = new CdpManager({ dataRoot: DATA_ROOT, logStream });
  lifecycle = new Lifecycle({ serverManager, cdpManager, envBootstrap, logStream });

  firstRun = new FirstRun({ envBootstrap });
  updater = new AutoUpdater({ logStream });

  // 3. Register IPC handlers — these are what the renderer calls.
  registerIpcHandlers({
    ipcMain,
    lifecycle,
    serverManager,
    cdpManager,
    envBootstrap,
    firstRun,
    logStream,
    updater,
    getMainWindow: () => mainWindow,
    onOnboardingComplete: async () => {
      // Swap onboarding window for the main control panel.
      if (mainWindow) {
        mainWindow.close();
        mainWindow = null;
      }
      await createMainWindow();
      // Auto-start the server and open the web app — true one-click UX.
      // The user just finished onboarding; they shouldn't have to click
      // Start manually. Wrapped in try/catch so a startup failure doesn't
      // leave them stuck — the error card on the Control tab will surface
      // whatever went wrong.
      try {
        await lifecycle.startAll({ openBrowser: true });
      } catch (err) {
        logStream.append("lifecycle:stderr", `Auto-start after onboarding failed: ${err.message}`);
        logStream.append("lifecycle", "Click Start on the Control tab to retry.");
      }
    },
  });

  // 4. Create the tray icon (so closing the window doesn't kill the app).
  createTray();

  // 5. Decide which window to show first.
  if (await firstRun.isRequired()) {
    await createOnboardingWindow();
  } else {
    await createMainWindow();
  }

  // 6. Kick off auto-update check in the background (silent).
  updater.checkSilently();
});

// ─── Window creation ────────────────────────────────────────────────────────

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    title: "GTSS Growth Engine",
    backgroundColor: "#0f172a",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadFile(RENDERER_INDEX);

  // DevTools is opt-in. Previously `npm run dev` would automatically pop a
  // second window with detached DevTools — which is noisy if all you wanted
  // was a hot-reload of the renderer. Now DevTools only opens if the
  // developer explicitly asks for it via either:
  //   - env var  OPEN_DEVTOOLS_ON_START=1   (set in your shell or .env)
  //   - the "Open DevTools" button in the launcher UI (always available)
  //   - the standard Electron keyboard shortcut Ctrl/Cmd+Shift+I
  if (DEV && /^(1|true|yes|on)$/i.test(String(process.env.OPEN_DEVTOOLS_ON_START || ""))) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  // Open external links in the user's default browser, not inside Electron.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.on("close", (e) => {
    // Hide instead of destroy so the tray keeps the app alive.
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

async function createOnboardingWindow() {
  mainWindow = new BrowserWindow({
    width: 880,
    height: 720,
    minWidth: 720,
    minHeight: 600,
    title: "Welcome to GTSS Growth Engine",
    backgroundColor: "#0f172a",
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadFile(RENDERER_ONBOARD);
}

// ─── Tray ───────────────────────────────────────────────────────────────────

function createTray() {
  // Use a tiny 16x16 transparent PNG if no icon is bundled.
  const iconPath = path.join(__dirname, "..", "build", "tray-icon.png");
  const image = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);

  const menu = Menu.buildFromTemplate([
    { label: "Open GTSS Growth Engine", click: () => mainWindow && mainWindow.show() },
    { type: "separator" },
    {
      label: "Quick Start",
      click: async () => {
        if (lifecycle && !lifecycle.isRunning()) {
          await lifecycle.startAll();
        }
        if (mainWindow) mainWindow.show();
      },
    },
    {
      label: "Stop",
      click: async () => {
        if (lifecycle && lifecycle.isRunning()) {
          await lifecycle.stopAll("tray-stop");
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip("GTSS Growth Engine");
  tray.setContextMenu(menu);
  tray.on("click", () => mainWindow && mainWindow.show());
}

// Expose for tray / lifecycle hooks.
app.isQuitting = false;
