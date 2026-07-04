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
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");

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

  async start() {
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
