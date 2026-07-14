/**
 * bridge-server/bridgeServerClass.js
 *
 * The BridgeServer class skeleton — constructor + start/stop lifecycle +
 * the HTTP request pipeline (_handle → _route dispatcher). The actual
 * route handlers live in routeHandlers.js (imported here and dispatched
 * from _route). The four sentinel helpers (_sentinelPath /
 * _isSigninComplete / _markSigninComplete / _clearSigninComplete) are
 * defined inline here since they're small and tightly coupled with the
 * class's instance state (this.env.dataRoot, this.log).
 *
 * The split files live one directory deeper than the original
 * bridge-server.js, so the original `require("fs")` / `require("path")`
 * / `require("http")` (all Node built-ins, unaffected by directory
 * moves) are unchanged.
 *
 * File manifest:
 *   constants.js          — DEFAULT_PORT, PLATFORMS
 *   routeHandlers.js      — every route handler + dispatchRoute()
 *   bridgeServerClass.js  — this file: BridgeServer class
 *   index.js              — re-exports { BridgeServer, DEFAULT_BRIDGE_PORT }
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const { DEFAULT_PORT } = require("./constants");
const { dispatchRoute } = require("./routeHandlers");

class BridgeServer {
  constructor({ lifecycle, cdpManager, envBootstrap, firstRun, logStream }) {
    this.lifecycle = lifecycle;
    this.cdp = cdpManager;
    this.env = envBootstrap;
    this.firstRun = firstRun;
    this.log = logStream;
    this.server = null;
    this.port = DEFAULT_PORT;
  }

  /**
   * Start listening. Resolves once the server is bound. If the configured
   * port is taken, tries the next few ports before giving up.
   */
  async start(port = DEFAULT_PORT) {
    this.port = port;
    return new Promise((resolve, reject) => {
      const tryListen = (p) => {
        const srv = http.createServer((req, res) => this._handle(req, res));
        srv.once("error", (err) => {
          if (err.code === "EADDRINUSE" && p < port + 10) {
            // Port taken — try the next one. We still expose the actual
            // port via this.port so the web app can discover it through
            // /api/bridge/state on the eventual listening port.
            tryListen(p + 1);
          } else {
            reject(err);
          }
        });
        srv.listen(p, "127.0.0.1", () => {
          this.server = srv;
          this.port = p;
          try {
            this.log.append("lifecycle", `Bridge server listening on http://127.0.0.1:${p}`);
          } catch (_) {}
          resolve(p);
        });
      };
      tryListen(port);
    });
  }

  async stop() {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  // ─── Request handling ──────────────────────────────────────────────────

  async _handle(req, res) {
    // CORS — allow the web app (localhost:3000) and any localhost origin.
    const origin = req.headers.origin || "";
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    } else {
      // For non-browser clients (curl) or no origin, allow * — loopback only.
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const pathname = url.pathname;

    // Read JSON body for POST.
    let body = null;
    if (req.method === "POST" || req.method === "PUT") {
      body = await this._readJson(req).catch(() => null);
    }

    try {
      const result = await this._route(req.method, pathname, body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
    }
  }

  _readJson(req) {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
        if (data.length > 64 * 1024) {
          reject(new Error("Body too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (!data) return resolve(null);
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", reject);
    });
  }

  async _route(method, pathname, body) {
    return dispatchRoute(method, pathname, body, this);
  }

  // ─── Sentinel helpers ──────────────────────────────────────────────────
  //
  // The .signin-completed sentinel marks "the user has gone through the
  // first-time sign-in flow at least once". While it's absent, the
  // launcher's Start button uses the visible-CDP + open-web-app-in-CDP
  // flow so the sign-in modal on the web app's root page can drive logins
  // inside the automation browser. Once it exists, Start uses the normal
  // flow (background CDP + web app in default browser) unless the user
  // changed the browser-mode setting or sessions are still missing.

  _sentinelPath() {
    return path.join(this.env.dataRoot, ".signin-completed");
  }

  _isSigninComplete() {
    try {
      return fs.existsSync(this._sentinelPath());
    } catch (_) {
      return false;
    }
  }

  _markSigninComplete() {
    try {
      fs.writeFileSync(this._sentinelPath(), new Date().toISOString(), {
        mode: 0o600,
      });
    } catch (err) {
      try {
        this.log.append("lifecycle:stderr", `Could not write signin sentinel: ${err.message}`);
      } catch (_) {}
    }
  }

  _clearSigninComplete() {
    try {
      if (fs.existsSync(this._sentinelPath())) {
        fs.unlinkSync(this._sentinelPath());
      }
    } catch (_) {}
  }
}

module.exports = { BridgeServer };
