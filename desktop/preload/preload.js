/**
 * preload.js — security boundary between the renderer (untrusted UI) and the
 * main process (full Node access).
 *
 * We expose a single `window.gtss` object with explicitly-whitelisted methods.
 * Each method maps 1:1 to an ipcMain.handle channel in main/ipc-handlers.js.
 * The renderer never touches Node, never touches the filesystem, and never
 * touches the network directly.
 *
 * contextIsolation: true ensures this `gtss` object is the ONLY thing the
 * renderer can see from the main process.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gtss", {
  // ─── Lifecycle ──────────────────────────────────────────────────────────
  lifecycle: {
    start: () => ipcRenderer.invoke("lifecycle:start"),
    stop: () => ipcRenderer.invoke("lifecycle:stop"),
    restart: () => ipcRenderer.invoke("lifecycle:restart"),
    status: () => ipcRenderer.invoke("lifecycle:status"),
  },

  // ─── Server-only controls ───────────────────────────────────────────────
  server: {
    start: () => ipcRenderer.invoke("server:start"),
    stop: () => ipcRenderer.invoke("server:stop"),
    status: () => ipcRenderer.invoke("server:status"),
  },

  // ─── CDP-only controls ──────────────────────────────────────────────────
  cdp: {
    start: () => ipcRenderer.invoke("cdp:start"),
    stop: () => ipcRenderer.invoke("cdp:stop"),
    status: () => ipcRenderer.invoke("cdp:status"),
  },

  // ─── Open the app in the user's default browser ─────────────────────────
  openInBrowser: () => ipcRenderer.invoke("app:open-in-browser"),

  // ─── Logs ───────────────────────────────────────────────────────────────
  logs: {
    snapshot: (n) => ipcRenderer.invoke("logs:snapshot", n),
    clear: () => ipcRenderer.invoke("logs:clear"),
    onLine: (cb) => {
      const listener = (_event, entry) => cb(entry);
      ipcRenderer.on("logs:line", listener);
      return () => ipcRenderer.removeListener("logs:line", listener);
    },
  },

  // ─── First-run onboarding ───────────────────────────────────────────────
  onboarding: {
    status: () => ipcRenderer.invoke("onboarding:status"),
    complete: (payload) => ipcRenderer.invoke("onboarding:complete", payload),
    openLogin: (platform) => ipcRenderer.invoke("onboarding:open-login", platform),
  },

  // ─── Settings ───────────────────────────────────────────────────────────
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (patch) => ipcRenderer.invoke("settings:update", patch),
    resetPassphrase: (newPassphrase) =>
      ipcRenderer.invoke("settings:reset-passphrase", newPassphrase),
  },

  // ─── Auto-updater ───────────────────────────────────────────────────────
  updater: {
    status: () => ipcRenderer.invoke("updater:status"),
    check: () => ipcRenderer.invoke("updater:check"),
    download: () => ipcRenderer.invoke("updater:download"),
    install: () => ipcRenderer.invoke("updater:install"),
    onState: (cb) => {
      const listener = (_event, state) => cb(state);
      ipcRenderer.on("updater:state", listener);
      return () => ipcRenderer.removeListener("updater:state", listener);
    },
  },

  // ─── Open folders in OS file explorer ───────────────────────────────────
  open: {
    dataFolder: () => ipcRenderer.invoke("open:data-folder"),
    logsFolder: () => ipcRenderer.invoke("open:logs-folder"),
  },

  // ─── App info ───────────────────────────────────────────────────────────
  app: {
    version: process.env.npm_package_version || "1.0.0",
    platform: process.platform,
    isMac: process.platform === "darwin",
    isWindows: process.platform === "win32",
    isLinux: process.platform === "linux",
  },
});
