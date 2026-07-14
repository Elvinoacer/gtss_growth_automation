/**
 * Browser Base — CDP Bridge Probe & Chrome Launcher
 * isPortOpen, getPortFromEndpoint, findBridgeBase, ensureCdpVisibleViaBridge,
 * launchCdpChrome — utilities for locating the desktop launcher's localhost
 * bridge, asking it to make the shared CDP Chrome visible, and launching a
 * standalone CDP-enabled Chrome process when the bridge is absent.
 * Extracted from the original browserBase.js for maintainability.
 *
 * NOTE: __dirname in this split file resolves one level deeper than the
 * original (src/automation/browserBase/ vs src/automation/), so the path to
 * scripts/launch-chrome.sh has an extra ".." segment compared to the
 * original.
 */

const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const logger = require("../../utils/logger");
const { shouldAutoLaunchCdp } = require("./env");

// ─── Bridge probe (login-session visibility) ───────────────────────────────
//
// The desktop launcher (Electron main process) runs a tiny localhost-only
// HTTP "bridge" server on port 9224 (auto-incrementing to 9225/9226/9227
// if taken). The bridge is the only thing that can reliably restart a
// headless CDP Chrome visibly — it OWNS the Chrome child process via
// CdpManager, so it can stop() and start({visible:true}) it.
//
// From the server side (this file runs in the forked Node server, not in
// Electron), we can't restart CDP ourselves — we don't own the process.
// So for login sessions, we probe the bridge and ask IT to bring Chrome
// to the foreground before we connectOverCDP(). If the bridge is not
// reachable (standalone server, no launcher), we fall back to a visible
// persistent browser so the login window is ALWAYS shown — eliminating
// the "sometimes the browser shows, sometimes it doesn't" abnormality.
const BRIDGE_PORTS = [9224, 9225, 9226, 9227];
const BRIDGE_PROBE_CACHE = { base: null, checked: false };

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const onError = () => {
      socket.destroy();
      resolve(false);
    };
    socket.setTimeout(1000);
    socket.once("error", onError);
    socket.once("timeout", onError);
    socket.connect(port, "127.0.0.1", () => {
      socket.end();
      resolve(true);
    });
  });
}

function getPortFromEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return parseInt(url.port) || 9222;
  } catch (_) {
    const match = endpoint.match(/:(\d+)/);
    return match ? parseInt(match[1]) : 9222;
  }
}

async function findBridgeBase() {
  if (BRIDGE_PROBE_CACHE.checked) return BRIDGE_PROBE_CACHE.base;
  BRIDGE_PROBE_CACHE.checked = true;
  // http is required lazily so this module remains importable in test
  // environments that stub out Node's http (and to avoid paying the
  // require cost when no login session ever runs).
  const http = require("http");
  for (const port of BRIDGE_PORTS) {
    const reachable = await new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/bridge/health",
          method: "GET",
          timeout: 600,
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
    if (reachable) {
      BRIDGE_PROBE_CACHE.base = `http://127.0.0.1:${port}`;
      return BRIDGE_PROBE_CACHE.base;
    }
  }
  return null;
}

/**
 * Ask the desktop launcher's bridge to ensure the shared CDP Chrome is
 * running VISIBLY. Used ONLY by login sessions (createBrowser with
 * options.loginSession === true and mode === "cdp").
 *
 * Returns true if the bridge confirmed CDP is visible (or made it
 * visible). Returns false if the bridge is not reachable — in that case
 * the caller MUST fall back to a visible persistent browser so the
 * login window is still shown.
 */
async function ensureCdpVisibleViaBridge() {
  const base = await findBridgeBase();
  if (!base) return false;
  const http = require("http");
  const ok = await new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(base.split(":").pop()),
        path: "/api/bridge/cdp/ensure-visible",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeout: 20000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const data = body ? JSON.parse(body) : {};
            resolve(Boolean(data && data.ok));
          } catch (_) {
            resolve(false);
          }
        });
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end(JSON.stringify({}));
  });
  return ok;
}

async function launchCdpChrome(port = 9222) {
  if (!shouldAutoLaunchCdp()) {
    logger.info(
      "BROWSER",
      `CDP port ${port} is closed and CDP auto-launch is disabled.`,
    );
    return false;
  }

  logger.info("BROWSER", `CDP port ${port} is closed. Launching Chrome with remote debugging...`);
  // __dirname here is src/automation/browserBase/, so the scripts dir is
  // three levels up: ../../../scripts/launch-chrome.sh
  const scriptPath = path.resolve(__dirname, "..", "..", "..", "scripts", "launch-chrome.sh");
  const env = { ...process.env, CDP_PORT: String(port) };

  const child = spawn("bash", [scriptPath], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();

  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await isPortOpen(port)) {
      logger.info("BROWSER", `Chrome CDP started successfully and is listening on port ${port}.`);
      return true;
    }
  }
  logger.warn("BROWSER", `Failed to detect Chrome CDP listening on port ${port} after 5 seconds.`);
  return false;
}

module.exports = {
  isPortOpen,
  getPortFromEndpoint,
  findBridgeBase,
  ensureCdpVisibleViaBridge,
  launchCdpChrome,
};
