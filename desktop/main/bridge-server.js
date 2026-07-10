/**
 * BridgeServer — a tiny localhost-only HTTP server that lets the web app
 * (localhost:3000) control the CDP Chrome that the Electron main process
 * owns.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────
 *
 * The sign-in modal used to live inside the Electron launcher (the desktop
 * renderer). It opened platform login pages in the user's DEFAULT browser
 * via shell.openExternal — which meant fresh cookies never reached the CDP
 * Chrome that actually runs automation (not until a profile clone ran).
 *
 * The new UX (per project requirements) moves the sign-in modal onto the
 * web app's root page ("/"). When the user clicks a platform there, the
 * login page must open INSIDE the CDP Chrome — the same browser that
 * automation uses — so cookies land in the right place immediately. But
 * the web app runs in a separate process (the forked Node server) and has
 * no way to tell Electron "start Chrome visibly and open this URL".
 *
 * This bridge is that channel. The web app's frontend calls it via fetch
 * (http://127.0.0.1:9224/...); the bridge translates each request into a
 * call on the existing CdpManager / EnvBootstrap / FirstRun instances.
 *
 * ─── Security ────────────────────────────────────────────────────────────
 *
 *   - Binds to 127.0.0.1 ONLY. Never reachable from the network.
 *   - CORS is permissive for localhost origins (the web app is on
 *     localhost:3000). A remote page cannot reach 127.0.0.1:9224 from a
 *     browser anyway (mixed-origin / loopback restrictions), and even if
 *     it could, the bridge only controls the local CDP Chrome.
 *   - No auth token. This is a local-first app; the bridge is a private
 *     RPC between two processes on the same machine. Adding a token would
 *     mean the web app server has to know it and inject it into the
 *     frontend, which adds complexity for no real security gain on a
 *     loopback-only socket.
 *
 * ─── Endpoints ───────────────────────────────────────────────────────────
 *
 *   GET  /api/bridge/state
 *        → { cdp: {...}, sessions: {...}|null, signinCompleted: bool,
 *           browserMode: "background"|"visible", firstRunRequired: bool }
 *
 *   GET  /api/bridge/cdp/sessions
 *        → { ok, sessions, running }
 *
 *   POST /api/bridge/cdp/ensure-visible
 *        Ensures the shared CDP Chrome is running VISIBLY. If CDP is not
 *        running, starts it visibly. If CDP is running headless, restarts
 *        it visibly. If already visible, no-op. Used by the server-side
 *        createBrowser() when a login session is launched in CDP mode —
 *        guarantees the login tab is always shown to the user.
 *        → { ok, cdpState, cdpEndpoint }
 *
 *   POST /api/bridge/cdp/open-login   body: { platform: "linkedin"|... }
 *        Ensures CDP is running VISIBLY (starts it if needed), then opens
 *        the platform's login URL in a new tab of the CDP Chrome. Returns
 *        { ok, cdpState }.
 *
 *   POST /api/bridge/cdp/restart
 *        Restarts CDP (re-runs the profile clone so fresh cookies from the
 *        user's real Chrome are picked up). Keeps the server running.
 *
 *   POST /api/bridge/cdp/open-webapp-in-cdp
 *        Opens http://localhost:3000 in a new tab of the running CDP
 *        Chrome. Used when the web app is currently loaded in the user's
 *        default browser but the user wants to switch into the CDP Chrome
 *        to sign in (cookies set there are the ones automation uses).
 *
 *   GET  /api/bridge/settings/browser-mode
 *        → { mode: "background"|"visible" }
 *
 *   POST /api/bridge/settings/browser-mode   body: { mode }
 *        Writes CDP_VISIBLE_DEFAULT into .env. Takes effect on the next
 *        launcher Start (does not restart CDP immediately).
 *
 *   POST /api/bridge/signin/complete
 *        Writes the .signin-completed sentinel so subsequent Starts use
 *        the normal (background) flow instead of the first-time visible
 *        flow.
 *
 *   GET  /api/bridge/health
 *        → { ok: true }  (lightweight liveness check)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const DEFAULT_PORT = 9224;

// Mirror of MODAL_SESSION_PLATFORMS in the old launcher renderer + the
// SESSION_COOKIE_SIGNATURES / PLATFORM_LOGIN_URLS in cdp-manager. Kept here
// so the bridge can answer "which platforms are required" without the web
// app having to duplicate the list.
const PLATFORMS = [
  { key: "google",    label: "Google / Gemini", required: true,  loginUrl: "https://gemini.google.com/" },
  { key: "linkedin",  label: "LinkedIn",        required: true,  loginUrl: "https://www.linkedin.com/" },
  { key: "facebook",  label: "Facebook",        required: false, loginUrl: "https://www.facebook.com/" },
  { key: "x",         label: "X (Twitter)",     required: false, loginUrl: "https://x.com/" },
  { key: "instagram", label: "Instagram",       required: false, loginUrl: "https://www.instagram.com/" },
];

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
    // ─── Health ──────────────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/bridge/health") {
      return { ok: true, ts: Date.now() };
    }

    // ─── State (everything the web app's sign-in modal needs in one call)
    if (method === "GET" && pathname === "/api/bridge/state") {
      const env = this.env.readEnv();
      const browserMode =
        String(env.CDP_VISIBLE_DEFAULT || "").toLowerCase() === "true"
          ? "visible"
          : "background";
      const signinCompleted = this._isSigninComplete();
      const firstRunRequired = await this.firstRun.isRequired();
      let sessions = null;
      if (this.cdp.isRunning()) {
        try {
          sessions = await this.cdp.checkSessions();
        } catch (_) {
          sessions = null;
        }
      }
      return {
        ok: true,
        cdp: this.cdp.getState(),
        sessions,
        platforms: PLATFORMS,
        signinCompleted,
        firstRunRequired,
        browserMode,
        bridgePort: this.port,
      };
    }

    // ─── Sessions ────────────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/bridge/cdp/sessions") {
      if (!this.cdp.isRunning()) {
        return { ok: true, sessions: null, running: false };
      }
      const sessions = await this.cdp.checkSessions();
      return { ok: true, sessions, running: true };
    }

    // ─── Ensure CDP is visible (login-session helper) ────────────────────
    //
    // Called by the server-side createBrowser() when a LOGIN session is
    // being launched in CDP mode. The server can't restart CDP itself
    // (it doesn't own the Chrome child process), so it asks the bridge
    // to make sure Chrome is running VISIBLY before the login tab opens.
    //
    // This is the heart of the "login sessions always show the browser"
    // contract:
    //   - If CDP is NOT running → start it visibly.
    //   - If CDP is running but headless (startedVisible === false) →
    //     restart it visibly so the login tab appears in a window the
    //     user can interact with.
    //   - If CDP is already running visibly → no-op (return ok).
    //
    // Cookies set during the login land directly in the CDP Chrome's
    // profile — the same one automation uses — so no profile clone is
    // needed for the session to "take".
    //
    // Returns { ok: true } on success, { ok: false, error } on failure.
    // The caller (createBrowser) treats a false/missing ok as "bridge
    // could not make CDP visible" and falls back to a visible persistent
    // browser so the login window is STILL shown.
    if (method === "POST" && pathname === "/api/bridge/cdp/ensure-visible") {
      try {
        if (!this.cdp.isRunning()) {
          this.log.append("lifecycle", "Bridge: starting CDP visibly for login session...");
          await this.cdp.start({
            skipProfileCopy: false,
            visible: true,
            onProgress: (_stage, message) => {
              try { this.log.append("cdp", message); } catch (_) {}
            },
          });
          this.env.upsert("CDP_ENDPOINT", `http://127.0.0.1:${this.cdp.port}`);
          this.env.upsert("BROWSER_MODE", "cdp");
        } else if (this.cdp.startedVisible === false) {
          // CDP is running headless — restart visibly so the user can
          // see the login tab. This is the key fix for the "sometimes
          // the browser shows, sometimes it doesn't" abnormality: when
          // the launcher started Chrome in background mode (per the
          // user's Settings → Automation Browser = "Background" choice)
          // and the user then clicks Login / Re-authenticate on the
          // dashboard modal, we bring Chrome to the foreground so the
          // login tab is visible.
          this.log.append("lifecycle", "Bridge: bringing headless Chrome to the foreground for login session...");
          await this.cdp.stop("bridge-login-visibility");
          await this.cdp.start({
            visible: true,
            onProgress: (_stage, message) => {
              try { this.log.append("cdp", message); } catch (_) {}
            },
          });
        } else {
          // Already running visibly — nothing to do.
          this.log.append("lifecycle", "Bridge: CDP already visible for login session.");
        }
        return {
          ok: true,
          cdpState: this.cdp.getState(),
          cdpEndpoint: this.cdp.isRunning()
            ? `http://127.0.0.1:${this.cdp.port}`
            : null,
        };
      } catch (err) {
        this.log.append("lifecycle:stderr", `Bridge: ensure-visible failed: ${err.message}`);
        return { ok: false, error: err.message };
      }
    }

    // ─── Open a platform login tab in the CDP Chrome ─────────────────────
    //
    // This is the heart of the new sign-in flow. The web app's modal calls
    // this when the user clicks "Open in Chrome" on a platform card. We:
    //   1. Make sure CDP is running — if not, start it VISIBLY (the user is
    //      about to log in, they need to see the window).
    //   2. If CDP is running but headless, restart it visibly so the login
    //      tab appears in a window the user can interact with.
    //   3. Open the platform's login URL in a new tab of the CDP Chrome.
    //
    // Cookies set during this login land directly in the CDP Chrome's
    // profile — the same one automation uses — so no profile clone is
    // needed for the session to "take".
    if (method === "POST" && pathname === "/api/bridge/cdp/open-login") {
      const platform = body && body.platform;
      const p = PLATFORMS.find((x) => x.key === platform);
      if (!p) throw new Error(`Unknown platform: ${platform}`);

      // Ensure CDP is up + visible.
      if (!this.cdp.isRunning()) {
        try {
          this.log.append("lifecycle", `Bridge: starting CDP visibly for ${p.label} sign-in...`);
          await this.cdp.start({
            skipProfileCopy: false,
            visible: true,
            onProgress: (_stage, message) => {
              try { this.log.append("cdp", message); } catch (_) {}
            },
          });
          this.env.upsert("CDP_ENDPOINT", `http://127.0.0.1:${this.cdp.port}`);
          this.env.upsert("BROWSER_MODE", "cdp");
        } catch (err) {
          return { ok: false, error: `Could not start Chrome: ${err.message}` };
        }
      } else if (this.cdp.startedVisible === false) {
        // CDP is running headless — restart visibly so the user can see
        // the login tab.
        try {
          this.log.append("lifecycle", "Bridge: bringing headless Chrome to the foreground for sign-in...");
          await this.cdp.stop("bridge-visibility-change");
          await this.cdp.start({
            visible: true,
            onProgress: (_stage, message) => {
              try { this.log.append("cdp", message); } catch (_) {}
            },
          });
        } catch (err) {
          return { ok: false, error: `Could not bring Chrome to foreground: ${err.message}` };
        }
      }

      const ok = await this.cdp.openTab(p.loginUrl);
      if (!ok) {
        return { ok: false, error: `Could not open ${p.label} login tab in the CDP Chrome.` };
      }
      this.log.append("lifecycle", `Bridge: opened ${p.label} login tab in CDP Chrome.`);
      return { ok: true, cdpState: this.cdp.getState(), loginUrl: p.loginUrl };
    }

    // ─── Restart CDP (re-clone profile) ──────────────────────────────────
    if (method === "POST" && pathname === "/api/bridge/cdp/restart") {
      const visible = body && typeof body.visible === "boolean"
        ? body.visible
        : true;
      try {
        await this.cdp.restart({
          visible,
          onProgress: (_stage, message) => {
            try { this.log.append("cdp", message); } catch (_) {}
          },
        });
        this.env.upsert("CDP_ENDPOINT", `http://127.0.0.1:${this.cdp.port}`);
        this.env.upsert("BROWSER_MODE", "cdp");
        return { ok: true, cdpState: this.cdp.getState() };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    // ─── Open the web app inside the CDP Chrome ──────────────────────────
    //
    // Used when the web app is currently loaded in the user's default
    // browser (the normal post-setup flow) but the user wants to sign in /
    // re-authenticate — clicking this switches them INTO the CDP Chrome
    // where cookies set during login are the ones automation uses.
    if (method === "POST" && pathname === "/api/bridge/cdp/open-webapp-in-cdp") {
      const port = (this.lifecycle.server && this.lifecycle.server.port) || 3000;
      const webAppUrl = `http://localhost:${port}`;
      if (!this.cdp.isRunning()) {
        try {
          await this.cdp.start({
            visible: true,
            onProgress: (_stage, message) => {
              try { this.log.append("cdp", message); } catch (_) {}
            },
          });
          this.env.upsert("CDP_ENDPOINT", `http://127.0.0.1:${this.cdp.port}`);
          this.env.upsert("BROWSER_MODE", "cdp");
        } catch (err) {
          return { ok: false, error: `Could not start Chrome: ${err.message}` };
        }
      } else if (this.cdp.startedVisible === false) {
        try {
          await this.cdp.stop("bridge-visibility-change");
          await this.cdp.start({ visible: true });
        } catch (err) {
          return { ok: false, error: `Could not bring Chrome to foreground: ${err.message}` };
        }
      }
      const ok = await this.cdp.openTab(webAppUrl);
      return { ok, webAppUrl };
    }

    // ─── Browser-mode setting ────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/bridge/settings/browser-mode") {
      const env = this.env.readEnv();
      const mode =
        String(env.CDP_VISIBLE_DEFAULT || "").toLowerCase() === "true"
          ? "visible"
          : "background";
      return { ok: true, mode };
    }

    if (method === "POST" && pathname === "/api/bridge/settings/browser-mode") {
      const mode = body && body.mode;
      if (mode !== "background" && mode !== "visible") {
        throw new Error("mode must be 'background' or 'visible'");
      }
      this.env.upsert("CDP_VISIBLE_DEFAULT", mode === "visible" ? "true" : "false");
      this.log.append("lifecycle", `Bridge: browser mode set to '${mode}' (applies on next Start).`);
      return { ok: true, mode };
    }

    // ─── Mark sign-in complete ───────────────────────────────────────────
    if (method === "POST" && pathname === "/api/bridge/signin/complete") {
      this._markSigninComplete();
      return { ok: true };
    }

    // ─── Clear sign-in sentinel (re-trigger first-time flow) ─────────────
    if (method === "POST" && pathname === "/api/bridge/signin/reset") {
      this._clearSigninComplete();
      return { ok: true };
    }

    // Unknown route.
    return { ok: false, error: `Not found: ${method} ${pathname}` };
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

module.exports = { BridgeServer, DEFAULT_BRIDGE_PORT: DEFAULT_PORT };
