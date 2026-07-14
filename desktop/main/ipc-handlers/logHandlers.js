/**
 * ipc-handlers/logHandlers.js
 *
 * Registers the log-stream IPC channels on the provided ipcMain:
 *   - logs:snapshot — return the last N log lines (default = the
 *                      logStream's full in-memory buffer)
 *   - logs:line     — push event: logStream emits "line" → forward each
 *                      entry to the renderer via webContents.send
 *   - logs:clear    — clear the in-memory log buffer
 *
 * The "line" event listener is attached at registration time and remains
 * live for the lifetime of the process — every line appended to the
 * logStream is forwarded to the (current) main window. If the window is
 * destroyed or unavailable, the line is silently dropped (no error).
 *
 * Required ctx: ipcMain, logStream, getMainWindow
 */

function registerLogIpc(ctx) {
  const { ipcMain, logStream, getMainWindow } = ctx;

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
}

module.exports = { registerLogIpc };
