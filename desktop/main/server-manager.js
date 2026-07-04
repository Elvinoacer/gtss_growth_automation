/**
 * ServerManager — spawns and supervises the gtss-growth-engine Node.js server
 * as a child process.
 *
 * Key design decisions:
 *
 *  - The server is launched with ELECTRON_RUN_AS_NODE=1 so the bundled
 *    Electron binary acts as a pure Node.js runtime. No system Node.js needed.
 *
 *  - The server's cwd is set to the gtss-growth-engine source root, so all
 *    relative path.join(__dirname, "..", "public") references resolve
 *    correctly.
 *
 *  - The .env file we wrote into DATA_ROOT is loaded via the `dotenv` package
 *    the server already requires at startup. We pass our envPath via the
 *    DOTENV_CONFIG_PATH env var so dotenv picks up the right file.
 *
 *  - Logs are captured by piping stdout/stderr into the LogStream. The server
 *    already writes structured logs to stdout, so we get everything for free.
 *
 *  - Health check: poll http://localhost:PORT/api/health (returns 200 once the
 *    server is ready). The server doesn't currently expose /api/health, so we
 *    fall back to TCP-port-open detection.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");

class ServerManager {
  constructor({ serverRoot, dataRoot, logStream }) {
    this.serverRoot = serverRoot;
    this.dataRoot = dataRoot;
    this.logStream = logStream;
    this.child = null;
    this.state = "stopped"; // stopped | starting | running | stopping | crashed
    this.startedAt = null;
    this.lastError = null;
    this.healthPoller = null;
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
    };
  }

  async start({ port = 3000 } = {}) {
    if (this.child) {
      throw new Error(`Server already running (pid ${this.child.pid})`);
    }
    this.port = port;
    this.state = "starting";
    this.lastError = null;
    this.logStream.append("server", `Starting gtss-growth-engine on port ${port}...`);

    const serverEntry = path.join(this.serverRoot, "src", "server.js");
    if (!fs.existsSync(serverEntry)) {
      this.state = "crashed";
      this.lastError = `Server entry not found: ${serverEntry}`;
      throw new Error(this.lastError);
    }

    const envPath = path.join(this.dataRoot, ".env");

    // Build the env for the child. We use the parent's env as a base so PATH
    // (needed for Chrome discovery) is preserved, then layer our overrides on
    // top.
    const childEnv = { ...process.env };
    childEnv.ELECTRON_RUN_AS_NODE = "1";
    childEnv.DOTENV_CONFIG_PATH = envPath;
    childEnv.PORT = String(port);
    childEnv.NODE_ENV = "production";
    childEnv.DB_PATH = childEnv.DB_PATH || path.join(this.dataRoot, "data", "gtss.db");
    childEnv.SESSION_DIR = childEnv.SESSION_DIR || path.join(this.dataRoot, "sessions");
    childEnv.AUTOMATION_ARTIFACTS_DIR =
      childEnv.AUTOMATION_ARTIFACTS_DIR || path.join(this.dataRoot, "artifacts", "automation");
    childEnv.GEMINI_IMAGE_SAVE_DIR =
      childEnv.GEMINI_IMAGE_SAVE_DIR || path.join(this.dataRoot, "artifacts", "gemini-images");
    childEnv.AUTOMATION_LOCKS_DIR =
      childEnv.AUTOMATION_LOCKS_DIR || path.join(this.dataRoot, "data", "browser-locks");

    this.child = spawn(process.execPath, [serverEntry], {
      cwd: this.serverRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    this.child.stdout.on("data", (buf) => {
      this.logStream.append("server:stdout", buf.toString("utf8"));
    });
    this.child.stderr.on("data", (buf) => {
      this.logStream.append("server:stderr", buf.toString("utf8"));
    });

    this.child.on("exit", (code, signal) => {
      this.logStream.append(
        "server",
        `Server process exited (code=${code} signal=${signal})`,
      );
      this.child = null;
      if (this.state === "stopping") {
        this.state = "stopped";
      } else {
        this.state = "crashed";
        this.lastError = `Exited unexpectedly with code ${code}`;
      }
      this.stopHealthPoller();
    });

    this.child.on("error", (err) => {
      this.logStream.append("server:stderr", `Spawn error: ${err.message}`);
      this.state = "crashed";
      this.lastError = err.message;
      this.child = null;
    });

    // Poll the port until it's accepting connections.
    await this.waitForPort(port, 30000);
    this.state = "running";
    this.startedAt = new Date().toISOString();
    this.logStream.append("server", `Server ready on http://localhost:${port}`);
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

      // Send SIGTERM for graceful shutdown. On Windows, send a soft kill.
      try {
        if (process.platform === "win32") {
          this.child.kill();
        } else {
          this.child.kill("SIGTERM");
        }
      } catch (err) {
        this.logStream.append("server:stderr", `Failed to signal child: ${err.message}`);
      }

      // Force-kill after 10s if still alive.
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

  // ─── Health check ─────────────────────────────────────────────────────────

  stopHealthPoller() {
    if (this.healthPoller) {
      clearInterval(this.healthPoller);
      this.healthPoller = null;
    }
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

module.exports = { ServerManager };
