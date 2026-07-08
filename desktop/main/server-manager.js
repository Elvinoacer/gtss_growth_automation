/**
 * ServerManager — spawns and supervises the gtss-growth-engine Node.js server
 * as a child process.
 *
 * ─── Runtime strategy ──────────────────────────────────────────────────────
 *
 * The server ALWAYS runs under Electron's bundled Node.js (via
 * `ELECTRON_RUN_AS_NODE=1`), NOT the user's system Node. This is a change
 * from the previous design which preferred system Node and fell back to
 * Electron's Node only when system Node wasn't on PATH.
 *
 * Why the change:
 *
 *  1. End users don't have Node.js installed. The previous design assumed
 *     "the user already has Node.js installed (they ran `npm install` in
 *     gtss-growth-engine/)". That assumption is true in DEVELOPMENT (the
 *     developer ran npm install) but NEVER true for end users installing
 *     the .deb / .exe / .dmg — they have no Node.js, no npm, no git clone.
 *
 *  2. Native modules (better-sqlite3, sharp) inside the bundled
 *     gtss-growth-engine/node_modules/ are rebuilt against ELECTRON's ABI
 *     by the build scripts (scripts/build-*.sh). They will ONLY load under
 *     a runtime with that ABI — i.e., this app's Electron binary. If we
 *     spawned the server with the user's system Node (even if it existed),
 *     `better-sqlite3` would throw `NODE_MODULE_VERSION mismatch` on
 *     require().
 *
 *  3. Using a single, deterministic runtime (Electron's bundled Node)
 *     eliminates a whole class of "works on my machine" bugs caused by
 *     different Node versions on different users' machines.
 *
 * The previous system-Node path is gone. If a power-user genuinely wants
 * to run the server under their own Node (e.g., for debugging with
 * node --inspect), they can clone the repo and run `npm start` inside
 * gtss-growth-engine/ directly.
 *
 * ─── Other design notes ────────────────────────────────────────────────────
 *
 *  - The server's cwd is the gtss-growth-engine source root (read-only
 *    when packaged), so all of the server's `path.join(__dirname, "..",
 *    "public")` references resolve to the bundled static frontend files.
 *    Writable state (uploads, media, DB, sessions, .env) is pointed into
 *    userData via env vars — see EnvBootstrap.getRuntimeEnvOverrides().
 *
 *  - The .env file we wrote into DATA_ROOT is loaded by the server's
 *    existing `require('dotenv').config()` call. We point at it via
 *    DOTENV_CONFIG_PATH.
 *
 *  - Logs are piped into LogStream. The server already logs structured
 *    output to stdout, so we get everything for free.
 *
 *  - Health check: poll the TCP port until it accepts connections. The
 *    server doesn't expose /api/health, but a successful TCP connect
 *    means Express has finished booting.
 *
 *  - Crash diagnostics: when the server exits with a non-zero code, we
 *    scan the last N stderr lines for known error signatures (ABI
 *    mismatch, missing module, port in use) and produce a friendly,
 *    actionable `lastError` the UI can render as an error card.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");

// ─── Error signature matcher ───────────────────────────────────────────────
//
// When the server crashes, scan recent stderr for known signatures and return
// a friendly, actionable diagnostic.

function diagnoseCrash(recentStderr) {
  const text = recentStderr.join("\n").toLowerCase();

  if (text.includes("node_module_version") || text.includes("different node.js version")) {
    return {
      kind: "abi_mismatch",
      title: "Native module needs rebuilding",
      message:
        "better-sqlite3 was compiled for a different Node.js version. Rebuild it for your current Node.",
      remedy: "Run this in a terminal, then click Start again:\n  cd gtss-growth-engine && npm rebuild better-sqlite3",
    };
  }

  if (text.includes("eaddrinuse") || text.includes("port") && text.includes("in use")) {
    return {
      kind: "port_in_use",
      title: "Port already in use",
      message: `Another process is using port ${this?.port || 3000}. Close it, or change the port in the web app's Settings.`,
      remedy: "Stop the other process, or restart your computer if you can't find it.",
    };
  }

  if (text.includes("cannot find module") || text.includes("module not found")) {
    return {
      kind: "missing_module",
      title: "Dependencies not installed",
      message: "The server is missing required Node.js modules.",
      remedy: "Run this in a terminal:\n  cd gtss-growth-engine && npm install",
    };
  }

  if (text.includes("encryption_key") || text.includes("passphrase_hash")) {
    return {
      kind: "config_missing",
      title: "Configuration missing",
      message: "The server needs an encryption key to start. This should have been set during onboarding.",
      remedy: "Use the Settings → Reset passphrase option, or restart the launcher.",
    };
  }

  return null;
}

// ─── ServerManager ─────────────────────────────────────────────────────────

class ServerManager {
  constructor({ serverRoot, dataRoot, logStream, envBootstrap }) {
    this.serverRoot = serverRoot;
    this.dataRoot = dataRoot;
    this.logStream = logStream;
    // EnvBootstrap is needed so we can pull in the writable-path env
    // overrides (UPLOADS_DIR, MEDIA_DIR, CDP_PROFILE_DIR) when spawning
    // the server. Optional only for unit tests.
    this.envBootstrap = envBootstrap || null;
    this.child = null;
    this.state = "stopped"; // stopped | starting | running | stopping | crashed
    this.startedAt = null;
    this.lastError = null;
    this.lastDiagnostic = null; // { kind, title, message, remedy }
    this.port = null;
    this._stderrBuffer = []; // recent stderr lines for crash diagnosis
    this._stderrBufferMax = 200;
  }

  isRunning() {
    return this.state === "running";
  }

  getState() {
    return {
      state: this.state,
      pid: this.child ? this.child.pid : null,
      startedAt: this.startedAt,
      port: this.port,
      lastError: this.lastError,
      lastDiagnostic: this.lastDiagnostic,
      nodeRuntime: this.nodeRuntime || null,
    };
  }

  async start({ port = 3000 } = {}) {
    if (this.child) {
      throw new Error(`Server already running (pid ${this.child.pid})`);
    }
    this.port = port;
    this.state = "starting";
    this.lastError = null;
    this.lastDiagnostic = null;
    this._stderrBuffer = [];
    this.logStream.append("server", `Starting gtss-growth-engine on port ${port}...`);

    const serverEntry = path.join(this.serverRoot, "src", "server.js");
    if (!fs.existsSync(serverEntry)) {
      this.state = "crashed";
      this.lastError = `Server source not found at ${serverEntry}.`;
      this.lastDiagnostic = {
        kind: "missing_source",
        title: "Server source missing",
        message:
          "The gtss-growth-engine source tree is not where the launcher expects it. The installation may be corrupted.",
        remedy: "Reinstall GTSS Growth Engine.",
      };
      throw new Error(this.lastError);
    }

    // ─── Pick the Node.js runtime ────────────────────────────────────────
    //
    // ALWAYS use Electron's bundled Node (process.execPath) with
    // ELECTRON_RUN_AS_NODE=1. See the file-level comment for why we no
    // longer detect / prefer system Node.
    const binary = process.execPath;
    const childEnv = { ...process.env };
    childEnv.ELECTRON_RUN_AS_NODE = "1";
    this.nodeRuntime = `Electron bundled Node (ELECTRON_RUN_AS_NODE=1)`;
    this.logStream.append("server", `Using ${this.nodeRuntime}`);

    // ─── Build env for the child ──────────────────────────────────────────
    //
    // The server calls `require('dotenv').config()` without args, which reads
    // `.env` from process.cwd() (the server's source root). If the user
    // previously ran `setup.sh`, that file exists with a default passphrase
    // and an old ENCRYPTION_KEY — we do NOT want to use those.
    //
    // Solution: load our DATA_ROOT/.env (the one onboarding generated) and
    // inject every value into childEnv. Process env vars take precedence
    // over dotenv-loaded vars, so our values always win.
    const envPath = path.join(this.dataRoot, ".env");
    const ourEnv = loadEnvFile(envPath);
    Object.assign(childEnv, ourEnv);

    childEnv.DOTENV_CONFIG_PATH = envPath;
    childEnv.PORT = String(port);
    childEnv.NODE_ENV = "production";
    // Force data paths into DATA_ROOT (overrides anything in .env so the
    // server always reads from the right place regardless of legacy config).
    childEnv.DB_PATH = path.join(this.dataRoot, "data", "gtss.db");
    childEnv.SESSION_DIR = path.join(this.dataRoot, "sessions");
    childEnv.AUTOMATION_ARTIFACTS_DIR = path.join(this.dataRoot, "artifacts", "automation");
    childEnv.GEMINI_IMAGE_SAVE_DIR = path.join(this.dataRoot, "artifacts", "gemini-images");
    childEnv.AUTOMATION_LOCKS_DIR = path.join(this.dataRoot, "data", "browser-locks");
    // Writable paths for uploads / media / CDP profile. Without these the
    // server would try to write into the read-only <resources>/server/
    // directory and crash on the first write (mkdir EROFS).
    if (this.envBootstrap && typeof this.envBootstrap.getRuntimeEnvOverrides === "function") {
      Object.assign(childEnv, this.envBootstrap.getRuntimeEnvOverrides());
    } else {
      // Defensive fallback (shouldn't happen in normal operation).
      childEnv.UPLOADS_DIR = path.join(this.dataRoot, "public", "uploads");
      childEnv.MEDIA_DIR = path.join(this.dataRoot, "media");
      childEnv.CDP_PROFILE_DIR = path.join(this.dataRoot, "chrome-cdp-profile");
      childEnv.PROFILES_DIR = path.join(this.dataRoot, "profiles");
    }

    this.child = spawn(binary, [serverEntry], {
      cwd: this.serverRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });

    this.logStream.append("server", `Server process spawned (pid ${this.child.pid}). Waiting for it to bind to port ${port}...`);

    this.child.stdout.on("data", (buf) => {
      this.logStream.append("server:stdout", buf.toString("utf8"));
    });
    this.child.stderr.on("data", (buf) => {
      const text = buf.toString("utf8");
      this.logStream.append("server:stderr", text);
      // Buffer recent stderr for crash diagnosis.
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this._stderrBuffer.push(line);
        if (this._stderrBuffer.length > this._stderrBufferMax) {
          this._stderrBuffer.shift();
        }
      }
    });

    this.child.on("exit", (code, signal) => {
      this.logStream.append(
        "server",
        `Server process exited (code=${code} signal=${signal})`,
      );
      this.child = null;
      if (this.state === "stopping") {
        this.state = "stopped";
      } else if (code !== 0 && code !== null) {
        this.state = "crashed";
        this.lastError = `Server exited with code ${code}`;
        this.lastDiagnostic =
          diagnoseCrash.call(this, this._stderrBuffer) || {
            kind: "unknown",
            title: "Server crashed",
            message: `The server exited unexpectedly with code ${code}. Check the Logs tab for details.`,
            remedy: "If this keeps happening, restart the launcher or your computer.",
          };
        this.logStream.append("server:stderr", `Diagnostic: ${this.lastDiagnostic.title}`);
      } else {
        this.state = "stopped";
      }
      this.stopHealthPoller();
    });

    this.child.on("error", (err) => {
      this.logStream.append("server:stderr", `Spawn error: ${err.message}`);
      this.state = "crashed";
      this.lastError = err.message;
      this.lastDiagnostic = {
        kind: "spawn_failed",
        title: "Couldn't start the server",
        message: err.message,
        remedy: "Make sure Node.js is installed and on your PATH.",
      };
      this.child = null;
    });

    // ─── Wait for the port to accept connections ─────────────────────────
    try {
      await this.waitForPort(port, 30000, (elapsedMs) => {
        // Periodic progress callback — emitted every ~5s while we're still
        // waiting. Surfaces in the Logs tab so the user knows the boot is
        // still in progress (e.g., during a long DB migration) rather than
        // silently hung.
        this.logStream.append(
          "server",
          `Still waiting for port ${port} to accept connections (${Math.round(elapsedMs / 1000)}s elapsed)...`,
        );
      });
      this.state = "running";
      this.startedAt = new Date().toISOString();
      this.logStream.append("server", `Server ready on http://localhost:${port}`);
    } catch (err) {
      // The server didn't open the port in time. The child may still be
      // running (e.g., stuck on a long migration) — give it a chance to
      // crash on its own and emit a diagnostic.
      this.lastError = err.message;
      this.lastDiagnostic = {
        kind: "timeout",
        title: "Server didn't start in time",
        message: `The server didn't open port ${port} within 30 seconds. It may be stuck on a long database migration, or it may have crashed.`,
        remedy: "Check the Logs tab. If it's stuck on migration, wait another minute. If it crashed, the error will show above.",
      };
      // Don't throw — let the UI show the diagnostic. The child's exit handler
      // will eventually flip state to crashed.
      this.state = "starting";
    }
  }

  async stop(reason = "user") {
    if (!this.child) {
      this.state = "stopped";
      return;
    }
    this.state = "stopping";
    this.stopHealthPoller();
    this.logStream.append("server", `Stopping server (reason: ${reason})...`);

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
        this.logStream.append("server:stderr", `Failed to signal child: ${err.message}`);
      }

      setTimeout(() => {
        if (this.child) {
          try {
            this.child.kill("SIGKILL");
          } catch (_) {}
        }
        done();
      }, 10000).unref();
    });
  }

  async restart() {
    await this.stop("restart");
    await new Promise((r) => setTimeout(r, 500));
    await this.start({ port: this.port || 3000 });
  }

  // ─── Health check helpers ───────────────────────────────────────────────

  stopHealthPoller() {
    // (retained for future use; currently no periodic poller is started)
  }

  waitForPort(port, timeoutMs, onProgress) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let lastProgressAt = 0;
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
            reject(new Error(`Server did not open port ${port} within ${timeoutMs}ms`));
          } else {
            maybeReportProgress();
            setTimeout(tryConnect, 500);
          }
        });
        socket.once("timeout", () => {
          socket.destroy();
          if (Date.now() - start > timeoutMs) {
            reject(new Error(`Server did not open port ${port} within ${timeoutMs}ms`));
          } else {
            maybeReportProgress();
            setTimeout(tryConnect, 500);
          }
        });
        socket.connect(port, "127.0.0.1");
      };

      // Emit a progress log at most every 5s so a long boot doesn't look
      // silently hung.
      function maybeReportProgress() {
        if (typeof onProgress !== "function") return;
        const now = Date.now();
        if (now - lastProgressAt < 5000) return;
        lastProgressAt = now;
        try {
          onProgress(now - start);
        } catch (_) {}
      }

      tryConnect();
    });
  }

  /** Light HTTP ping used by the UI to show "Running" vs "Starting". */
  async ping() {
    if (!this.port) return false;
    return new Promise((resolve) => {
      const req = http.get(
        `http://127.0.0.1:${this.port}/`,
        { timeout: 1500 },
        (res) => {
          res.resume();
          resolve(res.statusCode < 500);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
  }
}

// ─── .env parser ────────────────────────────────────────────────────────────
//
// Minimal .env reader — enough to load KEY=VALUE pairs from our DATA_ROOT/.env
// into the child process env. We don't need full dotenv semantics (no variable
// interpolation, no quotes stripping beyond simple cases) because we control
// what gets written into this file.

function loadEnvFile(envPath) {
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

module.exports = { ServerManager };
