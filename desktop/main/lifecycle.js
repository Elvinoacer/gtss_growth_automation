/**
 * Lifecycle — high-level orchestration of the server + CDP browser.
 *
 * ─── Strategy revision ─────────────────────────────────────────────────────
 *
 * The "one-click Start" the user wants is just: start the server, then open
 * the browser to localhost:PORT. That's it. The web app at localhost:PORT is
 * the actual application — it handles logins, settings, automation, etc.
 *
 * CDP is NOT auto-started. The project's default is BROWSER_MODE=persistent,
 * which means Playwright launches its own isolated Chromium per platform and
 * the user logs in via the web app's Settings → Platform Sessions. CDP is
 * an advanced opt-in for power users who want to use their REAL Chrome (with
 * existing logins) instead of Playwright's isolated Chromium. We never
 * override the user's BROWSER_MODE setting.
 *
 * When the user explicitly clicks "Start CDP" (granular control), we:
 *   1. Launch Chrome with --remote-debugging-port.
 *   2. Write CDP_ENDPOINT and BROWSER_MODE=cdp into the .env.
 *   3. Restart the server so it picks up the new BROWSER_MODE.
 *
 * When the user clicks "Stop CDP", we:
 *   1. Stop Chrome.
 *   2. Reset BROWSER_MODE=persistent in .env.
 *   3. Restart the server.
 *
 * This way the user is always in control of which browser mode is active.
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
   * One-click startup. Starts the server and opens the user's default
   * browser to the web app. Does NOT touch CDP — the user opts into CDP
   * separately via the granular controls if they want it.
   */
  async startAll({ openBrowser = true } = {}) {
    this.log.append("lifecycle", "Starting GTSS Growth Engine...");

    const port = this.server.port || 3000;

    if (!this.server.isRunning()) {
      await this.server.start({ port });
    }

    // Give Express a beat to finish mounting routes.
    await new Promise((r) => setTimeout(r, 400));

    if (openBrowser) {
      const url = `http://localhost:${port}`;
      this.log.append("lifecycle", `Opening ${url} in your default browser...`);
      await shell.openExternal(url);
    }

    this.log.append("lifecycle", "Server is ready. The web app should now be open in your browser.");
  }

  async stopAll(reason = "user") {
    this.log.append("lifecycle", `Stopping services (reason: ${reason})...`);
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

  // ─── CDP controls (advanced, opt-in) ───────────────────────────────────
  //
  // Starting CDP also flips BROWSER_MODE=cdp in the .env and restarts the
  // server so it picks up the new mode. Stopping CDP reverts to persistent
  // mode.

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

  getStatus() {
    return {
      server: this.server.getState(),
      cdp: this.cdp.getState(),
      running: this.isRunning(),
    };
  }
}

module.exports = { Lifecycle };
