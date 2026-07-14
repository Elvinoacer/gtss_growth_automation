/**
 * ipc-handlers/cdpHandlers.js
 *
 * Registers all CDP-related IPC channels on the provided ipcMain:
 *   - cdp:start             — start CDP-only (advanced, opt-in)
 *   - cdp:stop              — stop CDP-only
 *   - cdp:restart           — restart CDP (re-runs profile clone); used by
 *                              the onboarding Finish screen's "Restart Chrome"
 *                              button when the initial clone warned
 *   - cdp:start-standalone  — legacy "just bring up CDP Chrome" channel
 *                              (retained for backwards compat; attaches to
 *                              an existing CDP endpoint if one is alive)
 *   - cdp:open-login-tabs   — open each platform's login page in the CDP
 *                              Chrome so the user can sign in
 *   - cdp:open-url-in-cdp   — open an arbitrary URL (e.g. Gemini homepage)
 *                              inside the already-running CDP Chrome; used
 *                              by the post-Start "missing sessions" modal
 *   - cdp:check-sessions    — poll cookies via CDP and return a map of
 *                              platform -> { loggedIn, cookies, label }
 *   - cdp:state             — lightweight poll for the CDP state
 *
 * Each handler returns a plain object: `{ ok, status?, error?, sessions? }`.
 *
 * Required ctx: ipcMain, lifecycle, cdpManager, envBootstrap, logStream
 */

function registerCdpIpc(ctx) {
  const { ipcMain, lifecycle, cdpManager, envBootstrap, logStream } = ctx;

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
      // Onboarding context → headless. The "Restart Chrome" button on the
      // onboarding Finish screen re-runs the profile clone after the user
      // closed their real Chrome (clone:warning). Chrome must stay
      // headless here — the launcher hasn't opened yet, so a visible
      // Chrome window would be a surprise window competing with the
      // wizard. Visible Chrome is reserved for the launcher's Start
      // button (see lifecycle:start).
      await cdpManager.restart({
        visible: false,
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
        //
        // visible: false — this is a background/setup path (legacy
        // "just get Chrome up"). Per the Launch Sequence UX Strategy,
        // background tasks must NEVER draw a visible window. Visible
        // Chrome is reserved for the launcher's Start button.
        await cdpManager.start({
          skipProfileCopy: true,
          visible: false,
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
      //
      // visible: true — this is a USER-INITIATED action (the user clicked
      // a button in the "Missing sessions" modal to open a login URL).
      // They expect to SEE Chrome so they can sign in. This is not a
      // background task; visible Chrome is correct here.
      if (!cdpManager.isRunning()) {
        await cdpManager.start({
          skipProfileCopy: true,
          visible: true,
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

  ipcMain.handle("cdp:check-sessions", async () => {
    try {
      const sessions = await cdpManager.checkSessions();
      return { ok: true, sessions, running: cdpManager.isRunning() };
    } catch (err) {
      return { ok: false, error: err.message, sessions: null, running: cdpManager.isRunning() };
    }
  });

  ipcMain.handle("cdp:state", () => cdpManager.getState());
}

module.exports = { registerCdpIpc };
