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

  // ─── Open DevTools on the main window ──────────────────────────────────
  //
  // DevTools is no longer auto-opened on `npm run dev`. The developer can
  // open it on demand via this channel (wired to the "Open DevTools" button
  // in the launcher UI). It opens in a detached window so it doesn't shrink
  // the launcher UI.
  ipcMain.handle("lifecycle:open-devtools", async () => {
    try {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) {
        return { ok: false, error: "Main window is not available." };
      }
      const wc = win.webContents;
      if (wc.isDevToolsOpened()) {
        // Already open — just bring it to the front so the developer can
        // find it (Electron's devtools window doesn't focus on subsequent
        // openDevTools calls).
        wc.closeDevTools();
        wc.openDevTools({ mode: "detach" });
      } else {
        wc.openDevTools({ mode: "detach" });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

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

  // ─── CDP session checking (onboarding "Sign in to your accounts") ──────
  //
  // These channels support the new onboarding step that gates "Continue"
  // on the user being logged into Google (required for Gemini) plus the
  // other social platforms. We expose:
  //   - cdp:start-standalone: launch CDP Chrome WITHOUT the web app URL
  //     (the web app isn't up yet during onboarding). Uses the copied
  //     profile so existing logins carry over.
  //   - cdp:open-login-tabs: open each platform's login page in the CDP
  //     Chrome so the user can sign in.
  //   - cdp:check-sessions: poll cookies via CDP and return a map of
  //     platform -> { loggedIn, cookies, label }.
  //   - cdp:state: lightweight poll for the CDP state (used by onboarding
  //     to know when Chrome is up).

  ipcMain.handle("cdp:start-standalone", async () => {
    try {
      if (!cdpManager.isRunning()) {
        // Start CDP Chrome WITHOUT a URL — we just need the browser up so
        // the user can sign in. openLoginTabs() will open the actual login
        // pages in new tabs.
        await cdpManager.start({});
        // Persist the CDP endpoint into .env so when the server boots
        // later it picks up the same Chrome.
        envBootstrap.upsert("CDP_ENDPOINT", `http://127.0.0.1:${cdpManager.port}`);
        envBootstrap.upsert("BROWSER_MODE", "cdp");
      }
      return { ok: true, status: cdpManager.getState() };
    } catch (err) {
      return { ok: false, error: err.message, status: cdpManager.getState() };
    }
  });

  ipcMain.handle("cdp:open-login-tabs", async (_event, platforms) => {
    try {
      const list = Array.isArray(platforms) && platforms.length > 0
        ? platforms
        : ["google", "linkedin", "facebook", "x"];
      const result = await cdpManager.openLoginTabs(list);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("cdp:check-sessions", async () => {
    try {
      const sessions = await cdpManager.checkSessions();
      return { ok: true, sessions, running: cdpManager.isRunning() };
    } catch (err) {
      return { ok: false, error: err.message, sessions: null, running: cdpManager.isRunning() };
    }
  });

  ipcMain.handle("cdp:state", () => cdpManager.getState());

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
