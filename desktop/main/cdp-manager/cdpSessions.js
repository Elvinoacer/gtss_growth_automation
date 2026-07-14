/**
 * cdp-manager/cdpSessions.js — CDP HTTP + WebSocket session/tab/cookie
 * methods for CdpManager.
 *
 * Originally part of the monolithic desktop/main/cdp-manager.js. Attaches
 * the CDP-protocol methods to CdpManager.prototype:
 *   - openTab(url)           — open a new tab via the DevTools HTTP API
 *                              (PUT /json/new?<url>); used by the launcher's
 *                              "Open Web App" button so the web app opens in
 *                              the SAME Chrome that handles automation.
 *   - openLoginTabs(keys)    — open the per-platform login URLs sequentially
 *                              (used by onboarding's "Sign in to your
 *                              accounts" step).
 *   - checkSessions()        — open a transient CDP WebSocket, call
 *                              Network.getAllCookies, then report which
 *                              platforms have an active login cookie.
 *                              Used by the onboarding wizard to gate the
 *                              "Continue" button on the user being logged in.
 *   - _listTargets()         — internal: GET /json/list, return array of
 *                              targets. Used by checkSessions().
 *   - _getAllCookiesViaWs()  — internal: open a CDP WebSocket, send
 *                              Network.getAllCookies, parse, close. Used by
 *                              checkSessions().
 *
 * The class skeleton lives in cdpManagerClass.js. This file imports the
 * class, attaches methods to its prototype, and re-exports it for
 * convenience — index.js requires this file for its side effect of
 * populating the prototype.
 */

"use strict";

const http = require("http");
const { CdpManager } = require("./cdpManagerClass");
const { SESSION_COOKIE_SIGNATURES, PLATFORM_LOGIN_URLS } = require("./constants");

/**
 * Open a new tab in the running CDP Chrome via the DevTools HTTP API.
 * Used by the "Open Web App" button — this way the web app opens in the
 * SAME Chrome that handles automation, not the user's default browser.
 *
 * Returns true on success, false if CDP isn't running or the request fails.
 */
CdpManager.prototype.openTab = async function openTab(url) {
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
};

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
CdpManager.prototype.openLoginTabs = async function openLoginTabs(platforms) {
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
};

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
CdpManager.prototype.checkSessions = async function checkSessions() {
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
};

/**
 * Internal: GET /json/list from the CDP endpoint and return the array
 * of targets. Returns [] on any error.
 */
CdpManager.prototype._listTargets = function _listTargets() {
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
};

/**
 * Internal: connect to a CDP target's WebSocket, call Network.getAllCookies,
 * and return the array of cookies. Uses the global WebSocket constructor
 * (available in Node 22+ and Electron 33+).
 *
 * We attach the listener BEFORE we send the request and wait for either
 * the matching response (same `id`) or a 4-second timeout — whichever
 * comes first. The socket is always closed in the finally block.
 */
CdpManager.prototype._getAllCookiesViaWs = function _getAllCookiesViaWs(wsUrl) {
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
};

module.exports = { CdpManager };
