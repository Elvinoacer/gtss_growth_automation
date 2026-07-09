/**
 * preload.js — security boundary between the renderer (untrusted UI) and the
 * main process (full Node access).
 *
 * Exposes a single `window.gtss` object with explicitly-whitelisted methods.
 * Each method maps 1:1 to an ipcMain.handle channel in main/ipc-handlers.js.
 * The renderer never touches Node, never touches the filesystem, and never
 * touches the network directly.
 *
 * Trimmed to match the minimal launcher: no settings, no platform logins.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gtss", {
  // ─── Lifecycle ──────────────────────────────────────────────────────────
  lifecycle: {
    start: () => ipcRenderer.invoke("lifecycle:start"),
    stop: () => ipcRenderer.invoke("lifecycle:stop"),
    restart: () => ipcRenderer.invoke("lifecycle:restart"),
    status: () => ipcRenderer.invoke("lifecycle:status"),
    // Open Electron DevTools for the launcher window itself (not the web
    // app's CDP browser). Useful for debugging the launcher UI without
    // having to set OPEN_DEVTOOLS_ON_START=1.
    openDevtools: () => ipcRenderer.invoke("lifecycle:open-devtools"),
  },

  // ─── CDP controls (advanced, opt-in) ───────────────────────────────────
  cdp: {
    start: () => ipcRenderer.invoke("cdp:start"),
    stop: () => ipcRenderer.invoke("cdp:stop"),
    // Legacy "just get Chrome up" channel. Originally used by onboarding
    // step 3 to launch CDP Chrome for in-wizard sign-in, but onboarding
    // no longer touches Chrome — sign-in now happens via the post-Start
    // "missing sessions" modal in renderer.js (which uses openUrlInCdp
    // + checkSessions). Retained for callers that need a "just get Chrome
    // up" path. Honours the try-first-then-clone pattern: attaches to an
    // existing CDP endpoint if one is alive; otherwise spawns (without
    // cloning the user's profile — the slow clone is deferred to
    // lifecycle.startAll()).
    startStandalone: () => ipcRenderer.invoke("cdp:start-standalone"),
    // Open each platform's login page in the running CDP Chrome.
    openLoginTabs: (platforms) => ipcRenderer.invoke("cdp:open-login-tabs", platforms),
    // Open an arbitrary URL (e.g. https://gemini.google.com/) inside the
    // running CDP Chrome. Used by the "Missing sessions" modal in the main
    // launcher window so logins always reuse the existing browser — never
    // spawn a new Chrome instance, never create another endpoint.
    openUrlInCdp: (url) => ipcRenderer.invoke("cdp:open-url-in-cdp", url),
    // Poll current session state via CDP cookies. Returns:
    //   { ok, sessions: { google:{loggedIn,cookies,label}, linkedin:..., ... }, running }
    // or { ok:false, sessions:null, running } if the CDP query failed.
    checkSessions: () => ipcRenderer.invoke("cdp:check-sessions"),
    // Lightweight state poll — used by onboarding to know when Chrome is up.
    state: () => ipcRenderer.invoke("cdp:state"),
  },

  // ─── Gemini API key validation ─────────────────────────────────────────
  //
  // Live validation that an API key is genuinely a Google AI Studio key.
  // Returns { ok, valid, reason }. `ok:false` means we couldn't reach
  // Google to validate (network error / timeout) — the renderer should
  // treat that as "unknown" rather than "invalid".
  gemini: {
    validateKey: (apiKey) => ipcRenderer.invoke("gemini:validate-key", apiKey),
  },

  // ─── Open the web app in the user's default browser ─────────────────────
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
    dataFolderInfo: () => ipcRenderer.invoke("open:data-folder-info"),
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
