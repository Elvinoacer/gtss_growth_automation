/**
 * CdpManager — cross-platform port of scripts/launch-chrome.sh.
 *
 * Launches the user's REAL Chrome with --remote-debugging-port so GTSS
 * automation can connect via CDP without tripping bot-detection. Uses a
 * separate user-data-dir (required by Chrome for remote debugging) but
 * copies the user's Default profile on first launch so they stay logged
 * into LinkedIn, X, Facebook, and Instagram.
 *
 * ─── Try-first-then-clone pattern (inviolable) ─────────────────────────────
 *
 * The project NEVER launches a second Chrome when one is already alive on
 * the CDP port. The same Chrome that `scripts/launch-chrome.sh` launches,
 * or that the desktop app launched on a previous run, or that the user
 * launched manually for debugging, is reused across the entire project —
 * web app, automation layer, and desktop launcher all share ONE Chrome.
 *
 *   1. start() first calls _tryAttachExisting() which hits /json/version
 *      on the configured port. If a Chrome answers, we adopt it: state
 *      flips to "running" with no spawn, no clone. (We do NOT own the
 *      child process in this case, so stop() won't kill it — that's
 *      intentional; the user owns it.)
 *   2. If no endpoint is reachable, we spawn Chrome ourselves. Before
 *      spawning, ensureCdpProfile() checks if the CDP profile dir already
 *      has a populated Default/Cookies. If yes, reuse it (preserves
 *      sessions from previous launches). If no, clone from the user's
 *      real Chrome profile. This is the "clone if missing" half.
 *
 * Behaviour when no Chrome is installed: log an error and tell the user
 * to install Google Chrome (we intentionally do NOT bundle Chrome to keep
 * the installer small and respect Google's distribution terms).
 *
 * Session checking:
 *   - checkSessions() opens a transient CDP WebSocket to the running Chrome
 *     and calls Network.getAllCookies, then reports which platforms have
 *     active login cookies. Used by the post-Start "missing sessions"
 *     modal in the launcher to prompt the user to sign in to LinkedIn,
 *     Facebook, X, Instagram, and Google (Gemini) — logins always happen
 *     in the SAME Chrome that handles automation, never a new one.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const http = require("http");
const { EventEmitter } = require("events");

// ─── Session-detection config ───────────────────────────────────────────────
//
// Cookie names per platform. We require AT LEAST one auth cookie per platform
// to consider the session "live". These are the same cookies the platforms
// themselves use to identify an authenticated browser session, so presence of
// any one of them is a strong signal the user is logged in.
//
// Gemini (Google) is special: the copied CDP profile does NOT inherit the
// trusted-machine state for Google, so Gemini web (gemini.google.com) will
// refuse to operate until the user signs into at least one Google account
// FROM INSIDE the CDP Chrome. That's why onboarding gates completion on the
// google session being detected.
const SESSION_COOKIE_SIGNATURES = {
  google: {
    label: "Google (Gemini)",
    domains: [".google.com", "google.com", ".accounts.google.com"],
    cookies: ["SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID", "LSID"],
    requiredFor: "Gemini image generation in the CDP Chrome",
  },
  linkedin: {
    label: "LinkedIn",
    domains: [".linkedin.com", "linkedin.com"],
    cookies: ["li_at", "liap", "JSESSIONID", "bscookie"],
  },
  facebook: {
    label: "Facebook",
    domains: [".facebook.com", "facebook.com"],
    cookies: ["c_user", "xs", "fr", "datr"],
  },
  x: {
    label: "X (Twitter)",
    domains: [".x.com", "x.com", ".twitter.com", "twitter.com"],
    cookies: ["auth_token", "ct0", "twid"],
  },
  instagram: {
    label: "Instagram",
    domains: [".instagram.com", "instagram.com"],
    cookies: ["sessionid", "ds_user_id", "csrftoken", "ig_did"],
  },
};

// Login URLs used by the onboarding "Sign in to your accounts" step to
// pre-open each platform's sign-in page inside the CDP Chrome. We pick the
// plain homepage for each platform so that if the user is already logged in
// (session copied from their real profile), they see their feed/homepage —
// and if not, the page itself shows a login form.
//
// Gemini is special: there is no dedicated login endpoint. Users simply
// navigate to https://gemini.google.com/ and sign in with their Google
// account from inside the CDP Chrome. The session then becomes available
// to the automation layer automatically.
const PLATFORM_LOGIN_URLS = {
  google: "https://gemini.google.com/",
  gemini: "https://gemini.google.com/",
  linkedin: "https://www.linkedin.com/",
  facebook: "https://www.facebook.com/",
  x: "https://x.com/",
  instagram: "https://www.instagram.com/",
};

const DEFAULT_PORT = 9222;
const CDP_PROFILE_DIRNAME = "chrome-cdp-profile";

// Heavy directories we strip from the copied profile to save disk space.
const PROFILE_STRIP_DIRS = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "Service Worker/CacheStorage",
  "Service Worker/ScriptCache",
  "GrShaderCache",
  "ShaderCache",
  "Downloads",
  "Crashpad",
  " component_crx_cache",
];

class CdpManager {
  // `dataRoot` is the writable per-user data directory (appData). The CDP
  // profile directory lives at `<dataRoot>/chrome-cdp-profile/` so it:
  //   - is writable on every platform (Linux .deb installs to /opt which
  //     is read-only for non-root; macOS .app bundles are read-only)
  //   - survives app updates (the user's authenticated Chrome sessions
  //     aren't wiped when they install a new version of GTSS)
  //   - matches the path the engine's bash fallback expects, because
  //     EnvBootstrap writes CDP_PROFILE_DIR=<dataRoot>/chrome-cdp-profile
  //     into the .env file and the engine reads that env var
  //     (see scripts/launch-chrome.sh and src/automation/browserBase.js).
  //
  // The `serverRoot` constructor parameter is retained for backwards
  // compatibility with unit tests but is no longer used to compute the
  // profile dir.
  constructor({ dataRoot, logStream, port = DEFAULT_PORT, serverRoot = null }) {
    this.dataRoot = dataRoot;
    this.logStream = logStream;
    this.port = port;
    this.child = null;
    this.state = "stopped"; // stopped | starting | running | stopping | crashed
    this.serverRoot = serverRoot;
    this.cdpProfileDir = path.join(dataRoot, CDP_PROFILE_DIRNAME);
    this.chromePath = null;
    this.lastError = null;
    this.startedAt = null;
  }

  isRunning() {
    return this.state === "running";
  }

  getState() {
    return {
      state: this.state,
      pid: this.child ? this.child.pid : null,
      port: this.port,
      startedAt: this.startedAt,
      chromePath: this.chromePath,
      cdpProfileDir: this.cdpProfileDir,
      cdpEndpoint: this.isRunning() ? `http://127.0.0.1:${this.port}` : null,
      lastError: this.lastError,
    };
  }

  /**
   * Start the CDP Chrome.
   *
   * ─── Try-first-then-clone pattern (strengthened) ─────────────────────────
   *
   * The project's inviolable rule for Chrome: NEVER spawn a second Chrome
   * when one is already alive on the CDP port. The same Chrome that
   * `gtss-growth-engine/scripts/launch-chrome.sh` launches (or that the
   * desktop app launched on a previous run, or that the user launched
   * manually for debugging) MUST be reused across the entire project.
   *
   * Sequence:
   *   1. If we already spawned this child, throw (caller bug).
   *   2. Try to ATTACH to an existing CDP endpoint on this.port by hitting
   *      /json/version. If it answers, mark state=running, set chromePath
   *      from the response, and short-circuit — no spawn, no clone. This is
   *      the "try if we have one" half of the pattern.
   *   3. Otherwise, we need a fresh Chrome. The "clone if missing" half:
   *      ensureCdpProfile() checks whether the CDP profile dir already has
   *      a populated Default/Cookies; if so, reuse it; if not, clone from
   *      the user's real Chrome profile. Then spawn Chrome.
   *   4. If `openUrl` was provided, Chrome will open it in a new tab.
   *
   * @param {object} opts
   * @param {string} [opts.openUrl] — URL to open in a new tab when Chrome
   *   launches. This is how the launcher opens the web app INSIDE the CDP
   *   Chrome instead of the user's default browser — so the web app and the
   *   automation share the same Chrome instance.
   * @param {boolean} [opts.skipProfileCopy=false] — when true, do NOT attempt
   *   to clone the user's Chrome profile into the CDP profile dir before
   *   spawning Chrome. Used by callers that know a clone isn't needed yet
   *   (e.g., emergency "just get Chrome up" paths). The (potentially slow)
   *   profile copy is normally deferred to server startup so the wizard
   *   stays snappy.
   * @param {(stage: string, message: string) => void} [opts.onProgress] —
   *   optional callback invoked with human-readable progress messages during
   *   the multi-step startup sequence (locating Chrome, cloning profile,
   *   preparing endpoint, waiting for port). Every message is ALSO pushed
   *   into the logStream so the launcher's Logs tab surfaces the same info.
   */
  async start({ openUrl, skipProfileCopy = false, onProgress } = {}) {
    if (this.child) {
      throw new Error(`CDP Chrome already running (pid ${this.child.pid})`);
    }
    this.state = "starting";
    this.lastError = null;

    const progress = (stage, message) => {
      try {
        this.logStream.append("cdp", message);
        if (typeof onProgress === "function") onProgress(stage, message);
      } catch (_) {}
    };

    // ─── 0. Try to attach to an existing CDP endpoint ─────────────────────
    //
    // Before we spawn anything, probe the configured port with a CDP
    // /json/version request. If something answers, it's a Chrome already
    // running with --remote-debugging-port (most commonly: the desktop app
    // was relaunched while Chrome from the previous session is still open,
    // OR a developer ran `./scripts/launch-chrome.sh` before opening the
    // desktop app, OR the user manually launched Chrome with the right
    // flags). We adopt that Chrome as our own — no spawn, no clone — so the
    // project always shares ONE Chrome across the web app, the automation
    // layer, and the desktop launcher.
    //
    // This is the "try first" half of the pattern the project enforces
    // everywhere Chrome is touched.
    const attached = await this._tryAttachExisting(progress);
    if (attached) {
      // We're done — Chrome is up, the endpoint is alive, and we did NOT
      // have to spawn or clone anything. openUrl (if provided) is opened in
      // a new tab of the existing Chrome.
      if (openUrl) {
        const ok = await this.openTab(openUrl);
        if (!ok) {
          this.logStream.append("cdp:stderr", `Could not open ${openUrl} in the attached Chrome — open it manually.`);
        }
      }
      return;
    }

    // 1. Locate Chrome.
    progress("init", "Initializing browser...");
    this.chromePath = locateChrome();
    if (!this.chromePath) {
      this.state = "crashed";
      this.lastError =
        "Google Chrome was not found. Please install Chrome from https://www.google.com/chrome/ and try again.";
      this.logStream.append("cdp:stderr", this.lastError);
      throw new Error(this.lastError);
    }
    progress("init", `Using Chrome at ${this.chromePath}`);

    // 2. Ensure the CDP profile dir exists. First-time: copy from user's profile.
    //    Skipped entirely during onboarding setup so the wizard stays snappy —
    //    the (potentially slow) profile clone is deferred to server startup.
    if (skipProfileCopy) {
      progress("init", "Launching browser without cloning profile (setup mode)...");
      try {
        fs.mkdirSync(this.cdpProfileDir, { recursive: true });
      } catch (err) {
        this.logStream.append("cdp:stderr", `Could not create CDP profile dir: ${err.message}`);
      }
    } else {
      await this.ensureCdpProfile({ onProgress: progress });
    }

    // 3. Spawn Chrome with remote debugging.
    progress("endpoint", "Preparing CDP endpoint...");
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.cdpProfileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-features=Translate",
      // Disable the Chrome "Chrome is being controlled by automated software"
      // banner — it confuses non-technical users.
      "--disable-features=ChromeWhatsNewUI",
    ];

    // If a URL was provided, Chrome will open it in a new tab on launch.
    // This is how the web app opens INSIDE the CDP Chrome.
    if (openUrl) {
      args.push(openUrl);
      this.logStream.append("cdp", `Will open ${openUrl} on launch.`);
    }


    this.logStream.append("cdp", `Launching Chrome on port ${this.port}...`);
    this.child = spawn(this.chromePath, args, {
      cwd: this.cdpProfileDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      windowsHide: false, // Chrome should be visible to the user.
    });

    this.child.stdout.on("data", (buf) => {
      // Chrome stdout is noisy — only log lines that mention DevTools or errors.
      const text = buf.toString("utf8");
      if (/DevTools|error|ERROR/i.test(text)) {
        this.logStream.append("cdp:stdout", text.trim());
      }
    });
    this.child.stderr.on("data", (buf) => {
      const text = buf.toString("utf8");
      // Chrome prints a lot of warnings to stderr that aren't real errors.
      // Only surface things that look serious.
      if (/FATAL|ERROR|cannot|failed/i.test(text)) {
        this.logStream.append("cdp:stderr", text.trim());
      }
    });

    this.child.on("exit", (code, signal) => {
      this.logStream.append("cdp", `Chrome exited (code=${code} signal=${signal})`);
      this.child = null;
      if (this.state === "stopping") {
        this.state = "stopped";
      } else {
        this.state = "crashed";
        this.lastError = `Chrome exited unexpectedly (code=${code})`;
      }
    });

    this.child.on("error", (err) => {
      this.logStream.append("cdp:stderr", `Spawn error: ${err.message}`);
      this.state = "crashed";
      this.lastError = err.message;
      this.child = null;
    });

    // 4. Wait for the CDP port to start accepting connections.
    try {
      progress("almost-ready", "Almost ready...");
      await this.waitForPort(this.port, 15000);
      this.state = "running";
      this.startedAt = new Date().toISOString();
      progress("ready", `CDP ready at http://127.0.0.1:${this.port}`);
    } catch (err) {
      this.state = "crashed";
      this.lastError = err.message;
      this.logStream.append("cdp:stderr", err.message);
      throw err;
    }
  }

  /**
   * Internal: probe the configured CDP port and, if a Chrome is already
   * listening there, adopt it instead of spawning a new one.
   *
   * This implements the project's "try first, clone if missing" pattern at
   * the Chrome-process level: before we ever spawn Chrome or clone a
   * profile, we ask "is Chrome already up on this port?" If yes, we use
   * that one — period. The same Chrome that `launch-chrome.sh` started, or
   * that a previous desktop session left running, or that the user opened
   * manually with the right flags, becomes our automation target. This is
   * what keeps the project on ONE Chrome across the web app, the
   * automation layer, and the desktop launcher.
   *
   * Returns true if we successfully attached (state is now "running"),
   * false if no endpoint was reachable and the caller should proceed to
   * spawn.
   *
   * @private
   */
  async _tryAttachExisting(progress) {
    try {
      const info = await this._getCdpVersionInfo();
      if (!info) return false;

      // We got a valid /json/version response — Chrome is already up.
      // Adopt it. We don't own the child process (so this.child stays
      // null and stop() won't kill it), but isRunning() returns true and
      // openTab()/checkSessions()/openLoginTabs() all work against the
      // existing endpoint.
      this.chromePath = info.Browser
        ? String(info.Browser)
        : this.chromePath;
      this.state = "running";
      this.startedAt = new Date().toISOString();
      this.lastError = null;
      const banner = info.Browser
        ? `Reusing existing Chrome on port ${this.port} (${info.Browser}). No new browser spawned.`
        : `Reusing existing Chrome on port ${this.port}. No new browser spawned.`;
      this.logStream.append("cdp", banner);
      if (typeof progress === "function") {
        progress("ready", banner);
      }
      return true;
    } catch (_) {
      // Endpoint not reachable — fall through; caller will spawn.
      return false;
    }
  }

  /**
   * Internal: GET /json/version from the CDP endpoint. Returns the parsed
   * JSON object (containing Browser, webSocketDebuggerUrl, etc.) or null
   * on any error. Used by _tryAttachExisting() to detect an already-running
   * Chrome without spawning one.
   *
   * @private
   */
  _getCdpVersionInfo() {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/json/version",
          method: "GET",
          timeout: 1500,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            if (res.statusCode !== 200 || !body) {
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch (_) {
              resolve(null);
            }
          });
        },
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    });
  }

  /**
   * Open a new tab in the running CDP Chrome via the DevTools HTTP API.
   * Used by the "Open Web App" button — this way the web app opens in the
   * SAME Chrome that handles automation, not the user's default browser.
   *
   * Returns true on success, false if CDP isn't running or the request fails.
   */
  async openTab(url) {
    if (!this.isRunning()) return false;
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: `/json/new?${encodeURIComponent(url)}`,
          method: "PUT",
          timeout: 3000,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  /**
   * Open the platform login pages inside the running CDP Chrome. Used by
   * the onboarding wizard's "Sign in to your accounts" step.
   *
   * We open them sequentially with a small gap so Chrome doesn't get
   * overwhelmed and the user can see each tab appear. Tabs are opened in
   * the SAME Chrome that handles automation, so cookies set during these
   * manual logins are immediately available to the automation layer.
   *
   * @param {string[]} platforms - list of platform keys (google/linkedin/...)
   * @returns {Promise<{opened: string[], failed: string[]}>}
   */
  async openLoginTabs(platforms) {
    const opened = [];
    const failed = [];
    if (!this.isRunning()) {
      this.logStream.append("cdp", "openLoginTabs: CDP Chrome is not running.");
      return { opened, failed: platforms.slice() };
    }
    for (const key of platforms) {
      const url = PLATFORM_LOGIN_URLS[key];
      if (!url) {
        failed.push(key);
        continue;
      }
      const ok = await this.openTab(url);
      if (ok) {
        opened.push(key);
        this.logStream.append("cdp", `Opened ${key} login tab: ${url}`);
      } else {
        failed.push(key);
        this.logStream.append("cdp:stderr", `Failed to open ${key} login tab.`);
      }
      // Small gap so the user sees tabs appear one at a time.
      await new Promise((r) => setTimeout(r, 400));
    }
    return { opened, failed };
  }

  /**
   * Query the running CDP Chrome for current cookies and report which
   * platforms have an active session. Used by the onboarding wizard to
   * gate the "Continue" button on the user being logged in.
   *
   * Implementation: get the list of pages from /json/list, pick a page
   * target, open a WebSocket to its devtoolsUrl, send Network.getAllCookies,
   * parse the response, then close the socket. We use the global WebSocket
   * (available in Node 22+ and bundled in Electron 33+).
   *
   * Returns null if CDP isn't running or the query fails — callers should
   * treat null as "unknown, retry".
   *
   * @returns {Promise<null | Object>} map of platformKey -> { loggedIn, cookies: string[] }
   */
  async checkSessions() {
    if (!this.isRunning()) return null;

    // 1. Get the list of targets from the CDP HTTP endpoint.
    const targets = await this._listTargets().catch(() => []);
    if (!Array.isArray(targets) || targets.length === 0) return null;

    // Prefer a `page`-type target (a real browser tab) — browser-level
    // targets don't expose Network.getAllCookies the same way.
    const pageTarget =
      targets.find((t) => t && t.type === "page" && t.webSocketDebuggerUrl) ||
      targets.find((t) => t && t.webSocketDebuggerUrl);
    if (!pageTarget || !pageTarget.webSocketDebuggerUrl) return null;

    // 2. Open a transient WebSocket, send Network.getAllCookies, parse, close.
    let cookies = null;
    try {
      cookies = await this._getAllCookiesViaWs(pageTarget.webSocketDebuggerUrl);
    } catch (err) {
      this.logStream.append("cdp:stderr", `checkSessions: ${err.message}`);
      return null;
    }
    if (!Array.isArray(cookies)) return null;

    // 3. For each platform, see if at least one signature cookie is present
    // AND the cookie's domain matches the platform's expected domain.
    const result = {};
    for (const [key, sig] of Object.entries(SESSION_COOKIE_SIGNATURES)) {
      const matched = [];
      for (const cookie of cookies) {
        if (!cookie || !cookie.name || !cookie.domain) continue;
        if (!sig.cookies.includes(cookie.name)) continue;
        const domain = cookie.domain.toLowerCase();
        const domainMatches = sig.domains.some((d) => {
          const dl = d.toLowerCase();
          if (dl.startsWith(".")) return domain === dl || domain.endsWith(dl);
          return domain === dl || domain.endsWith("." + dl);
        });
        if (domainMatches) matched.push(cookie.name);
      }
      result[key] = {
        loggedIn: matched.length > 0,
        cookies: matched,
        label: sig.label,
      };
    }
    return result;
  }

  /**
   * Internal: GET /json/list from the CDP endpoint and return the array
   * of targets. Returns [] on any error.
   */
  _listTargets() {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/json/list",
          method: "GET",
          timeout: 3000,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("CDP /json/list timed out"));
      });
      req.end();
    });
  }

  /**
   * Internal: connect to a CDP target's WebSocket, call Network.getAllCookies,
   * and return the array of cookies. Uses the global WebSocket constructor
   * (available in Node 22+ and Electron 33+).
   *
   * We attach the listener BEFORE we send the request and wait for either
   * the matching response (same `id`) or a 4-second timeout — whichever
   * comes first. The socket is always closed in the finally block.
   */
  _getAllCookiesViaWs(wsUrl) {
    return new Promise((resolve, reject) => {
      let ws;
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (ws) {
          try { ws.close(); } catch (_) {}
        }
        if (err) reject(err);
        else resolve(value);
      };
      const timeout = setTimeout(() => {
        finish(new Error("CDP WebSocket getAllCookies timed out"));
      }, 4000);
      try {
        // eslint-disable-next-line no-undef
        const WS = (typeof WebSocket !== "undefined") ? WebSocket : null;
        if (!WS) {
          clearTimeout(timeout);
          finish(new Error("WebSocket not available in this runtime"));
          return;
        }
        ws = new WS(wsUrl);
        ws.onopen = () => {
          try {
            ws.send(JSON.stringify({ id: 1, method: "Network.getAllCookies" }));
          } catch (err) {
            clearTimeout(timeout);
            finish(err);
          }
        };
        ws.onmessage = (event) => {
          let msg;
          try {
            msg = JSON.parse(typeof event.data === "string" ? event.data : "");
          } catch (_) {
            return;
          }
          if (msg && msg.id === 1) {
            clearTimeout(timeout);
            if (msg.error) {
              finish(new Error(msg.error.message || "CDP getAllCookies error"));
            } else {
              const cks = msg.result && msg.result.cookies;
              finish(null, Array.isArray(cks) ? cks : []);
            }
          }
        };
        ws.onerror = (err) => {
          clearTimeout(timeout);
          finish(new Error("CDP WebSocket error"));
        };
        ws.onclose = () => {
          // If we somehow didn't resolve yet, treat as failure.
          clearTimeout(timeout);
          finish(new Error("CDP WebSocket closed before response"));
        };
      } catch (err) {
        clearTimeout(timeout);
        finish(err);
      }
    });
  }


  async stop(reason = "user") {
    // If we attached to an externally-launched Chrome (via
    // _tryAttachExisting), this.child is null but state is "running". We
    // deliberately do NOT kill that Chrome — the user (or
    // launch-chrome.sh) owns it. We just flip our state to "stopped" so
    // the rest of the app knows we no longer have a CDP endpoint to talk
    // to (until they restart Chrome or restart the launcher).
    if (!this.child) {
      if (this.state === "running") {
        this.logStream.append(
          "cdp",
          `Detaching from external Chrome (reason: ${reason}). The Chrome window stays open — close it manually if you want to.`,
        );
      }
      this.state = "stopped";
      return;
    }
    this.state = "stopping";
    this.logStream.append("cdp", `Stopping Chrome (reason: ${reason})...`);

    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };

      this.child.once("exit", done);

      try {
        if (process.platform === "win32") {
          this.child.kill();
        } else {
          this.child.kill("SIGTERM");
        }
      } catch (err) {
        this.logStream.append("cdp:stderr", `Failed to signal Chrome: ${err.message}`);
      }

      setTimeout(() => {
        if (this.child) {
          try {
            this.child.kill("SIGKILL");
          } catch (_) {}
        }
        done();
      }, 8000).unref();
    });
  }

  async restart() {
    await this.stop("restart");
    await new Promise((r) => setTimeout(r, 500));
    await this.start();
  }

  // ─── Profile management ──────────────────────────────────────────────────

  async ensureCdpProfile({ onProgress } = {}) {
    // NOTE: we do NOT call this.logStream.append() here — the caller (start())
    // already wraps onProgress in a function that logs to the logStream.
    // Logging here too would double-emit every progress message.
    const progress = (stage, message) => {
      try {
        if (typeof onProgress === "function") onProgress(stage, message);
      } catch (_) {}
    };

    // ─── Harden the "already initialized" check ───────────────────────────
    // Previously we only checked `fs.existsSync(<cdpProfileDir>/Default)`.
    // That check passes for an EMPTY Default dir — which is exactly what
    // happens if a previous launch crashed mid-copy (mkdir succeeded, then
    // copyDirSelective failed before writing any files). On every subsequent
    // launch, the empty Default dir would short-circuit the copy step and
    // Chrome would start with a fresh profile containing NO authenticated
    // sessions. The user would then see "CDP Chrome has no sessions at all"
    // — the regression we are fixing.
    //
    // We now require BOTH:
    //   1. The Default dir exists, AND
    //   2. Either the Cookies file or the Login Data file exists inside it.
    // These SQLite files are what Chrome uses to persist session cookies
    // and saved logins — their presence is a strong signal the profile
    // was fully copied on a previous launch.
    const defaultProfile = path.join(this.cdpProfileDir, "Default");
    const cookiesFile = path.join(defaultProfile, "Cookies");
    const loginDataFile = path.join(defaultProfile, "Login Data");
    const profileLooksPopulated =
      fs.existsSync(defaultProfile) &&
      (fs.existsSync(cookiesFile) || fs.existsSync(loginDataFile));
    if (profileLooksPopulated) {
      // Profile already initialized on a previous launch.
      progress("init", "CDP profile already initialized — reusing existing sessions.");
      return;
    }

    // If the Default dir exists but is empty/stale, remove it so the copy
    // below starts clean. Otherwise copyDirSelective would skip the mkdir
    // but still try to copy files into a half-populated dir.
    if (fs.existsSync(defaultProfile) && !profileLooksPopulated) {
      progress("clone", "Existing CDP profile looks empty — re-cloning from your Chrome profile to restore sessions.");
      try {
        fs.rmSync(defaultProfile, { recursive: true, force: true });
      } catch (err) {
        this.logStream.append("cdp:stderr", `Could not remove stale profile dir: ${err.message}`);
      }
    }

    const source = locateUserChromeProfile();
    if (!source || !fs.existsSync(source)) {
      progress("init", "No existing Chrome profile found — starting with a fresh profile. You'll need to log into LinkedIn/X/Facebook/Instagram manually.");
      fs.mkdirSync(this.cdpProfileDir, { recursive: true });
      return;
    }

    progress("clone", "Cloning browser profile from your Chrome — this may take a moment...");
    progress("clone", `Source: ${source}`);
    fs.mkdirSync(this.cdpProfileDir, { recursive: true });

    // Copy the Default profile dir.
    const sourceDefault = path.join(source, "Default");
    if (fs.existsSync(sourceDefault)) {
      progress("clone", "Copying Default profile (cookies, logins, preferences)...");
      copyDirSelective(sourceDefault, defaultProfile, PROFILE_STRIP_DIRS, {
        onProgress: (msg) => progress("clone", msg),
      });
    } else {
      // Some Chrome installs use "Profile 1", "Profile 2", etc. instead of
      // "Default". As a fallback, copy the first "Profile *" dir we find.
      const profileDirs = fs.readdirSync(source, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^Profile\b/.test(e.name))
        .map((e) => e.name);
      if (profileDirs.length > 0) {
        const sourceProfile = path.join(source, profileDirs[0]);
        progress("clone", `Default profile not found; copying ${profileDirs[0]} instead.`);
        copyDirSelective(sourceProfile, defaultProfile, PROFILE_STRIP_DIRS, {
          onProgress: (msg) => progress("clone", msg),
        });
      }
    }
    // Copy "Local State" — needed for encrypted cookie decryption.
    const localState = path.join(source, "Local State");
    if (fs.existsSync(localState)) {
      fs.copyFileSync(localState, path.join(this.cdpProfileDir, "Local State"));
    }

    // Verify the copy actually produced a Cookies file. If not, the user's
    // source profile might be locked (Chrome is running) and we should warn
    // them — the CDP Chrome will not have any sessions until they close
    // Chrome and re-launch the desktop app.
    if (!fs.existsSync(cookiesFile)) {
      this.logStream.append(
        "cdp:stderr",
        "Profile copy did not produce a Cookies file. If Chrome is currently running, close it and click Restart Chrome so the profile (with your logins) can be copied cleanly.",
      );
    } else {
      progress("clone", "Profile copy complete. Your existing logins are preserved.");
    }
  }

  // ─── Health check ─────────────────────────────────────────────────────────

  waitForPort(port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tryConnect = () => {
        const socket = new net.Socket();
        socket.setTimeout(1500);
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", () => {
          socket.destroy();
          if (Date.now() - start > timeoutMs) {
            reject(new Error(`Chrome did not open CDP port ${port} within ${timeoutMs}ms`));
          } else {
            setTimeout(tryConnect, 500);
          }
        });
        socket.once("timeout", () => {
          socket.destroy();
          if (Date.now() - start > timeoutMs) {
            reject(new Error(`Chrome did not open CDP port ${port} within ${timeoutMs}ms`));
          } else {
            setTimeout(tryConnect, 500);
          }
        });
        socket.connect(port, "127.0.0.1");
      };
      tryConnect();
    });
  }
}

// ─── Chrome discovery ───────────────────────────────────────────────────────

function locateChrome() {
  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(
        process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return null;
  }

  if (process.platform === "darwin") {
    const macPaths = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    ];
    for (const c of macPaths) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  // Linux
  const linuxBins = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    "/opt/google/chrome/chrome",
  ];
  for (const c of linuxBins) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function locateUserChromeProfile() {
  const candidates = [];

  if (process.platform === "win32") {
    candidates.push(path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data"));
    // Chrome Beta / Canary / Dev variants
    candidates.push(path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome Beta", "User Data"));
    candidates.push(path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome SxS", "User Data"));
  } else if (process.platform === "darwin") {
    candidates.push(path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome"));
    candidates.push(path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome Beta"));
    candidates.push(path.join(os.homedir(), "Library", "Application Support", "Chromium"));
  } else {
    // Linux
    candidates.push(path.join(os.homedir(), ".config", "google-chrome"));
    candidates.push(path.join(os.homedir(), ".config", "google-chrome-beta"));
    candidates.push(path.join(os.homedir(), ".config", "chromium"));
    candidates.push(path.join(os.homedir(), ".config", "chrome"));
    // Snap installs use ~/snap/chromium/common/chromium
    candidates.push(path.join(os.homedir(), "snap", "chromium", "common", "chromium"));
    candidates.push(path.join(os.homedir(), "snap", "google-chrome", "common", "google-chrome"));
  }

  // Prefer the first candidate that has a populated Default (or Profile N)
  // dir — i.e., one that actually contains a Cookies file. A bare config
  // dir without cookies is useless to us (the whole point of copying is to
  // inherit the user's authenticated sessions).
  for (const c of candidates) {
    if (!c || !fs.existsSync(c)) continue;
    if (profileHasCookies(c)) return c;
  }

  // Fall back to the first existing candidate even if it has no Cookies
  // file (better than returning null — let ensureCdpProfile() warn the
  // user that no sessions were carried over).
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// Returns true if the given Chrome user-data-dir has a Default (or
// Profile N) directory that contains a Cookies file. Used by
// locateUserChromeProfile() to prefer profiles that actually have
// authenticated sessions.
function profileHasCookies(userdataDir) {
  try {
    const candidates = ["Default"];
    const entries = fs.readdirSync(userdataDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && /^Profile\b/.test(e.name)) {
        candidates.push(e.name);
      }
    }
    for (const name of candidates) {
      const cookiesFile = path.join(userdataDir, name, "Cookies");
      if (fs.existsSync(cookiesFile)) return true;
    }
  } catch (_) {}
  return false;
}

// Recursively copy a directory but skip the named subdirs (relative to the
// source root). Used to strip Cache / Code Cache / etc.
//
// `opts.onProgress` (optional) is invoked with a short human-readable message
// every ~200 files copied so the UI can show "Copying profile... 800 files"
// style progress during the (potentially slow) first-time clone.
function copyDirSelective(src, dest, stripDirs, opts = {}) {
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  const state = { files: 0, dirs: 0, lastReportAt: Date.now() };
  _copyDirInner(src, dest, stripDirs, state, onProgress);
  if (onProgress && state.files > 0) {
    onProgress(`Profile copy finished — ${state.files} files in ${state.dirs} directories.`);
  }
}

function _copyDirInner(src, dest, stripDirs, state, onProgress) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const relPath = path.relative(src, srcPath);
    if (stripDirs.includes(relPath) || stripDirs.includes(entry.name)) {
      continue;
    }
    const destPath = path.join(dest, entry.name);
    try {
      if (entry.isSymbolicLink()) {
        // Skip symlinks to avoid infinite loops.
        continue;
      }
      if (entry.isDirectory()) {
        state.dirs += 1;
        _copyDirInner(srcPath, destPath, stripDirs, state, onProgress);
      } else if (entry.isFile()) {
        // Skip files > 50MB (probably media caches).
        const stat = fs.statSync(srcPath);
        if (stat.size > 50 * 1024 * 1024) continue;
        fs.copyFileSync(srcPath, destPath);
        state.files += 1;
        // Report progress at most every ~250ms so we don't flood the log.
        if (onProgress && Date.now() - state.lastReportAt > 250) {
          state.lastReportAt = Date.now();
          onProgress(`Copying profile... ${state.files} files copied`);
        }
      }
    } catch (err) {
      // Skip files we can't read (locked, permission-denied).
    }
  }
}

module.exports = { CdpManager, validateGeminiApiKey };

// ─── Gemini API key validation ─────────────────────────────────────────────
//
// Lightweight validation that an API key is genuinely a Google AI Studio key
// (not just a string starting with "AIza"). We hit the list-models endpoint
// which is:
//   - cheap (returns a small JSON list),
//   - doesn't consume quota,
//   - returns 400 for malformed keys, 401/403 for invalid keys, 200 for valid.
//
// We treat 429 (quota exceeded) as VALID — the key itself is fine, the user
// just hit their rate limit. We treat network errors as "unknown" rather than
// "invalid" so a flaky connection doesn't falsely reject a good key.
//
// This is invoked from the renderer during onboarding (and from the Settings
// page later) so the user gets immediate ✅/❌ feedback rather than having
// to start the server and trigger a real Gemini call to find out.
async function validateGeminiApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== "string") {
    return { ok: false, valid: false, reason: "API key is empty." };
  }
  const key = apiKey.trim();
  if (!key) {
    return { ok: false, valid: false, reason: "API key is empty." };
  }
  // Quick sanity check — every real AI Studio key starts with "AIza".
  if (!key.startsWith("AIza")) {
    return {
      ok: true,
      valid: false,
      reason: "That doesn't look like a Gemini API key (should start with 'AIza').",
    };
  }
  if (key.length < 30) {
    return {
      ok: true,
      valid: false,
      reason: "API key is too short — Gemini keys are usually ~39 characters.",
    };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (res.status === 200) {
      return { ok: true, valid: true, reason: "API key is valid." };
    }
    // 429 = quota exceeded. The key itself is valid; the user just hit a
    // rate limit. Per requirements, we treat this as VALID.
    if (res.status === 429) {
      return {
        ok: true,
        valid: true,
        reason: "API key is valid (quota currently exceeded — ignored per validation policy).",
      };
    }
    if (res.status === 400) {
      return { ok: true, valid: false, reason: "Google rejected the key as malformed." };
    }
    if (res.status === 401 || res.status === 403) {
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch (_) {}
      const snippet = bodyText ? ` — ${bodyText.slice(0, 200)}` : "";
      return {
        ok: true,
        valid: false,
        reason: `Invalid API key (HTTP ${res.status})${snippet}`,
      };
    }
    return {
      ok: true,
      valid: false,
      reason: `Unexpected response from Google (HTTP ${res.status}).`,
    };
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err && (err.name === "AbortError" || err.code === "ABORT_ERR");
    return {
      ok: false,
      valid: false,
      reason: isAbort
        ? "Validation timed out — check your internet connection and try again."
        : `Could not reach Google to validate the key: ${err.message || err}`,
    };
  }
}
