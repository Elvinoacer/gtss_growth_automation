/**
 * ipc-handlers/lifecycleHandlers.js
 *
 * Registers the Electron lifecycle IPC channels on the provided ipcMain:
 *   - lifecycle:start         — boot the server + CDP Chrome (visible CDP
 *                                + web-app-in-CDP on first-time sign-in;
 *                                otherwise the user's browser-mode setting)
 *   - lifecycle:stop          — stop the server + CDP Chrome (user-initiated)
 *   - lifecycle:restart       — restart everything
 *   - lifecycle:status        — poll the current lifecycle status
 *   - lifecycle:open-devtools — open (or re-focus) DevTools on the launcher
 *
 * Includes the local helper `isSigninComplete()` which checks for the
 * `.signin-completed` sentinel file in envBootstrap.dataRoot — this is
 * what decides whether `lifecycle:start` runs the first-time visible
 * flow or the normal background flow.
 *
 * Required ctx (passed in by index.js's `registerIpcHandlers`):
 *   - ipcMain, lifecycle, envBootstrap, logStream, getMainWindow
 */

const fs = require("fs");
const path = require("path");

function registerLifecycleIpc(ctx) {
  const { ipcMain, lifecycle, envBootstrap, logStream, getMainWindow } = ctx;

  // ─── First-time sign-in flow (the "exception" to the background default)
  //
  // The project's default is: CDP Chrome runs in the BACKGROUND (headless)
  // for normal automation work, and the web app opens in the user's default
  // browser. This is the right default for everyday use — the user doesn't
  // want a Chrome window they didn't ask for.
  //
  // The EXCEPTION is the first time the user presses Start (or any time
  // their platform sessions are still missing). In that case we:
  //   1. Launch CDP Chrome VISIBLY (not headless).
  //   2. Open the web app INSIDE that CDP Chrome (at http://localhost:3000,
  //      the root page) — NOT in the user's default browser.
  //   3. The sign-in modal now lives on the web app's root page. When the
  //      user clicks a platform, the modal calls the bridge server, which
  //      opens the login page in a new tab of the SAME CDP Chrome. The user
  //      logs in, cookies land in the automation browser's profile, polling
  //      detects them, and the UI updates optimistically.
  //   4. Once the user completes sign-in (clicks "All set" on the modal),
  //      the bridge writes a `.signin-completed` sentinel. Subsequent
  //      Starts use the normal background flow unless the user changed the
  //      browser-mode setting in Settings.
  //
  // The sentinel + the CDP_VISIBLE_DEFAULT env var together encode the
  // user's choice: no sentinel → first-time visible flow; sentinel present
  // → normal flow with visibility = (CDP_VISIBLE_DEFAULT === "true").
  function isSigninComplete() {
    try {
      return fs.existsSync(path.join(envBootstrap.dataRoot, ".signin-completed"));
    } catch (_) {
      return false;
    }
  }

  ipcMain.handle("lifecycle:start", async () => {
    try {
      const signinComplete = isSigninComplete();
      const env = envBootstrap.readEnv();
      const visibleDefault =
        String(env.CDP_VISIBLE_DEFAULT || "").toLowerCase() === "true";

      if (!signinComplete) {
        // First-time sign-in flow: visible CDP + web app opens INSIDE the
        // CDP Chrome so the sign-in modal on the root page can drive
        // logins in the automation browser.
        logStream.append("lifecycle", "First-time sign-in flow: launching Chrome visibly with the web app inside it.");
        await lifecycle.startAll({
          visible: true,
          openInCdp: true,
          openBrowser: false,
        });
      } else {
        // Normal flow: respect the user's browser-mode setting. Default
        // is background (headless) — the user has already signed in, so
        // there's no need for a visible Chrome window. The web app opens
        // in their default browser.
        logStream.append("lifecycle", `Normal flow: Chrome ${visibleDefault ? "visible" : "in background"}, web app in default browser.`);
        await lifecycle.startAll({
          visible: visibleDefault,
          openBrowser: true,
        });
      }
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
}

module.exports = { registerLifecycleIpc };
