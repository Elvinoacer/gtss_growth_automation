/**
 * IPC handlers — the bridge between the renderer (UI) and the main process.
 *
 * Trimmed down to match the new minimal launcher:
 *   - No settings channels (the web app handles all settings).
 *   - No onboarding:open-login (platform logins happen in the web app's
 *     Settings → Platform Sessions).
 *   - Added lifecycle:restart (used by the Advanced controls).
 *   - Added open:data-folder-info (read-only, for the About tab).
 *   - Added gemini:validate-key (live Gemini API key validation during
 *     onboarding and from Settings).
 *   - Added cdp:open-url-in-cdp (open an arbitrary URL — e.g. the Gemini
 *     homepage — inside the already-running CDP Chrome; used by the
 *     "Sign in to your accounts" modal so login happens in the SAME
 *     browser instance that handles automation, never a new one).
 *
 * Every user-visible action in the UI maps to exactly one IPC channel here.
 * The preload script re-exposes these as a clean `window.gtss.*` API to the
 * renderer, so the renderer never touches Node directly (sandbox: true,
 * contextIsolation: true).
 */

const { validateGeminiApiKey } = require("./cdp-manager");

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

  // ─── CDP restart (NEW) ─────────────────────────────────────────────────
  //
  // Used by the onboarding Finish screen's "Restart Chrome" button —
  // surfaces when the profile clone failed because the user's real
  // Chrome was holding SQLite locks on Cookies/Login Data (the
  // "clone:warning" stage emitted by cdp-manager.js ensureCdpProfile()).
  //
  // This wraps cdpManager.restart() (which is stop() + start()) and
  // re-runs the profile clone on the next start(). Crucially, it does
  // NOT touch the running server — only the CDP Chrome — so the user's
  // web app session is unaffected. Returns the new CDP state so the
  // caller can confirm Chrome came back up.
  //
  // The onProgress callback forwards clone-stage messages into the
  // logStream so the launcher's Logs tab shows what the restart is
  // doing (the onboarding renderer's progress checklist is driven by
  // the same `clone` / `clone:warning` stages via the
  // "onboarding:progress" channel — see lifecycle.startAll).
  ipcMain.handle("cdp:restart", async () => {
    try {
      await cdpManager.restart({
        onProgress: (_stage, message) => {
          try { logStream.append("cdp", message); } catch (_) {}
        },
      });
      // Persist the CDP endpoint into .env in case the previous start
      // wrote BROWSER_MODE=persistent (the fallback path).
      envBootstrap.upsert("CDP_ENDPOINT", `http://127.0.0.1:${cdpManager.port}`);
      envBootstrap.upsert("BROWSER_MODE", "cdp");
      return { ok: true, status: cdpManager.getState() };
    } catch (err) {
      return { ok: false, error: err.message, status: cdpManager.getState() };
    }
  });

  // ─── CDP session checking (post-Start "missing sessions" modal) ───────
  //
  // These channels support the launcher's post-Start "missing sessions"
  // modal — which auto-pops after the user clicks Start, the server boots,
  // and the web app URL has loaded in the CDP Chrome. The modal lists each
  // platform (LinkedIn, X, Instagram, Facebook, Google/Gemini) with an
  // "Open ↗" button that opens its login page IN the already-running CDP
  // Chrome — never a new browser instance. Live polling detects each
  // login as it happens, reusing the same UX pattern as the web app's
  // /settings → Platform Sessions.
  //
  // We expose:
  //   - cdp:start-standalone: legacy channel. Launches CDP Chrome WITHOUT
  //     a URL and (by default) WITHOUT cloning the user's profile. This
  //     used to be called from onboarding step 3, but onboarding no longer
  //     touches Chrome (sign-in was moved to the post-Start modal — see
  //     renderer.js). The channel is retained for backwards compat and
  //     for callers that need a "just get Chrome up" path. With the
  //     strengthened try-first-then-clone pattern, startStandalone() will
  //     also ATTACH to an existing CDP endpoint if one is alive, so it
  //     never spawns a second Chrome.
  //   - cdp:open-login-tabs: open each platform's login page in the CDP
  //     Chrome so the user can sign in.
  //   - cdp:open-url-in-cdp: open an ARBITRARY url (e.g. the Gemini
  //     homepage) in a new tab inside the already-running CDP Chrome.
  //     Used by the "Missing sessions" modal in the main launcher window —
  //     logins always reuse the existing browser, never spawn a new one.
  //   - cdp:check-sessions: poll cookies via CDP and return a map of
  //     platform -> { loggedIn, cookies, label }.
  //   - cdp:state: lightweight poll for the CDP state.

  ipcMain.handle("cdp:start-standalone", async () => {
    try {
      if (!cdpManager.isRunning()) {
        // Legacy "just get Chrome up" channel. Originally called from
        // onboarding step 3, but onboarding no longer touches Chrome
        // (sign-in was moved to the post-Start "missing sessions" modal
        // — see renderer.js). Retained for any caller that needs to bring
        // up CDP Chrome without a URL.
        //
        // With the strengthened try-first-then-clone pattern, start()
        // first ATTACHES to any Chrome already listening on the CDP port
        // — so this never spawns a second Chrome. If no endpoint is
        // alive, we spawn one WITHOUT cloning the user's profile
        // (skipProfileCopy: true) — the slow clone is deferred to
        // lifecycle.startAll() which runs with live progress feedback in
        // the launcher UI.
        await cdpManager.start({
          skipProfileCopy: true,
          onProgress: (_stage, message) => {
            // The CdpManager already appends to logStream, but we also
            // surface a high-level lifecycle banner so the launcher's Logs
            // tab shows the browser startup clearly.
            logStream.append("lifecycle", message);
          },
        });
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

  // Open a single arbitrary URL in the running CDP Chrome. Used by the
  // "Missing sessions" modal in the main launcher window — each platform
  // (LinkedIn, Facebook, Instagram, Google Gemini) gets a button that
  // calls this with the platform's login URL. Always reuses the existing
  // browser; never spawns a new instance.
  ipcMain.handle("cdp:open-url-in-cdp", async (_event, url) => {
    try {
      if (!url || typeof url !== "string") {
        return { ok: false, error: "No URL provided." };
      }
      // If CDP isn't running, start it (without cloning — the user is
      // responding to a "missing sessions" prompt, so they're about to
      // sign in anyway; no point cloning a profile they're going to
      // overwrite with fresh logins).
      if (!cdpManager.isRunning()) {
        await cdpManager.start({
          skipProfileCopy: true,
          onProgress: (_stage, message) => logStream.append("lifecycle", message),
        });
        envBootstrap.upsert("CDP_ENDPOINT", `http://127.0.0.1:${cdpManager.port}`);
        envBootstrap.upsert("BROWSER_MODE", "cdp");
      }
      const ok = await cdpManager.openTab(url);
      if (!ok) {
        return { ok: false, error: "Could not open a new tab in the CDP Chrome." };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ─── Gemini API key validation ─────────────────────────────────────────
  //
  // Lightweight validation that an API key is genuinely a Google AI Studio
  // key. Hits the list-models endpoint (cheap, no quota impact) and treats
  // 429 (quota exceeded) as VALID — per requirements, we only care whether
  // the key itself is valid, not whether the user has hit a rate limit.
  // Returns { ok, valid, reason } so the renderer can show:
  //   ✅ API key is valid
  //   ❌ Invalid API key (HTTP 401)
  ipcMain.handle("gemini:validate-key", async (_event, apiKey) => {
    try {
      const result = await validateGeminiApiKey(apiKey);
      return result;
    } catch (err) {
      return { ok: false, valid: false, reason: err.message };
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
  // Always opens in the user's DEFAULT browser via shell.openExternal.
  // Previously this opened a tab inside the running CDP Chrome (via the
  // DevTools HTTP API) — but that tied the web-app tab to the CDP Chrome,
  // which felt "embedded inside Electron". Now the web app always opens
  // in the user's normal browser. See Lifecycle.openWebApp().

  ipcMain.handle("app:open-in-browser", async () => {
    try {
      await lifecycle.openWebApp();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ─── Open an arbitrary URL in the user's default browser ──────────────
  //
  // Used by the "Missing sessions" modal in the launcher — each platform
  // (LinkedIn, Facebook, Instagram, Google Gemini) gets an "Open ↗"
  // button that calls this with the platform's login URL. The URL opens
  // in the user's DEFAULT browser (not the CDP Chrome), so the user
  // signs in where they're already comfortable and where their existing
  // sessions live.
  //
  // This is the key change for "authentication in the browser, not
  // inside Electron": previously the modal called cdp:open-url-in-cdp
  // which opened login pages inside the CDP Chrome that Electron
  // spawned. Now we always shell.openExternal — the CDP Chrome still
  // runs for automation, but authentication happens in the user's
  // normal browser.
  ipcMain.handle("app:open-external", async (_event, url) => {
    try {
      if (!url || typeof url !== "string") {
        return { ok: false, error: "No URL provided." };
      }
      // Only allow http(s) URLs — never file://, javascript:, etc.
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, error: "Only http(s) URLs are allowed." };
      }
      const { shell } = require("electron");
      await shell.openExternal(url);
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
      // ─── Run the full startup WITH live progress events ───────────────
      //
      // Previously this was fire-and-forget: onOnboardingComplete() was
      // called without await, the IPC returned immediately, and main.js
      // did the window swap + server startup in the background. The user
      // saw a brief flash of "background tasks" and was immediately
      // redirected to the launcher — without any visibility into what
      // was happening.
      //
      // Now we AWAIT onOnboardingComplete(). It runs the full server +
      // browser startup, streaming progress events back to the onboarding
      // window via webContents.send("onboarding:progress", ...). The
      // renderer shows each stage on its progress screen. Only after
      // startup succeeds does onOnboardingComplete() swap windows — so
      // by the time the IPC resolves, the user is already in the
      // launcher. (If startup fails, onOnboardingComplete throws, the
      // IPC returns { ok:false, error }, and the renderer shows the
      // error in-place — the onboarding window stays open for retry.)
      if (typeof onOnboardingComplete === "function") {
        await onOnboardingComplete((stage, message) => {
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send("onboarding:progress", {
              stage,
              message,
              ts: Date.now(),
            });
          }
        });
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
