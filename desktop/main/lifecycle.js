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
   * 1. Start CDP Chrome with the web app URL — Chrome opens localhost:3000
   *    in a tab AND exposes the CDP endpoint on port 9222.
   * 2. Write BROWSER_MODE=cdp + CDP_ENDPOINT to .env.
   * 3. Start the server — it connects to the CDP endpoint for automation.
   *
   * If CDP can't start (Chrome not installed), fall back to persistent mode
   * and open the web app in the default browser.
   */
  async startAll({ openBrowser = true } = {}) {
    this.log.append("lifecycle", "Starting GTSS Growth Engine...");
    const port = this.server.port || 3000;
    const webAppUrl = `http://localhost:${port}`;

    // ─── 1. Start CDP Chrome with the web app URL ────────────────────────
    let cdpActive = false;
    try {
      if (!this.cdp.isRunning()) {
        this.log.append("lifecycle", "Launching Chrome (with CDP + web app)...");
        await this.cdp.start({ openUrl: openBrowser ? webAppUrl : undefined });
        cdpActive = true;
      } else {
        // CDP already running — just open a new tab with the web app URL.
        if (openBrowser) {
          const ok = await this.cdp.openTab(webAppUrl);
          if (!ok) {
            this.log.append("lifecycle:stderr", "Couldn't open a new tab in CDP Chrome. Open it manually.");
          }
        }
        cdpActive = true;
      }

      // ─── 2. Write CDP config to .env ───────────────────────────────────
      this.env.upsert("CDP_ENDPOINT", `http://127.0.0.1:${this.cdp.port}`);
      this.env.upsert("BROWSER_MODE", "cdp");
      this.log.append("lifecycle", `CDP active on port ${this.cdp.port}. Automation will use this Chrome.`);
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

    // ─── 3. Start the server ─────────────────────────────────────────────
    if (!this.server.isRunning()) {
      await this.server.start({ port });
    }

    // Give Express a beat to finish mounting routes.
    await new Promise((r) => setTimeout(r, 400));

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
