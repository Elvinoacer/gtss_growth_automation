/**
 * cdp-manager/cdpLifecycle.js — Lifecycle methods for CdpManager.
 *
 * Originally part of the monolithic desktop/main/cdp-manager.js. Attaches
 * the Chrome-process lifecycle methods to CdpManager.prototype:
 *   - start()              — the try-first-then-clone spawn sequence
 *                            (attach if possible, else locate + clone +
 *                            spawn + wait-for-port)
 *   - stop()               — detach (if external) or signal-and-wait
 *   - restart()            — stop + brief pause + start
 *   - _tryAttachExisting() — probe /json/version and adopt if Chrome is up
 *   - waitForPort()        — TCP probe loop that resolves once Chrome opens
 *                            its CDP port (or rejects after timeoutMs)
 *
 * The class skeleton lives in cdpManagerClass.js. This file imports the
 * class, attaches methods to its prototype, and re-exports it for
 * convenience — index.js requires this file for its side effect of
 * populating the prototype.
 */

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const http = require("http");
const { CdpManager } = require("./cdpManagerClass");
const { locateChrome } = require("./chromeDiscovery");

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
CdpManager.prototype.start = async function start({ openUrl, skipProfileCopy = false, visible = true, onProgress } = {}) {
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
    // Pin the launch to the single "Default" profile inside cdpProfileDir
    // — the only profile directory the CDP clone ever creates (see
    // ensureCdpProfile). This is the second, independent layer of
    // defense against Chrome's "Who's using Chrome?" profile picker.
    //
    // The picker is driven by `profile.info_cache` inside the copied
    // Local State file, NOT by whether user-data-dir is empty (that was
    // the old, incorrect assumption — see the comment on the `visible`
    // check below). ensureCdpProfile() now sanitizes that cache down to
    // a single Default entry on every clone, which handles the picker
    // at the source. `--profile-directory=Default` backs that up: even
    // if Local State is missing, unreadable, or a future change to the
    // clone logic reintroduces multiple cached profiles, this flag
    // still tells Chrome exactly which profile to open immediately,
    // with no picker interstitial in between.
    "--profile-directory=Default",
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
  // warm-up) without stealing focus. (Headless Chrome never shows the
  // profile picker regardless of info_cache contents, since there's no
  // window to draw it in — but visible launches need the two defenses
  // above, which is why they're unconditional rather than gated on
  // `visible`.)
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
};

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
CdpManager.prototype._tryAttachExisting = async function _tryAttachExisting(progress) {
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
};

/**
 * Internal: GET /json/version from the CDP endpoint. Returns the parsed
 * JSON object (containing Browser, webSocketDebuggerUrl, etc.) or null
 * on any error. Used by _tryAttachExisting() to detect an already-running
 * Chrome without spawning one.
 *
 * @private
 */
CdpManager.prototype._getCdpVersionInfo = function _getCdpVersionInfo() {
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
};

CdpManager.prototype.stop = async function stop(reason = "user") {
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
};

CdpManager.prototype.restart = async function restart(options = {}) {
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
};

// ─── Health check ─────────────────────────────────────────────────────────

CdpManager.prototype.waitForPort = function waitForPort(port, timeoutMs) {
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
};

module.exports = { CdpManager };
