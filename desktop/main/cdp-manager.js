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
const fsp = fs.promises; // async fs — used for the profile clone so we never block the Electron main thread
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

// ─── Session-bearing files we copy from the user's real Chrome profile ──────
//
// Why a whitelist instead of "copy everything except caches":
// The user's `Default/` profile dir typically contains 5,000–50,000 files
// totaling 500MB–5GB. Most of that mass is in `IndexedDB/`, `Local Storage/`,
// `Sessions/`, `Media Cache/`, `Storage/`, `Service Worker/` — none of which
// are needed to preserve LinkedIn/X/Instagram/Facebook/Google logins. The
// session-bearing state lives in a handful of small SQLite/JSON files:
//
//   - Cookies                  → session cookies (the actual login tokens)
//   - Login Data               → saved passwords (encrypted via Local State + OS keyring)
//   - Login Data For Account   → account-scoped passwords
//   - Web Data                 → autofill, payment methods (small)
//   - Preferences              → JSON, profile preferences
//   - Secure Preferences       → JSON, security-managed preferences
//   - TransportSecurity        → HSTS list (small SQLite)
//   - Favicons                 → favicon cache (small SQLite, improves UX)
//   - History                  → browsing history (small SQLite, improves UX)
//   - Top Sites                → top-sites list (small SQLite)
//
// Each file is normally <8MB. Total clone drops from minutes (multi-GB)
// to under a second (a few MB). This is the fix for the "clicking Start
// hangs the app" symptom — the previous fix (CHANGES.md §3) added
// setImmediate yields every 50 files but kept `fs.copyFileSync` per file,
// which is itself blocking I/O that hangs the event loop on large files.
//
// We also copy the SQLite `-journal` / `-wal` / `-shm` sidecar files if
// they exist, so we don't leave Chrome's SQLite stores in a torn state.
// These are tiny (typically <100KB) and Chrome recreates them as needed,
// but copying them when present avoids "database is malformed" warnings.
//
// `Local State` lives at the TOP LEVEL of the user-data dir (not inside
// `Default/`) and is handled separately — see ensureCdpProfile().
const SESSION_FILES = [
  "Cookies",
  "Cookies-journal",
  "Login Data",
  "Login Data-journal",
  "Login Data For Account",
  "Login Data For Account-journal",
  "Web Data",
  "Web Data-journal",
  "Preferences",
  "Secure Preferences",
  "TransportSecurity",
  "TransportSecurity-journal",
  "Favicons",
  "Favicons-journal",
  "History",
  "History-journal",
  "Top Sites",
  "Top Sites-journal",
  "Network/Cookies", // newer Chrome layouts put Cookies under Network/
  "Network/Network Persistent State",
];

// Hard cap on per-file size during the selective clone. Session/login files
// are normally <8MB; anything bigger is almost certainly a stale blob we
// don't want to copy. Defense-in-depth — if a user has somehow ended up
// with a 500MB Cookies file (impossible in practice), we skip it.
const SESSION_FILE_MAX_BYTES = 8 * 1024 * 1024;

// Heavy directories we strip from the copied profile in the FALLBACK
// recursive-copy path (only used when no session files were found at the
// source — e.g., a fresh Chrome install with no logins). This list is much
// more aggressive than the previous one: it now includes IndexedDB, Local
// Storage, Sessions, Media Cache, Storage, and the full Service Worker
// tree — the actual heavy hitters that were missing before and caused the
// 10–60 second main-thread freeze.
const PROFILE_STRIP_DIRS = [
  // Caches (always safe to drop)
  "Cache",
  "CacheTmp",
  "Code Cache",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnGraphCache",
  "DawnWebGPUCache",
  "Media Cache",
  // Service Worker tree (huge; recreated on demand)
  "Service Worker",
  // IndexedDB / Storage (very huge — sites cache video blobs here)
  "IndexedDB",
  "Local Storage",
  "Session Storage",
  "Storage",
  "blob_storage",
  "File System",
  // Sessions / Sync (per-tab session state — not needed for login persistence)
  "Sessions",
  "SyncData",
  "Sync App Settings",
  // Misc heavy / unneeded
  "Downloads",
  "Crashpad",
  " component_crx_cache",
  "optimization_guide_prediction_model_downloads",
  "optimization_guide_prediction_models",
  "webrtc_event_logs",
  "SmartADCHistograms",
  "FirstPartySetsPartitioning",
  "DIPS",
  "Trust Tokens",
  "FileManager",
  "Affiliation Database",
  // Subdir under Default that some Chrome versions create
  "optimization_guide",
  "Site Characteristics Database",
];

// Concurrency limit for parallel file copies. 4 is a sweet spot: enough to
// keep the disk busy, low enough that we don't starve libuv's default
// thread pool (size 4) or thrash the page cache.
const CLONE_CONCURRENCY = 4;

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
    // Tracks the visibility of the Chrome we spawned (or attached to).
    //   true  — we spawned Chrome with a visible window (launcher Start / tray).
    //   false — we spawned Chrome headless (onboarding / background setup).
    //   null  — we ATTACHED to an externally-launched Chrome via
    //           _tryAttachExisting(); we don't know (and don't control)
    //           its visibility. Used by Lifecycle.startAll() to decide
    //           whether to restart Chrome visibly when the user presses
    //           Start in the launcher (headless → visible transition).
    this.startedVisible = null;
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
   * @param {boolean} [opts.visible=true] — when false, Chrome is spawned
   *   with `--headless=new` and `windowsHide: true` so NO window, tab, or
   *   navigation is ever drawn on screen. This is the mode that MUST be
   *   used for every background/setup call (onboarding's lifecycle.startAll,
   *   the legacy cdp:start-standalone path, the onboarding "Restart Chrome"
   *   button). The user should never see a Chrome window they didn't ask
   *   for; visible Chrome is reserved for the moment the user explicitly
   *   presses Start in the launcher. See the "Launch Sequence UX Strategy"
   *   doc for the full ordering contract.
   */
  async start({ openUrl, skipProfileCopy = false, visible = true, onProgress } = {}) {
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
    //
    // ─── Visibility contract (Launch Sequence UX Strategy) ──────────────
    //
    // `visible` controls whether the spawned Chrome draws a window on
    // screen. The project's inviolable rule: the user should NEVER see a
    // Chrome window they didn't ask for.
    //
    //   visible: true  (default) — Chrome opens a normal visible window.
    //     Used ONLY when the user explicitly pressed Start in the launcher
    //     (or the tray Quick Start). This is the first legitimate moment a
    //     visible browser window is expected.
    //
    //   visible: false — Chrome is spawned with `--headless=new` and
    //     `windowsHide: true` so NO window, tab, or navigation is ever
    //     drawn. Used for every background/setup call: onboarding's
    //     lifecycle.startAll(), the legacy cdp:start-standalone path, and
    //     the onboarding "Restart Chrome" button. Headless Chrome still
    //     exposes the full CDP endpoint (clone, session check, warm-up),
    //     so background work proceeds identically — the user just doesn't
    //     see it.
    //
    // `openUrl` is OPT-IN and must be OMITTED entirely during clone/setup
    // (do not rely on downstream logic to suppress navigation). Only pass
    // it when the launcher explicitly wants to open the web app in a tab
    // post-Start.
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

    // Headless mode for background/setup calls. `--headless=new` (Chrome
    // 109+) runs a real renderer with full CDP support but no visible
    // window — exactly what onboarding needs (clone, session check,
    // warm-up) without stealing focus or showing Chrome's native
    // "Who's using Chrome?" profile picker on an empty user-data-dir.
    if (!visible) {
      args.push("--headless=new");
    }

    // `openUrl` is opt-in. When provided, Chrome opens it in a new tab on
    // launch. This is how the launcher opens the web app INSIDE the CDP
    // Chrome. During clone/setup, callers MUST omit `openUrl` entirely —
    // never pass it and rely on downstream suppression.
    if (openUrl) {
      args.push(openUrl);
      this.logStream.append("cdp", `Will open ${openUrl} on launch.`);
    }


    this.logStream.append("cdp", `Launching Chrome on port ${this.port} (visible=${visible})...`);
    this.child = spawn(this.chromePath, args, {
      cwd: this.cdpProfileDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      // Hide the spawn console window on Windows when headless. Chrome's
      // own window visibility is controlled by `--headless=new` above; this
      // flag only suppresses the OS-level console that Node would otherwise
      // flash on Windows.
      windowsHide: !visible,
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
      // Record the visibility of the Chrome we just spawned so
      // Lifecycle.startAll() can decide whether to restart it visibly
      // when the user presses Start in the launcher (headless → visible
      // transition).
      this.startedVisible = visible;
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
      // We adopted a Chrome we didn't spawn — we don't know whether it's
      // visible or headless, and we don't control it. startedVisible stays
      // null so Lifecycle.startAll() won't try to restart it for visibility.
      this.startedVisible = null;
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

  async restart(options = {}) {
    await this.stop("restart");
    await new Promise((r) => setTimeout(r, 500));
    // Forward onProgress AND visibility to start() so the onboarding
    // Finish screen's "Restart Chrome" button can show clone-stage
    // progress (including a fresh `clone:warning` if the user's real
    // Chrome is STILL holding SQLite locks after the first attempt)
    // WITHOUT flashing a visible Chrome window — onboarding's Restart
    // Chrome stays headless, matching the Launch Sequence UX Strategy.
    // `options.visible` is undefined when not passed, which lets start()
    // apply its own default (visible: true). Callers in onboarding
    // context MUST explicitly pass visible: false.
    await this.start({
      visible: options.visible,
      onProgress: options.onProgress,
    });
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
    // the copy failed before writing any files). On every subsequent
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
    // below starts clean. Otherwise the selective copy below would write
    // into a half-populated dir.
    if (fs.existsSync(defaultProfile) && !profileLooksPopulated) {
      progress("clone", "Existing CDP profile looks empty — re-cloning from your Chrome profile to restore sessions.");
      try {
        await fsp.rm(defaultProfile, { recursive: true, force: true });
      } catch (err) {
        this.logStream.append("cdp:stderr", `Could not remove stale profile dir: ${err.message}`);
      }
    }

    const source = locateUserChromeProfile();
    if (!source || !fs.existsSync(source)) {
      progress("init", "No existing Chrome profile found — starting with a fresh profile. You'll need to log into LinkedIn/X/Facebook/Instagram manually.");
      await fsp.mkdir(this.cdpProfileDir, { recursive: true });
      return;
    }

    // ─── Selective async atomic clone ─────────────────────────────────────
    //
    // Old behavior: `cp -r Default/` minus a small strip list. This copied
    // 5,000–50,000 files (500MB–5GB) including IndexedDB blobs, Local
    // Storage, Media Cache, Service Worker tree, etc. Even after the
    // CHANGES.md §3 fix (async + setImmediate every 50 files), each
    // individual `fs.copyFileSync` of a large file (5–50MB) blocks the
    // Electron main thread for tens-to-hundreds of ms, freezing the UI
    // ("GTSS Growth Engine is not responding" on Windows).
    //
    // New behavior: copy ONLY the small SQLite/JSON files that carry
    // session state (Cookies, Login Data, Local State, Web Data,
    // Preferences, etc.). All I/O is async (`fsp.copyFile` runs on libuv's
    // thread pool, never the main thread), each file is copied atomically
    // (write to `.tmp.<pid>` then rename — a crash mid-copy never leaves a
    // half-populated `Default/`), and copies run in parallel batches of 4
    // for speed. Total clone time drops from 10–60+ seconds to <1 second.
    progress("clone", "Cloning browser sessions from your Chrome — copying cookies and logins only...");
    progress("clone", `Source: ${source}`);
    await fsp.mkdir(this.cdpProfileDir, { recursive: true });
    await fsp.mkdir(defaultProfile, { recursive: true });

    // Determine the source profile dir name: usually "Default", but some
    // Chrome installs only have "Profile 1", "Profile 2", etc. (multi-account
    // setups). Fall back to the first "Profile *" dir we find.
    const sourceDefault = path.join(source, "Default");
    let sourceProfileDir = sourceDefault;
    let sourceProfileLabel = "Default";
    if (!fs.existsSync(sourceDefault)) {
      const profileDirs = (await fsp.readdir(source, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && /^Profile\b/.test(e.name))
        .map((e) => e.name);
      if (profileDirs.length > 0) {
        sourceProfileDir = path.join(source, profileDirs[0]);
        sourceProfileLabel = profileDirs[0];
        progress("clone", `Default profile not found at source; cloning ${profileDirs[0]} instead.`);
      } else {
        // No Default, no Profile N — fall back to a fresh profile.
        progress("init", "Source Chrome profile has no Default or Profile N directory — starting with a fresh profile.");
        return;
      }
    }

    // Copy the session-bearing files in parallel. Each file is copied
    // atomically (write-to-tmp + rename) so a crash mid-clone cannot
    // leave a half-written Cookies/Login Data file that would short-
    // circuit the "profileLooksPopulated" check on the next launch.
    progress("clone", `Copying session files from ${sourceProfileLabel}/...`);
    const copyResults = await cloneSessionFiles(
      sourceProfileDir,
      defaultProfile,
      SESSION_FILES,
      {
        maxBytes: SESSION_FILE_MAX_BYTES,
        concurrency: CLONE_CONCURRENCY,
        onProgress: (msg) => progress("clone", msg),
      },
    );

    // Copy "Local State" — lives at the TOP LEVEL of the source user-data
    // dir (not inside Default/), and is required to decrypt the encrypted
    // cookies/login-data on Windows and macOS (it carries the
    // `os_crypt.encrypted_key` blob, which is itself bound to the user's
    // OS keyring — copying it to the same user's machine preserves
    // decryption). Without this, copied Cookies/Login Data are useless.
    const localState = path.join(source, "Local State");
    if (fs.existsSync(localState)) {
      try {
        await atomicCopyFile(localState, path.join(this.cdpProfileDir, "Local State"), {
          maxBytes: SESSION_FILE_MAX_BYTES,
        });
        copyResults.copied.push("Local State");
      } catch (err) {
        copyResults.skipped.push({ name: "Local State", reason: err.message });
      }
    }

    // ─── Fallback: if NO session files were copied (e.g., source profile
    // is from a fresh Chrome install that has no logins yet), fall back to
    // a recursive copy of the profile dir with the (now expanded) strip
    // list. This is rare and still much smaller than before because the
    // strip list now includes IndexedDB, Local Storage, Sessions, Storage,
    // Service Worker, Media Cache — the actual heavy hitters.
    if (copyResults.copied.length === 0) {
      progress("clone", "No session files found at source — falling back to a full profile copy (caches stripped).");
      await copyDirAsync(sourceProfileDir, defaultProfile, PROFILE_STRIP_DIRS, {
        onProgress: (msg) => progress("clone", msg),
      });
    }

    // ─── Verify the copy actually produced a usable session-bearing file ──
    //
    // If neither Cookies nor Login Data exists in the destination after
    // the clone, the user's source profile is likely LOCKED (their real
    // Chrome is currently running and holding exclusive SQLite locks on
    // these files). We can't read them; the CDP Chrome will start with
    // no sessions.
    //
    // ─── Actionable UI signal (NEW) ──────────────────────────────────────
    //
    // Previously this only emitted a `cdp:stderr` log line and a generic
    // `progress("clone", "...see the warning in the logs.")` message. The
    // user had to dig through the Logs tab to find the actionable advice.
    //
    // Now we emit a dedicated `clone:warning` stage with a self-contained,
    // user-facing message. The launcher's onboarding renderer listens for
    // the `:warning` suffix and shows a first-class warning callout with a
    // "Restart Chrome" button — instead of a buried log line — so the user
    // sees: "Your Chrome is currently open — close it and click Restart
    // Chrome" right on the Finish screen.
    if (!fs.existsSync(cookiesFile) && !fs.existsSync(loginDataFile)) {
      const skippedSummary = copyResults.skipped.length > 0
        ? ` Skipped: ${copyResults.skipped.map((s) => s.name).join(", ")}.`
        : "";
      const stderrMsg =
        `Profile copy did not produce a Cookies or Login Data file.${skippedSummary} ` +
        `If Chrome is currently running, close it and click Restart Chrome so the profile (with your logins) can be copied cleanly.`;
      this.logStream.append("cdp:stderr", stderrMsg);
      // Self-contained actionable message for the UI — the renderer does
      // NOT have access to the log stream, so this string has to carry
      // the entire "what's wrong + what to do" on its own.
      const uiMsg =
        "Your Chrome is currently open and holding a lock on its session files, " +
        "so we couldn't copy your logins. Close Chrome completely, then click " +
        "\"Restart Chrome\" to retry the clone. Your existing logins will be preserved.";
      progress("clone:warning", uiMsg);
      // Also keep the informational progress line so the Logs tab still
      // shows what happened at the clone stage.
      progress("clone", "Profile copied but no sessions found — waiting for Chrome to be closed.");
    } else {
      const count = copyResults.copied.length;
      progress("clone", `Profile clone complete — ${count} session file${count === 1 ? "" : "s"} copied. Your existing logins are preserved.`);
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

// ─── Profile clone helpers (all async, all non-blocking) ────────────────────
//
// These helpers exist to keep the Electron main thread responsive during the
// first-launch profile clone. The previous implementation (CHANGES.md §3)
// used `fs.copyFileSync` per file with a `setImmediate` yield every 50 files
// — but `copyFileSync` is BLOCKING I/O, so each individual large-file copy
// (5–50MB IndexedDB blobs, etc.) blocked the event loop for tens-to-
// hundreds of milliseconds. Over thousands of files, that added up to a
// 10–60+ second main-thread freeze that Windows surfaced as the
// "GTSS Growth Engine is not responding" dialog.
//
// All file I/O in this section uses `fs.promises.*` (`fsp.*`), which runs
// on libuv's thread pool — never the main thread. Combined with the
// whitelist of small session files in `SESSION_FILES`, the clone now
// completes in well under a second.

/**
 * Copy a single file atomically: write to `<dest>.tmp.<pid>` then rename.
 *
 * Why atomic: a crash (or a "GTSS is not responding" force-quit) mid-copy
 * used to leave a half-written Cookies/Login Data file. On the next launch,
 * the half-written file would satisfy the "profileLooksPopulated" check and
 * short-circuit the clone — leaving the user with NO sessions. Writing to a
 * temp file then renaming guarantees the destination is either the old
 * version (or absent) or the complete new version — never anything in
 * between.
 *
 * @param {string} src - absolute source path
 * @param {string} dest - absolute destination path
 * @param {{ maxBytes?: number }} opts - skip files larger than maxBytes
 * @returns {Promise<void>} rejects on any error (caller decides whether to skip)
 */
async function atomicCopyFile(src, dest, opts = {}) {
  const maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : Infinity;

  // Stat the source. We use this both for the size cap and to skip if the
  // source is missing (a non-existent file is reported as a skip, not an
  // error — see cloneSessionFiles).
  const stat = await fsp.stat(src).catch((err) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (!stat || !stat.isFile()) return;
  if (stat.size > maxBytes) {
    const mb = (stat.size / (1024 * 1024)).toFixed(1);
    throw new Error(`file too large (${mb}MB > ${(maxBytes / (1024 * 1024)).toFixed(0)}MB cap)`);
  }

  // Ensure the destination's parent dir exists (handles `Network/Cookies`
  // etc. where the parent subdir may not exist yet).
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  // Write to a per-process temp file in the same dir as the destination,
  // then rename. Same-dir rename is atomic on POSIX and on Windows
  // (NTFS) — cross-dir renames are NOT atomic on Windows, which is why we
  // keep the temp file in the destination dir.
  const tmp = `${dest}.tmp.${process.pid}`;
  // Copy with COPYFILE_EXCL would fail if a stale .tmp exists from a
  // previous crashed run; we just overwrite it via the default (0) flag.
  await fsp.copyFile(src, tmp);
  // On Windows, `fsp.rename` fails with EPERM if the destination exists
  // and is held open by another process (rare, but possible if the user
  // somehow has the CDP Chrome running against the same profile during
  // the clone). Best-effort unlink-then-rename for cross-platform safety.
  try {
    await fsp.rename(tmp, dest);
  } catch (err) {
    if (err.code === "EPERM" || err.code === "EEXIST" || err.code === "ENOTEMPTY") {
      try { await fsp.unlink(dest); } catch (_) {}
      await fsp.rename(tmp, dest);
    } else {
      try { await fsp.unlink(tmp); } catch (_) {}
      throw err;
    }
  }
}

/**
 * Copy a whitelist of session-bearing files from `srcDir` to `destDir`.
 *
 * Files are copied in parallel batches (`opts.concurrency`, default 4).
 * Each file is copied atomically via `atomicCopyFile`. Missing source
 * files are silently skipped (it's normal for, e.g., `Login Data For
 * Account` to be absent on profiles that never saved any passwords).
 * Files that fail to copy (locked, permission-denied, too large) are
 * recorded in the returned `skipped` array so the caller can surface a
 * useful warning to the user.
 *
 * @param {string} srcDir - source profile dir (e.g. .../Default)
 * @param {string} destDir - destination profile dir (e.g. .../chrome-cdp-profile/Default)
 * @param {string[]} files - relative file paths to copy (e.g. ["Cookies", "Login Data", "Network/Cookies"])
 * @param {{ maxBytes?: number, concurrency?: number, onProgress?: (msg: string) => void }} opts
 * @returns {Promise<{copied: string[], skipped: {name: string, reason: string}[]}>}
 */
async function cloneSessionFiles(srcDir, destDir, files, opts = {}) {
  const maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : Infinity;
  const concurrency = Math.max(1, Math.min(16, opts.concurrency || 4));
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

  const copied = [];
  const skipped = [];
  let lastReportAt = Date.now();

  // Pre-filter: stat each candidate once to drop missing files early
  // (saves a stat call inside the parallel copier and lets us show an
  // accurate "copying N of M" count up front).
  const pending = [];
  for (const name of files) {
    const src = path.join(srcDir, name);
    const exists = await fsp.stat(src).then((s) => s.isFile()).catch(() => false);
    if (exists) pending.push(name);
  }

  if (onProgress && pending.length > 0) {
    onProgress(`Copying ${pending.length} session file${pending.length === 1 ? "" : "s"} (cookies, logins, preferences)...`);
  }

  // Simple bounded-concurrency worker pool: index `i` advances as workers
  // grab the next file. Each worker copies one file at a time until the
  // queue is drained.
  let i = 0;
  async function worker() {
    while (i < pending.length) {
      const name = pending[i++];
      const src = path.join(srcDir, name);
      const dest = path.join(destDir, name);
      try {
        await atomicCopyFile(src, dest, { maxBytes });
        copied.push(name);
      } catch (err) {
        skipped.push({ name, reason: err.message || String(err) });
      }
      // Throttle progress messages to ~5/sec so we don't flood the log.
      if (onProgress && Date.now() - lastReportAt > 200) {
        lastReportAt = Date.now();
        onProgress(`Copied ${copied.length}/${pending.length} session files...`);
      }
      // Yield to the event loop between files. fsp.copyFile is non-blocking
      // already, but yielding lets any pending IPC / paint events through
      // — defense in depth for very slow disks where stat+copy can still
      // take 50–100ms per file.
      await new Promise((r) => setImmediate(r));
    }
  }
  const workers = [];
  for (let w = 0; w < concurrency && w < pending.length; w++) workers.push(worker());
  await Promise.all(workers);

  return { copied, skipped };
}

/**
 * Recursive async directory copy with a strip-list. Used ONLY as a fallback
 * when no session files were found at the source (e.g., a fresh Chrome
 * install that has never had any logins). This path is now rare and the
 * strip list (PROFILE_STRIP_DIRS) is much more aggressive than before —
 * it strips IndexedDB, Local Storage, Sessions, Storage, Service Worker,
 * Media Cache, etc., which were the actual heavy hitters causing the
 * 10–60s main-thread freeze.
 *
 * All I/O is async (`fsp.*`), with a `setImmediate` yield between files
 * to keep the Electron main thread responsive even on slow disks.
 *
 * @param {string} src - source directory
 * @param {string} dest - destination directory
 * @param {string[]} stripDirs - directory names (relative to src) to skip
 * @param {{ onProgress?: (msg: string) => void }} opts
 */
async function copyDirAsync(src, dest, stripDirs, opts = {}) {
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  const state = { files: 0, dirs: 0, lastReportAt: Date.now() };
  await _copyDirAsyncInner(src, dest, stripDirs, state, onProgress);
  if (onProgress && state.files > 0) {
    onProgress(`Profile fallback copy finished — ${state.files} files in ${state.dirs} directories.`);
  }
}

async function _copyDirAsyncInner(src, dest, stripDirs, state, onProgress) {
  await fsp.mkdir(dest, { recursive: true });
  let entries;
  try {
    entries = await fsp.readdir(src, { withFileTypes: true });
  } catch (err) {
    // Source dir unreadable (permission denied, etc.) — skip silently.
    return;
  }
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
        await _copyDirAsyncInner(srcPath, destPath, stripDirs, state, onProgress);
      } else if (entry.isFile()) {
        // Skip files > 8MB (probably media caches that slipped through
        // the strip list — defense in depth).
        const stat = await fsp.stat(srcPath);
        if (stat.size > 8 * 1024 * 1024) continue;
        await fsp.copyFile(srcPath, destPath);
        state.files += 1;
        // Report progress at most every ~250ms so we don't flood the log.
        if (onProgress && Date.now() - state.lastReportAt > 250) {
          state.lastReportAt = Date.now();
          onProgress(`Copying profile... ${state.files} files copied`);
        }
        // Yield to the event loop every ~16 files. fsp.copyFile is
        // non-blocking, but yielding keeps IPC / paint events flowing on
        // slow disks. 16 (not 50) for finer-grained responsiveness.
        if (state.files % 16 === 0) {
          await new Promise((r) => setImmediate(r));
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
