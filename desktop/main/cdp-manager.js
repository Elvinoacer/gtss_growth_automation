/**
 * CdpManager — cross-platform port of scripts/launch-chrome.sh.
 *
 * Launches the user's REAL Chrome with --remote-debugging-port so GTSS
 * automation can connect via CDP without tripping bot-detection. Uses a
 * separate user-data-dir (required by Chrome for remote debugging) but
 * copies the user's Default profile on first launch so they stay logged
 * into LinkedIn, X, Facebook, and Instagram.
 *
 * Behaviour:
 *   - On first launch: locate Chrome, copy the Default profile (minus cache
 *     dirs) into <dataRoot>/chrome-cdp-profile, spawn Chrome.
 *   - On subsequent launches: reuse the existing CDP profile.
 *   - If no Chrome is installed: log an error and tell the user to install
 *     Google Chrome (we intentionally do NOT bundle Chrome to keep the
 *     installer small and respect Google's distribution terms).
 *
 * Session checking:
 *   - checkSessions() opens a transient CDP WebSocket to the running Chrome
 *     and calls Network.getAllCookies, then reports which platforms have
 *     active login cookies. Used by the onboarding wizard to gate "Continue"
 *     on the user being logged into Google (required for Gemini to work in
 *     a copied profile) plus LinkedIn / Facebook / X.
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
const PLATFORM_LOGIN_URLS = {
  google: "https://gemini.google.com/",
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
  constructor({ dataRoot, logStream, port = DEFAULT_PORT }) {
    this.dataRoot = dataRoot;
    this.logStream = logStream;
    this.port = port;
    this.child = null;
    this.state = "stopped"; // stopped | starting | running | stopping | crashed
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
   * @param {object} opts
   * @param {string} [opts.openUrl] — URL to open in a new tab when Chrome
   *   launches. This is how the launcher opens the web app INSIDE the CDP
   *   Chrome instead of the user's default browser — so the web app and the
   *   automation share the same Chrome instance.
   */
  async start({ openUrl } = {}) {
    if (this.child) {
      throw new Error(`CDP Chrome already running (pid ${this.child.pid})`);
    }
    this.state = "starting";
    this.lastError = null;

    // 1. Locate Chrome.
    this.chromePath = locateChrome();
    if (!this.chromePath) {
      this.state = "crashed";
      this.lastError =
        "Google Chrome was not found. Please install Chrome from https://www.google.com/chrome/ and try again.";
      this.logStream.append("cdp:stderr", this.lastError);
      throw new Error(this.lastError);
    }
    this.logStream.append("cdp", `Using Chrome at ${this.chromePath}`);

    // 2. Ensure the CDP profile dir exists. First-time: copy from user's profile.
    await this.ensureCdpProfile();

    // 3. Spawn Chrome with remote debugging.
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
      await this.waitForPort(this.port, 15000);
      this.state = "running";
      this.startedAt = new Date().toISOString();
      this.logStream.append("cdp", `CDP ready at http://127.0.0.1:${this.port}`);
    } catch (err) {
      this.state = "crashed";
      this.lastError = err.message;
      this.logStream.append("cdp:stderr", err.message);
      throw err;
    }
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
    if (!this.child) {
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

  async ensureCdpProfile() {
    const defaultProfile = path.join(this.cdpProfileDir, "Default");
    if (fs.existsSync(defaultProfile)) {
      // Profile already initialized on a previous launch.
      return;
    }

    const source = locateUserChromeProfile();
    if (!source || !fs.existsSync(source)) {
      this.logStream.append(
        "cdp",
        "No existing Chrome profile found — starting with a fresh profile. You'll need to log into LinkedIn/X/Facebook/Instagram manually.",
      );
      fs.mkdirSync(this.cdpProfileDir, { recursive: true });
      return;
    }

    this.logStream.append("cdp", `Copying your Chrome profile from ${source} (first-time setup)...`);
    fs.mkdirSync(this.cdpProfileDir, { recursive: true });

    // Copy the Default profile dir.
    const sourceDefault = path.join(source, "Default");
    if (fs.existsSync(sourceDefault)) {
      copyDirSelective(sourceDefault, defaultProfile, PROFILE_STRIP_DIRS);
    }
    // Copy "Local State" — needed for encrypted cookie decryption.
    const localState = path.join(source, "Local State");
    if (fs.existsSync(localState)) {
      fs.copyFileSync(localState, path.join(this.cdpProfileDir, "Local State"));
    }

    this.logStream.append("cdp", "Profile copy complete. Your existing logins are preserved.");
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
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  }
  // Linux
  const linuxPaths = [
    path.join(os.homedir(), ".config", "google-chrome"),
    path.join(os.homedir(), ".config", "chromium"),
    path.join(os.homedir(), ".config", "chrome"),
  ];
  for (const c of linuxPaths) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// Recursively copy a directory but skip the named subdirs (relative to the
// source root). Used to strip Cache / Code Cache / etc.
function copyDirSelective(src, dest, stripDirs) {
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
        copyDirSelective(srcPath, destPath, stripDirs);
      } else if (entry.isFile()) {
        // Skip files > 50MB (probably media caches).
        const stat = fs.statSync(srcPath);
        if (stat.size > 50 * 1024 * 1024) continue;
        fs.copyFileSync(srcPath, destPath);
      }
    } catch (err) {
      // Skip files we can't read (locked, permission-denied).
    }
  }
}

module.exports = { CdpManager };
