/**
 * IPC handlers — the bridge between the renderer (UI) and the main process.
 *
 * Trimmed down to match the new minimal launcher:
 *   - No settings channels (the web app handles all settings).
 *   - No onboarding:open-login (platform logins happen in the web app's
 *     Settings → Platform Sessions).
 *   - Added lifecycle:restart (used by the Advanced controls).
 *   - Added open:data-folder-info (read-only, for the About tab).
 *
 * Every user-visible action in the UI maps to exactly one IPC channel here.
 * The preload script re-exposes these as a clean `window.gtss.*` API to the
 * renderer, so the renderer never touches Node directly (sandbox: true,
 * contextIsolation: true).
 */

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

  // ─── CDP-only controls (advanced, opt-in) ──────────────────────────────

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

  // ─── Open the web app ───────────────────────────────────────────────────
  //
  // If CDP Chrome is running, open a new tab IN the CDP Chrome (via the
  // DevTools HTTP API). Otherwise, fall back to the default browser.

  ipcMain.handle("app:open-in-browser", async () => {
    try {
      await lifecycle.openWebApp();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ─── Logs ────────────────────────────────────────────────────────────────

  ipcMain.handle("logs:snapshot", (_event, n) => logStream.snapshot(n));

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
      if (typeof onOnboardingComplete === "function") {
        // Fire-and-forget — main.js handles the window swap + auto-start.
        onOnboardingComplete();
      }
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

  updater.on("state-changed", (state) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send("updater:state", state);
    }
  });

  // ─── Open folders in OS file explorer ──────────────────────────────────

  ipcMain.handle("open:data-folder", async () => {
    const { shell } = require("electron");
    await shell.openPath(envBootstrap.dataRoot);
    return { ok: true };
  });

  ipcMain.handle("open:data-folder-info", async () => envBootstrap.dataRoot);
}

module.exports = { registerIpcHandlers };
