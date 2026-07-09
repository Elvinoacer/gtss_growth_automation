/**
 * Lifecycle — high-level orchestration of the server + CDP browser.
 *
 * ─── Strategy: CDP-unified flow ────────────────────────────────────────────
 *
 * The user's workflow is built around CDP. The project's automation connects
 * to a Chrome instance running with --remote-debugging-port. The web app
 * (localhost:3000) is where the user manages everything — logins, settings,
 * campaigns, automation triggers.
 *
 * To avoid the friction of two separate Chrome windows (one for the web app,
 * one for CDP automation), startAll() does this:
 *
 *   1. Start CDP Chrome with the web app URL as an argument.
 *      → Chrome opens with localhost:3000 in a tab AND has remote debugging
 *        enabled on port 9222.
 *   2. Write CDP_ENDPOINT + BROWSER_MODE=cdp to .env.
 *   3. Start the server.
 *      → The server reads BROWSER_MODE=cdp, connects to the CDP endpoint,
 *        and automation works immediately.
 *
 * The user sees ONE Chrome window with the web app open. Automation runs in
 * that same Chrome. No default-browser confusion, no "automation won't work
 * because CDP isn't started" errors.
 *
 * If Chrome isn't installed (CDP can't start), we fall back to:
 *   - BROWSER_MODE=persistent (Playwright launches its own Chromium)
 *   - Open the web app in the user's default browser via shell.openExternal
 *   - Show a warning that automation will use an isolated browser
 *
 * ─── Deferred profile cloning ─────────────────────────────────────────────
 *
 * The (potentially slow) "clone the user's Chrome profile into the CDP
 * profile" step is NOT performed during onboarding — the wizard no longer
 * touches Chrome at all. The clone happens HERE, inside `startAll()`, the
 * first time the server boots and no usable CDP profile exists yet
 * (and no existing CDP endpoint is alive to attach to). Every step of the
 * clone is surfaced via the logStream so the launcher UI can show:
 *
 *   "Initializing browser..."
 *   "Cloning browser profile..."
 *   "Preparing CDP endpoint..."
 *   "Almost ready..."
 *   "Server starting..."
 *
 * …instead of the app appearing frozen for 10–60 seconds while the copy
 * runs.
 *
 * ─── Try-first-then-clone (inviolable) ────────────────────────────────────
 *
 * Before spawning or cloning anything, CdpManager.start() probes the
 * configured CDP port and ADOPTS any Chrome that's already listening
 * there. So if `./scripts/launch-chrome.sh` is already running, or a
 * previous desktop session left Chrome up, the launcher reuses that
 * exact Chrome — no spawn, no clone. The project NEVER runs two CDP
 * Chromes side-by-side.
 */

const { shell } = require("electron");

class Lifecycle {
  constructor({ serverManager, cdpManager, envBootstrap, logStream }) {
    this.server = serverManager;
    this.cdp = cdpManager;
    this.env = envBootstrap;
    this.log = logStream;
  }

  isRunning() {
    return this.server.isRunning();
  }

  /**
   * One-click startup.
   *
   * IMPORTANT: The server is started FIRST and we wait for its port to accept
   * connections before opening any browser tab pointing at it. This avoids
   * the previous "Connection refused" race where Chrome would open
   * http://localhost:3000 before Express was ready to answer.
   *
   * ─── Authentication in the user's default browser (not inside Electron) ──
   *
   * The web app URL (http://localhost:3000) is opened in the user's DEFAULT
   * browser via `shell.openExternal`, NOT in the CDP Chrome. This is the key
   * change for "authentication in the browser, not inside Electron": the
   * user signs into the web app, signs into Google/Gemini, etc. in their
   * normal browser (where they're already comfortable and where their
   * existing sessions live). The CDP Chrome continues to run for automation
   * — it just doesn't host the web app UI anymore.
   *
   * ─── Structured progress events ──────────────────────────────────────────
   *
   * `onProgress(stage, message)` is called at each high-level stage of the
   * startup so the caller (e.g., the onboarding wizard) can render a real
   * progress screen with named steps instead of scraping log lines. The
   * stage values are stable identifiers — see the onboarding renderer for
   * the mapping from stage → user-facing label.
   *
   *   "start"         — initial banner
   *   "server"        — server boot (port wait)
   *   "browser"       — CDP Chrome init / attach
   *   "clone"         — deferred profile clone (first launch only)
   *   "endpoint"      — CDP endpoint preparation
   *   "open-webapp"   — opening the web app in the default browser
   *   "ready"         — final banner
   *
   * Error stages are suffixed with ":error" (e.g., "server:error") so the
   * renderer can show a failure indicator on the matching step.
   *
   * Flow:
   *   1. Start the server (waits for the port via ServerManager.waitForPort).
   *      → Progress is broadcast through the logStream AND onProgress so the
   *        launcher UI / onboarding wizard can show "Booting server...".
   *   2. Once the server is ready, start CDP Chrome — without a URL
   *      argument. The web app is NOT opened inside CDP Chrome anymore.
   *      This is where the deferred profile clone runs (if needed) —
   *      every step is broadcast via onProgress so the wizard can show
   *      "Cloning browser profile..." progress.
   *   3. Write BROWSER_MODE=cdp + CDP_ENDPOINT to .env so the server's
   *      automation layer picks them up on its next browser launch.
   *   4. Open the web app URL in the user's DEFAULT browser via
   *      shell.openExternal. The user signs in there.
   *
   * If CDP can't start (Chrome not installed), fall back to Playwright's
   * persistent browser mode but STILL open the web app in the default
   * browser — the user's auth flow is unaffected.
   *
   * ─── Visibility (Launch Sequence UX Strategy) ──────────────────────────
   *
   * `visible` controls whether the CDP Chrome draws a window on screen:
   *
   *   visible: false — Chrome is spawned headless. Used by onboarding's
   *     onOnboardingComplete() so the wizard's progress screen narrates
   *     background work (server boot, clone, endpoint ready) with ZERO
   *     surprise windows. The user never sees a Chrome window they didn't
   *     ask for.
   *
   *   visible: true (default) — Chrome is spawned with a visible window.
   *     Used when the user explicitly presses Start in the launcher (or
   *     the tray Quick Start). If CDP is already running headless (from
   *     onboarding), we RESTART it visibly so the user sees Chrome appear
   *     as a direct result of pressing Start — the first legitimate moment
   *     a visible browser window is expected.
   *
   * `openBrowser` controls whether the web app URL is opened in the user's
   * DEFAULT browser via shell.openExternal. During onboarding this is
   * false (no surprise browser windows); from the launcher Start it's
   * true (the user pressed Start, they want to use the app).
   */
  async startAll({ openBrowser = true, visible = true, onProgress } = {}) {
    const progress = (stage, message) => {
      try {
        this.log.append("lifecycle", message);
      } catch (_) {}
      try {
        if (typeof onProgress === "function") onProgress(stage, message);
      } catch (_) {}
    };

    progress("start", "Starting GTSS Growth Engine...");
    const port = this.server.port || 3000;
    const webAppUrl = `http://localhost:${port}`;

    // ─── 1. Start the server FIRST and wait for it to be ready ──────────
    if (!this.server.isRunning()) {
      progress("server", "Server starting...");
      progress("server", "Booting the Node.js server — waiting for the port to open...");
      try {
        await this.server.start({ port });
        progress("server", "Server ready.");
      } catch (err) {
        progress("server:error", `Server failed to start: ${err.message}`);
        throw err;
      }
    } else {
      progress("server", "Server already running — reusing it.");
    }

    // Give Express a short beat to finish mounting its routes after the
    // port accepts connections.
    await new Promise((r) => setTimeout(r, 400));

    // ─── 2. Start CDP Chrome (without a URL) ────────────────────────────
    //
    // CdpManager.start() first tries to ATTACH to an existing CDP endpoint
    // on the configured port (the "try first" half of the project's
    // inviolable pattern). If a Chrome is already up — e.g., the user ran
    // `./scripts/launch-chrome.sh` first, or a previous desktop session
    // left Chrome running — we adopt it and skip both the spawn and the
    // profile clone. Only if no endpoint answers do we spawn a new Chrome
    // (which in turn calls ensureCdpProfile() — the "clone if missing"
    // half — to copy the user's Default profile into the CDP profile dir
    // when no usable profile exists yet).
    let cdpActive = false;
    try {
      if (!this.cdp.isRunning()) {
        // ─── No CDP running: spawn fresh with requested visibility ──────
        //
        // visible: false → headless Chrome (onboarding background work).
        // visible: true  → visible Chrome (launcher Start / tray Quick
        //   Start). This is the first legitimate moment a visible browser
        //   window is expected and welcome.
        //
        // NOTE: We deliberately do NOT pass openUrl here. The web app is
        // opened in the user's DEFAULT browser (step 4 below) — not in
        // the CDP Chrome — so platform authentication happens where the
        // user is already comfortable. `openUrl` is opt-in per the
        // Launch Sequence UX Strategy guardrails.
        progress("browser", "Initializing browser...");
        await this.cdp.start({
          visible,
          onProgress: (stage, message) => {
            // Map CDP stage names to our high-level stages so the
            // onboarding wizard's progress UI can highlight the right step.
            if (stage === "clone") {
              progress("clone", message);
            } else if (stage === "clone:warning") {
              // Forward locked-Chrome warnings as a first-class
              // `clone:warning` stage so the onboarding renderer can show
              // a yellow "close Chrome and retry" callout with a Restart
              // Chrome button — instead of a buried log line.
              progress("clone:warning", message);
            } else if (stage === "ready") {
              if (/Reusing existing Chrome/i.test(message)) {
                progress("browser", "Reusing existing Chrome — no new browser spawned, no profile clone needed.");
              } else {
                progress("browser", "Browser ready.");
              }
            } else if (stage === "init" || stage === "endpoint" || stage === "almost-ready") {
              // Surface init / endpoint / almost-ready as part of the
              // browser stage (the wizard groups them under
              // "Initializing the automation browser").
              progress("browser", message);
            }
          },
        });
        cdpActive = true;
      } else if (visible && this.cdp.startedVisible === false) {
        // ─── Headless → visible transition ───────────────────────────────
        //
        // CDP is already running but was spawned HEADLESS by onboarding's
        // lifecycle.startAll({ visible: false }). The user has now pressed
        // Start in the launcher (visible: true) — the first legitimate
        // moment a visible browser window is expected. We restart CDP
        // visibly so Chrome appears on screen as a direct result of the
        // user's action. The --user-data-dir is unchanged, so the profile
        // cloned during onboarding (with all the user's logins) is
        // preserved across the restart.
        progress("browser", "Bringing Chrome to the foreground...");
        await this.cdp.stop("visibility-change");
        await this.cdp.start({
          visible: true,
          onProgress: (stage, message) => {
            if (stage === "ready") {
              progress("browser", "Browser ready (visible).");
            } else if (stage === "init" || stage === "endpoint" || stage === "almost-ready") {
              progress("browser", message);
            }
          },
        });
        cdpActive = true;
      } else {
        progress("browser", "CDP Chrome already running — reusing it.");
        cdpActive = true;
      }

      // Write CDP config to .env so the server's automation layer knows
      // where to connect.
      this.env.upsert("CDP_ENDPOINT", `http://127.0.0.1:${this.cdp.port}`);
      this.env.upsert("BROWSER_MODE", "cdp");
      progress("endpoint", `CDP active on port ${this.cdp.port}. Automation will use this Chrome.`);
    } catch (err) {
      progress("browser:error", `CDP Chrome failed to start: ${err.message}`);
      // ─── Isolated-browser fallback (NEW: dedicated warning stage) ───────
      //
      // Previously this emitted a plain "browser" progress line saying
      // "Falling back to isolated browser mode (Playwright Chromium)." —
      // which the onboarding renderer treated as just another browser
      // progress message and showed as a green checkmark on the
      // "Initializing the automation browser" step. The user would then
      // be surprised later when the missing-sessions modal insisted none
      // of their platforms were signed in (because the isolated browser
      // has no cloned cookies).
      //
      // Now we emit a dedicated `browser:warning` stage with a
      // self-contained message so the onboarding renderer shows a yellow
      // warning callout explaining the trade-off: automation will run in
      // an isolated Chromium, and the user will need to sign in to each
      // platform manually.
      const fallbackMsg =
        "Automation will run in an isolated Chromium browser — your existing " +
        "Chrome logins are NOT available. You'll need to sign in to LinkedIn, X, " +
        "Facebook, Instagram, and Google/Gemini manually inside the automation " +
        "browser when prompted.";
      progress("browser:warning", fallbackMsg);
      progress("browser", "Falling back to isolated browser mode (Playwright Chromium).");
      this.env.upsert("BROWSER_MODE", "persistent");
      this.env.upsert("CDP_ENDPOINT", "");
    }

    // ─── 3. Open the web app in the user's DEFAULT browser ─────────────
    //
    // This is the key change for "authentication in the browser, not
    // inside Electron". Previously, the web app was opened as a tab
    // inside the CDP Chrome that Electron spawned — which meant the user
    // signed into the web app and signed into Google/Gemini inside a
    // Chrome window that Electron controlled. That felt embedded and
    // caused issues with session transfer (Google's trusted-device state
    // doesn't carry over to a copied profile).
    //
    // Now the web app opens in the user's default browser (Firefox,
    // Safari, Edge, or their normal Chrome) via shell.openExternal. The
    // CDP Chrome still runs in the background for automation — it just
    // doesn't host the web app UI.
    if (openBrowser) {
      progress("open-webapp", `Opening ${webAppUrl} in your default browser...`);
      try {
        await shell.openExternal(webAppUrl);
        progress("open-webapp", "Web app opened in your default browser.");
      } catch (err) {
        progress("open-webapp:error", `Couldn't open the web app in your browser: ${err.message}. Open ${webAppUrl} manually.`);
      }
      progress("ready", cdpActive
        ? "Ready. The web app is open in your default browser; automation runs in the CDP Chrome."
        : "Ready. The web app is open in your default browser.");
    } else {
      // Onboarding path (openBrowser: false) — no surprise browser window.
      // The web app will be opened later, when the user presses Start in
      // the launcher. The progress screen narrates background readiness
      // only, per the Launch Sequence UX Strategy.
      progress("ready", cdpActive
        ? "Ready. Server and automation browser are running in the background."
        : "Ready. Server is running in the background.");
    }
  }

  async stopAll(reason = "user") {
    this.log.append("lifecycle", `Stopping services (reason: ${reason})...`);
    // Stop server first so it can clean up browser connections gracefully.
    if (this.server.isRunning()) {
      await this.server.stop(reason);
    }
    if (this.cdp.isRunning()) {
      await this.cdp.stop(reason);
    }
    this.log.append("lifecycle", "Services stopped.");
  }

  async restartAll() {
    this.log.append("lifecycle", "Restarting server...");
    if (this.server.isRunning()) {
      await this.server.restart();
    }
    this.log.append("lifecycle", "Server restarted.");
  }

  // ─── Server-only controls ──────────────────────────────────────────────

  async startServerOnly() {
    if (!this.server.isRunning()) {
      await this.server.start({ port: this.server.port || 3000 });
    }
  }

  async stopServerOnly() {
    if (this.server.isRunning()) {
      await this.server.stop("user-server-only");
    }
  }

  // ─── CDP-only controls ─────────────────────────────────────────────────
  //
  // These are for the rare case where the user wants to start/stop CDP
  // without restarting the server. In normal use, startAll() handles
  // everything.

  async startCdpOnly() {
    if (this.cdp.isRunning()) return;
    // User-initiated (advanced CDP-only control) → visible Chrome.
    // cdp.start() defaults to visible: true.
    await this.cdp.start();
    if (this.cdp.port) {
      this.env.upsert("CDP_ENDPOINT", `http://127.0.0.1:${this.cdp.port}`);
      this.env.upsert("BROWSER_MODE", "cdp");
      this.log.append("lifecycle", "Switched automation to CDP mode. Restarting server to apply...");
      if (this.server.isRunning()) {
        await this.server.restart();
      }
    }
  }

  async stopCdpOnly() {
    if (!this.cdp.isRunning()) return;
    await this.cdp.stop("user-cdp-only");
    this.env.upsert("BROWSER_MODE", "persistent");
    this.env.upsert("CDP_ENDPOINT", "");
    this.log.append("lifecycle", "Switched automation back to persistent mode. Restarting server to apply...");
    if (this.server.isRunning()) {
      await this.server.restart();
    }
  }

  /**
   * Open the web app in the user's DEFAULT browser.
   *
   * Previously this preferred to open a new tab in the running CDP Chrome
   * (via the DevTools HTTP API). That tied the user's web-app tab to the
   * CDP Chrome — which felt "embedded inside Electron" and caused session
   * confusion (Google/Gemini sessions signed into the CDP Chrome didn't
   * carry trusted-device state, etc.).
   *
   * Now we ALWAYS open in the user's default browser via shell.openExternal.
   * The CDP Chrome still runs for automation — it just doesn't host the
   * web app UI. This matches the "authentication in the browser, not
   * inside Electron" requirement.
   */
  async openWebApp() {
    const port = this.server.port || 3000;
    const url = `http://localhost:${port}`;
    await shell.openExternal(url);
  }


  getStatus() {
    return {
      server: this.server.getState(),
      cdp: this.cdp.getState(),
      running: this.isRunning(),
    };
  }
}

module.exports = { Lifecycle };
