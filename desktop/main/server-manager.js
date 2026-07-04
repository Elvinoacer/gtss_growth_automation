/**
 * ServerManager — spawns and supervises the gtss-growth-engine Node.js server
 * as a child process.
 *
 * ─── Runtime strategy ──────────────────────────────────────────────────────
 *
 * The server's `node_modules/` (especially `better-sqlite3`) are compiled
 * against the user's SYSTEM Node.js ABI. If we spawn the server using
 * Electron's bundled Node.js, the ABI won't match and `better-sqlite3` will
 * throw `NODE_MODULE_VERSION mismatch`.
 *
 * Solution: detect and use the system `node` binary. The user already has
 * Node.js installed (they ran `npm install` in gtss-growth-engine/ — that's
 * the only way `node_modules/` could exist).
 *
 * Fallback: if for some reason system Node isn't on PATH (rare), we fall back
 * to `ELECTRON_RUN_AS_NODE=1` using Electron's bundled Node, and emit a
 * warning. In that case `better-sqlite3` may fail to load — the user will
 * see a clear error card in the UI telling them to run `npm rebuild`.
 *
 * ─── Other design notes ────────────────────────────────────────────────────
 *
 *  - The server's cwd is the gtss-growth-engine source root, so all of the
 *    server's `path.join(__dirname, "..", "public")` references resolve.
 *
 *  - The .env file we wrote into DATA_ROOT is loaded by the server's existing
 *    `require('dotenv').config()` call. We point at it via DOTENV_CONFIG_PATH.
 *
 *  - Logs are piped into LogStream. The server already logs structured output
 *    to stdout, so we get everything for free.
 *
 *  - Health check: poll the TCP port until it accepts connections. The server
 *    doesn't expose /api/health, but a successful TCP connect means Express
 *    has finished booting.
 *
 *  - Crash diagnostics: when the server exits with a non-zero code, we scan
 *    the last N stderr lines for known error signatures (ABI mismatch,
 *    missing module, port in use) and produce a friendly, actionable
 *    `lastError` the UI can render as an error card.
 */

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");

// ─── System Node detection ─────────────────────────────────────────────────

let _cachedSystemNode = undefined;

function findSystemNode() {
  if (_cachedSystemNode !== undefined) return _cachedSystemNode;

  // Try `node` from PATH.
  try {
    const result = spawnSync("node", ["--version"], {
      encoding: "utf-8",
      shell: process.platform === "win32",
      timeout: 3000,
    });
    if (result.status === 0) {
      const version = result.stdout.trim(); // e.g. "v20.18.3"
      const major = parseInt(version.replace(/^v/, "").split(".")[0], 10);
      if (major >= 18) {
        _cachedSystemNode = { binary: "node", version, major };
        return _cachedSystemNode;
      }
    }
  } catch (_) {
    // `node` not on PATH — fall through.
  }

  // Try common absolute paths as a last resort.
  const candidates =
    process.platform === "win32"
      ? [
          path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
          path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs", "node.exe"),
        ]
      : ["/usr/bin/node", "/usr/local/bin/node", "/opt/homebrew/bin/node"];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      try {
        const result = spawnSync(c, ["--version"], { encoding: "utf-8", timeout: 3000 });
        if (result.status === 0) {
          const version = result.stdout.trim();
          const major = parseInt(version.replace(/^v/, "").split(".")[0], 10);
          if (major >= 18) {
            _cachedSystemNode = { binary: c, version, major };
            return _cachedSystemNode;
          }
        }
      } catch (_) {}
    }
  }

  _cachedSystemNode = null;
  return _cachedSystemNode;
}

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
  constructor({ serverRoot, dataRoot, logStream }) {
    this.serverRoot = serverRoot;
    this.dataRoot = dataRoot;
    this.logStream = logStream;
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

    // ─── Pick a Node.js runtime ────────────────────────────────────────────
    const sysNode = findSystemNode();
    let binary;
    let useElectronNode = false;
    const childEnv = { ...process.env };

    if (sysNode) {
      binary = sysNode.binary;
      this.nodeRuntime = `system Node ${sysNode.version}`;
      this.logStream.append("server", `Using ${this.nodeRuntime}`);
      // Don't set ELECTRON_RUN_AS_NODE — we're using system Node, not Electron.
      delete childEnv.ELECTRON_RUN_AS_NODE;
    } else {
      // Fallback: Electron's bundled Node. This may cause ABI mismatches with
      // native modules like better-sqlite3. Emit a clear warning.
      binary = process.execPath;
      useElectronNode = true;
      childEnv.ELECTRON_RUN_AS_NODE = "1";
      this.nodeRuntime = "Electron bundled Node (fallback)";
      this.logStream.append(
        "server:stderr",
        "WARNING: System Node.js not found on PATH. Falling back to Electron's bundled Node. " +
          "If better-sqlite3 fails to load, install Node.js 18+ from https://nodejs.org/ and restart.",
      );
    }

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

    this.child = spawn(binary, [serverEntry], {
      cwd: this.serverRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });

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
      await this.waitForPort(port, 30000);
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
            reject(new Error(`Server did not open port ${port} within ${timeoutMs}ms`));
          } else {
            setTimeout(tryConnect, 500);
          }
        });
        socket.once("timeout", () => {
          socket.destroy();
          if (Date.now() - start > timeoutMs) {
            reject(new Error(`Server did not open port ${port} within ${timeoutMs}ms`));
          } else {
            setTimeout(tryConnect, 500);
          }
        });
        socket.connect(port, "127.0.0.1");
      };
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
