/**
 * ipc-handlers/updaterHandlers.js
 *
 * Registers the auto-update IPC channels and the state-change push event:
 *   - updater:status             — poll current updater state (renderer init)
 *   - updater:check              — user-initiated "Check for updates" (throws
 *                                  on throttle / network error)
 *   - updater:download           — start downloading the detected update
 *   - updater:install            — quit, install, and restart the app
 *   - updater:set-auto-download  — toggle silent background downloads
 *   - updater:state (PUSH event) — main → renderer push whenever state
 *                                  changes (forwarded from updater.on)
 *
 * Also kicks off `updater.startPeriodicChecks()` (every 4h by default; safe
 * no-op in dev) so the renderer doesn't have to remember to start it.
 *
 * Required ctx: ipcMain, updater, getMainWindow
 */

function registerUpdaterIpc(ctx) {
  const { ipcMain, updater, getMainWindow } = ctx;

  ipcMain.handle("updater:status", () => updater.getState());

  ipcMain.handle("updater:check", async () => {
    try {
      await updater.checkForUpdates();
      return { ok: true, state: updater.getState() };
    } catch (err) {
      return { ok: false, error: err.message, state: updater.getState() };
    }
  });

  ipcMain.handle("updater:download", async () => {
    try {
      await updater.downloadAndInstall();
      return { ok: true, state: updater.getState() };
    } catch (err) {
      return { ok: false, error: err.message, state: updater.getState() };
    }
  });

  ipcMain.handle("updater:install", async () => {
    try {
      await updater.quitAndInstall();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("updater:set-auto-download", async (_event, enabled) => {
    try {
      updater.setAutoDownload(!!enabled);
      return { ok: true, state: updater.getState() };
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

  // Start periodic background checks (every 4h by default). Safe no-op in dev.
  updater.startPeriodicChecks();
}

module.exports = { registerUpdaterIpc };
