/**
 * IPC handlers — the bridge between the renderer (UI) and the main process.
 *
 * Every user-visible action in the UI maps to exactly one IPC channel here.
 * The preload script (preload/preload.js) re-exposes these as a clean
 * `window.gtss.*` API to the renderer, so the renderer never touches Node
 * directly (sandbox: true, contextIsolation: true).
 */

const { BrowserWindow } = require("electron");

function registerIpcHandlers({
  ipcMain,
  lifecycle,
  serverManager,
  cdpManager,
  envBootstrap,
  firstRun,
  logStream,
  updater,
  getMainWindow,
  onOnboardingComplete,
}) {
  // Wire the env upsert hook so lifecycle.startAll() can write CDP_ENDPOINT
  // into the .env before starting the server.
  lifecycle.setEnvUpserter((k, v) => envBootstrap.upsert(k, v));

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  ipcMain.handle("lifecycle:start", async () => {
    try {
      await lifecycle.startAll({ openBrowser: true });
      return { ok: true, status: lifecycle.getStatus() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("lifecycle:stop", async () => {
    try {
      await lifecycle.stopAll("user");
      return { ok: true, status: lifecycle.getStatus() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("lifecycle:restart", async () => {
    try {
      await lifecycle.restartAll();
      return { ok: true, status: lifecycle.getStatus() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("lifecycle:status", () => lifecycle.getStatus());

  // ─── Server-only controls (for granular power users) ─────────────────────

  ipcMain.handle("server:start", async () => {
    try {
      await lifecycle.startServerOnly();
      return { ok: true, status: serverManager.getState() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("server:stop", async () => {
    try {
      await lifecycle.stopServerOnly();
      return { ok: true, status: serverManager.getState() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("server:status", () => serverManager.getState());

  // ─── CDP-only controls ───────────────────────────────────────────────────

  ipcMain.handle("cdp:start", async () => {
    try {
      await lifecycle.startCdpOnly();
      return { ok: true, status: cdpManager.getState() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("cdp:stop", async () => {
    try {
      await lifecycle.stopCdpOnly();
      return { ok: true, status: cdpManager.getState() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("cdp:status", () => cdpManager.getState());

  // ─── Open the app in the user's default browser ──────────────────────────

  ipcMain.handle("app:open-in-browser", async () => {
    const port = serverManager.port || 3000;
    const { shell } = require("electron");
    await shell.openExternal(`http://localhost:${port}`);
    return { ok: true };
  });

  // ─── Logs ────────────────────────────────────────────────────────────────

  ipcMain.handle("logs:snapshot", (_event, n) => logStream.snapshot(n));

  // Push new log lines to the renderer via webContents.send.
  logStream.on("line", (entry) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send("logs:line", entry);
    }
  });

  ipcMain.handle("logs:clear", () => {
    logStream.clear();
    return { ok: true };
  });

  // ─── First-run onboarding ────────────────────────────────────────────────

  ipcMain.handle("onboarding:status", async () => ({
    required: await firstRun.isRequired(),
  }));

  ipcMain.handle("onboarding:complete", async (_event, payload) => {
    try {
      await firstRun.complete(payload.passphrase, payload.geminiKey);
      // Tell main.js to swap windows.
      if (typeof onOnboardingComplete === "function") {
        onOnboardingComplete();
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("onboarding:open-login", async (_event, platform) => {
    try {
      await firstRun.openPlatformLogin(platform);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ─── Settings ────────────────────────────────────────────────────────────

  ipcMain.handle("settings:get", async () => {
    const env = envBootstrap.readEnv();
    // Redact sensitive values.
    return {
      geminiModel: env.GEMINI_MODEL || "gemini-2.0-flash",
      hasGeminiKey: Boolean(env.GEMINI_API_KEY),
      hasPassphrase: Boolean(env.PASSPHRASE_HASH),
      hasGmail: Boolean(env.GMAIL_USER),
      port: env.PORT || "3000",
      browserMode: env.BROWSER_MODE || "persistent",
      linkedinOutreachMode: env.LINKEDIN_OUTREACH_MODE || "connect_first",
      pipelineMode: env.PIPELINE_MODE || "ai",
      pipelineCron: env.PIPELINE_CRON || "0 8 * * *",
      qualificationThreshold: env.QUALIFICATION_THRESHOLD || "50",
      serverRoot: envBootstrap.serverRoot,
      dataRoot: envBootstrap.dataRoot,
    };
  });

  ipcMain.handle("settings:update", async (_event, patch) => {
    try {
      const map = {
        geminiKey: "GEMINI_API_KEY",
        geminiModel: "GEMINI_MODEL",
        port: "PORT",
        browserMode: "BROWSER_MODE",
        linkedinOutreachMode: "LINKEDIN_OUTREACH_MODE",
        pipelineMode: "PIPELINE_MODE",
        pipelineCron: "PIPELINE_CRON",
        qualificationThreshold: "QUALIFICATION_THRESHOLD",
        gmailUser: "GMAIL_USER",
        gmailAppPassword: "GMAIL_APP_PASSWORD",
      };
      for (const [k, v] of Object.entries(patch)) {
        if (map[k] && v !== undefined && v !== null) {
          envBootstrap.upsert(map[k], v);
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("settings:reset-passphrase", async (_event, newPassphrase) => {
    try {
      await envBootstrap.setPassphrase(newPassphrase);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ─── Auto-update ─────────────────────────────────────────────────────────

  ipcMain.handle("updater:status", () => updater.getState());

  ipcMain.handle("updater:check", async () => {
    try {
      updater.checkSilently();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("updater:download", async () => {
    try {
      await updater.downloadAndInstall();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("updater:install", async () => {
    try {
      updater.quitAndInstall();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Push updater state changes to the renderer.
  updater.on("state-changed", (state) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send("updater:state", state);
    }
  });

  // ─── Open paths in OS file explorer ──────────────────────────────────────

  ipcMain.handle("open:data-folder", async () => {
    const { shell } = require("electron");
    await shell.openPath(envBootstrap.dataRoot);
    return { ok: true };
  });

  ipcMain.handle("open:logs-folder", async () => {
    const { shell } = require("electron");
    const logsDir = require("path").join(envBootstrap.dataRoot, "logs");
    if (!require("fs").existsSync(logsDir)) {
      require("fs").mkdirSync(logsDir, { recursive: true });
    }
    await shell.openPath(logsDir);
    return { ok: true };
  });
}

module.exports = { registerIpcHandlers };
