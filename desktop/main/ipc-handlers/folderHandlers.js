/**
 * ipc-handlers/folderHandlers.js
 *
 * Registers the two "open the data folder" IPC channels:
 *   - open:data-folder       — open envBootstrap.dataRoot in the OS file
 *                              explorer (shell.openPath)
 *   - open:data-folder-info  — return envBootstrap.dataRoot as a string
 *                              (read-only; used by the About tab)
 *
 * Required ctx: ipcMain, envBootstrap
 */

function registerFolderIpc(ctx) {
  const { ipcMain, envBootstrap } = ctx;

  // ─── Open folders in OS file explorer ──────────────────────────────────

  ipcMain.handle("open:data-folder", async () => {
    const { shell } = require("electron");
    await shell.openPath(envBootstrap.dataRoot);
    return { ok: true };
  });

  ipcMain.handle("open:data-folder-info", async () => envBootstrap.dataRoot);
}

module.exports = { registerFolderIpc };
