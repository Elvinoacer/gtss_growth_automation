/**
 * Lifecycle — high-level orchestration of the server + CDP browser.
 *
 * Exposes the verbs the UI cares about:
 *   - startAll()    → start CDP, then server, then open browser to the app.
 *   - stopAll()     → stop server, then stop CDP.
 *   - restartAll()  → restart both.
 *   - getStatus()   → snapshot of everything for the UI.
 *
 * The "one-click startup" the vision describes lives in startAll(): the user
 * clicks Start, and we orchestrate Chrome → server → health check → open
 * browser, surfacing progress through the LogStream so the UI can show it.
 */

const { shell } = require("electron");

class Lifecycle {
  constructor({ serverManager, cdpManager, logStream }) {
    this.server = serverManager;
    this.cdp = cdpManager;
    this.log = logStream;
  }

  isRunning() {
    return this.server.isRunning() || this.cdp.isRunning();
  }

  async startAll({ openBrowser = true } = {}) {
    this.log.append("lifecycle", "Starting GTSS Growth Engine...");
    const port = this.server.port || 3000;

    // 1. Start CDP Chrome first — the server connects to it on startup.
    try {
      if (!this.cdp.isRunning()) {
        await this.cdp.start();
        // Propagate the CDP endpoint into the .env so the server picks it up.
        if (this.cdp.port && this.envBootstrapUpserter) {
          this.envBootstrapUpserter("CDP_ENDPOINT", `http://127.0.0.1:${this.cdp.port}`);
          this.envBootstrapUpserter("BROWSER_MODE", "cdp");
        }
      }
    } catch (err) {
      this.log.append("lifecycle:warn", `CDP did not start: ${err.message}. Continuing without CDP — automation will run in persistent-profile mode.`);
      // Non-fatal — the server can still run; it'll fall back to
      // BROWSER_MODE=persistent. The user just won't have CDP automation.
    }

    // 2. Start the server.
    if (!this.server.isRunning()) {
      await this.server.start({ port });
    }

    // 3. Health-check the server (the waitForPort in start() already
    //    confirmed it's listening — give it an extra second to settle).
    await new Promise((r) => setTimeout(r, 500));

    // 4. Open the default browser to the app URL.
    if (openBrowser) {
      const url = `http://localhost:${port}`;
      this.log.append("lifecycle", `Opening ${url} in your default browser...`);
      await shell.openExternal(url);
    }

    this.log.append("lifecycle", "All services started. Ready.");
  }

  async stopAll(reason = "user") {
    this.log.append("lifecycle", `Stopping all services (reason: ${reason})...`);
    // Stop server first so it can clean up browser connections gracefully.
    if (this.server.isRunning()) {
      await this.server.stop(reason);
    }
    if (this.cdp.isRunning()) {
      await this.cdp.stop(reason);
    }
    this.log.append("lifecycle", "All services stopped.");
  }

  async restartAll() {
    this.log.append("lifecycle", "Restarting all services...");
    if (this.server.isRunning()) {
      await this.server.restart();
    }
    if (this.cdp.isRunning()) {
      await this.cdp.restart();
    }
    this.log.append("lifecycle", "All services restarted.");
  }

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

  async startCdpOnly() {
    if (!this.cdp.isRunning()) {
      await this.cdp.start();
    }
  }

  async stopCdpOnly() {
    if (this.cdp.isRunning()) {
      await this.cdp.stop("user-cdp-only");
    }
  }

  getStatus() {
    return {
      server: this.server.getState(),
      cdp: this.cdp.getState(),
      running: this.isRunning(),
    };
  }

  /** Allow external code (main.js) to inject the env upsert callback. */
  setEnvUpserter(fn) {
    this.envBootstrapUpserter = fn;
  }
}

module.exports = { Lifecycle };
