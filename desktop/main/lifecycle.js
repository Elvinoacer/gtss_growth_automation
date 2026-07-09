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
   * Flow:
   *   1. Start the server (waits for the port via ServerManager.waitForPort).
   *      → Progress is broadcast through the logStream so the launcher UI can
   *        show "Booting server..." messages while it spins up.
   *   2. Once the server is ready, start CDP Chrome — but WITHOUT a URL
   *      argument (so Chrome doesn't open a tab too early). After Chrome is
   *      ready, we open the web app URL in a new tab via the CDP HTTP API.
   *      This is also where the deferred profile clone runs (if needed) —
   *      the launcher UI shows live "Cloning browser profile..." progress.
   *   3. Write BROWSER_MODE=cdp + CDP_ENDPOINT to .env so the server's
   *      automation layer picks them up on its next browser launch.
   *
   * If CDP can't start (Chrome not installed), fall back to opening the web
   * app in the user's default browser.
   */
  async startAll({ openBrowser = true } = {}) {
    this.log.append("lifecycle", "Starting GTSS Growth Engine...");
    const port = this.server.port || 3000;
    const webAppUrl = `http://localhost:${port}`;

    // ─── 1. Start the server FIRST and wait for it to be ready ──────────
    //
    // This is the key fix for the "Connection refused" race: previously we
    // opened the URL in CDP Chrome before Express had even bound to the port,
    // so the user saw a blank "This site can't be reached" page on every
    // launch. Now we block until the server's port accepts TCP connections.
    if (!this.server.isRunning()) {
      this.log.append("lifecycle", "Server starting...");
      this.log.append("lifecycle", "Booting the Node.js server — waiting for the port to open...");
      try {
        await this.server.start({ port });
      } catch (err) {
        // ServerManager.start() already records a diagnostic and leaves the
        // state as "starting" or "crashed" — we just surface the message
        // here and abort the rest of the flow. The launcher UI's error card
        // will show the actionable remedy.
        this.log.append("lifecycle:stderr", `Server failed to start: ${err.message}`);
        throw err;
      }
    } else {
      this.log.append("lifecycle", "Server already running — reusing it.");
    }

    // Give Express a short beat to finish mounting its routes after the
    // port accepts connections (the port being open only means listen() has
    // returned, not that middleware is fully wired up).
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
        this.log.append("lifecycle", "Initializing browser...");
        // NOTE: We deliberately do NOT pass openUrl here. We open the URL
        // AFTER Chrome's CDP endpoint is up so the tab doesn't hit a
        // half-ready server.
        //
        // The (potentially slow) profile clone happens INSIDE cdp.start()
        // via ensureCdpProfile() — every step is broadcast to the logStream
        // so the launcher UI can show "Cloning browser profile..." etc.
        // If cdp.start() attached to an existing Chrome, no clone runs.
        await this.cdp.start({
          onProgress: (stage, message) => {
            // The CdpManager already appends each message to the logStream,
            // but we also surface a high-level lifecycle banner for the
            // stages the user cares about so the launcher's status hero
            // can show a friendly progress label.
            if (stage === "clone") {
              this.log.append("lifecycle", message);
            } else if (stage === "ready") {
              // Distinguish "we attached to an existing Chrome" from
              // "we spawned a fresh one" so the launcher UI can show the
              // right messaging. The attach path logs "Reusing existing
              // Chrome..." which we surface verbatim.
              if (/Reusing existing Chrome/i.test(message)) {
                this.log.append("lifecycle", "Reusing existing Chrome — no new browser spawned, no profile clone needed.");
              } else {
                this.log.append("lifecycle", "Browser ready.");
              }
            }
          },
        });
        cdpActive = true;
      } else {
        this.log.append("lifecycle", "CDP Chrome already running — reusing it.");
        cdpActive = true;
      }

      // Write CDP config to .env so the server's automation layer knows
      // where to connect.
      this.env.upsert("CDP_ENDPOINT", `http://127.0.0.1:${this.cdp.port}`);
      this.env.upsert("BROWSER_MODE", "cdp");
      this.log.append("lifecycle", `CDP active on port ${this.cdp.port}. Automation will use this Chrome.`);

      // Open the web app URL in a new tab now that both Chrome AND the
      // server are ready.
      if (openBrowser) {
        const ok = await this.cdp.openTab(webAppUrl);
        if (!ok) {
          this.log.append("lifecycle:stderr", "Couldn't open a new tab in CDP Chrome. Open it manually.");
        }
      }
    } catch (err) {
      this.log.append("lifecycle:stderr", `CDP Chrome failed to start: ${err.message}`);
      this.log.append("lifecycle", "Falling back to isolated browser mode (Playwright Chromium).");
      this.env.upsert("BROWSER_MODE", "persistent");
      this.env.upsert("CDP_ENDPOINT", "");

      // Open the web app in the default browser as fallback.
      if (openBrowser) {
        this.log.append("lifecycle", `Opening ${webAppUrl} in your default browser...`);
        await shell.openExternal(webAppUrl);
      }
    }

    if (cdpActive) {
      this.log.append("lifecycle", "Ready. The web app is open in the CDP Chrome window.");
    } else {
      this.log.append("lifecycle", "Ready. The web app is open in your default browser.");
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
   * Open the web app. If CDP Chrome is running, open a new tab in it.
   * Otherwise, open in the user's default browser.
   */
  async openWebApp() {
    const port = this.server.port || 3000;
    const url = `http://localhost:${port}`;
    if (this.cdp.isRunning()) {
      const ok = await this.cdp.openTab(url);
      if (ok) return;
    }
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
