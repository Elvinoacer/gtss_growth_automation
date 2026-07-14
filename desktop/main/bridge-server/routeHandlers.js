/**
 * bridge-server/routeHandlers.js
 *
 * All BridgeServer route handlers, extracted from the original _route
 * method as standalone functions. Each handler takes (method, pathname,
 * body, server) and returns either:
 *   - a result object (if it handled the request), or
 *   - null (if it did NOT handle the request — dispatcher tries the next)
 *
 * `server` is the BridgeServer instance, so handlers can reach
 * `server.cdp`, `server.env`, `server.log`, `server.firstRun`,
 * `server.lifecycle`, `server.port`, plus the instance sentinel helpers
 * (`server._isSigninComplete()`, `server._markSigninComplete()`,
 * `server._clearSigninComplete()`).
 *
 * `dispatchRoute(method, pathname, body, server)` is the public entry
 * point: it iterates every handler in order and returns the first
 * non-null result. If no handler matches, it returns the canonical
 * "Not found" error object (preserving the original behavior).
 *
 * Endpoints handled (same as the original _route):
 *   GET  /api/bridge/health
 *   GET  /api/bridge/state
 *   GET  /api/bridge/cdp/sessions
 *   POST /api/bridge/cdp/ensure-visible
 *   POST /api/bridge/cdp/open-login
 *   POST /api/bridge/cdp/restart
 *   POST /api/bridge/cdp/open-webapp-in-cdp
 *   GET  /api/bridge/settings/browser-mode
 *   POST /api/bridge/settings/browser-mode
 *   POST /api/bridge/signin/complete
 *   POST /api/bridge/signin/reset
 */

const { PLATFORMS } = require("./constants");

// ─── Health ──────────────────────────────────────────────────────────────
function handleHealth(method, pathname) {
  if (method === "GET" && pathname === "/api/bridge/health") {
    return { ok: true, ts: Date.now() };
  }
  return null;
}

// ─── State ───────────────────────────────────────────────────────────────
// Everything the web app's sign-in modal needs in one call.
async function handleState(method, pathname, _body, server) {
  if (method !== "GET" || pathname !== "/api/bridge/state") return null;

  const env = server.env.readEnv();
  const browserMode =
    String(env.CDP_VISIBLE_DEFAULT || "").toLowerCase() === "true"
      ? "visible"
      : "background";
  const signinCompleted = server._isSigninComplete();
  const firstRunRequired = await server.firstRun.isRequired();
  let sessions = null;
  if (server.cdp.isRunning()) {
    try {
      sessions = await server.cdp.checkSessions();
    } catch (_) {
      sessions = null;
    }
  }
  return {
    ok: true,
    cdp: server.cdp.getState(),
    sessions,
    platforms: PLATFORMS,
    signinCompleted,
    firstRunRequired,
    browserMode,
    bridgePort: server.port,
  };
}

// ─── Sessions ────────────────────────────────────────────────────────────
async function handleSessions(method, pathname, _body, server) {
  if (method !== "GET" || pathname !== "/api/bridge/cdp/sessions") return null;
  if (!server.cdp.isRunning()) {
    return { ok: true, sessions: null, running: false };
  }
  const sessions = await server.cdp.checkSessions();
  return { ok: true, sessions, running: true };
}

// ─── Ensure CDP visible ──────────────────────────────────────────────────
// Called by the server-side createBrowser() when a LOGIN session is being
// launched in CDP mode. The server can't restart CDP itself, so it asks the
// bridge to make sure Chrome is running VISIBLY before the login tab opens.
async function handleEnsureVisible(method, pathname, _body, server) {
  if (method !== "POST" || pathname !== "/api/bridge/cdp/ensure-visible") return null;

  try {
    if (!server.cdp.isRunning()) {
      server.log.append("lifecycle", "Bridge: starting CDP visibly for login session...");
      await server.cdp.start({
        skipProfileCopy: false,
        visible: true,
        onProgress: (_stage, message) => {
          try { server.log.append("cdp", message); } catch (_) {}
        },
      });
      server.env.upsert("CDP_ENDPOINT", `http://127.0.0.1:${server.cdp.port}`);
      server.env.upsert("BROWSER_MODE", "cdp");
    } else if (server.cdp.startedVisible === false) {
      // CDP is running headless — restart visibly so the user can see the
      // login tab. This is the key fix for the "sometimes the browser shows,
      // sometimes it doesn't" abnormality: when the launcher started Chrome
      // in background mode (per the user's Settings → Automation Browser =
      // "Background" choice) and the user then clicks Login / Re-authenticate
      // on the dashboard modal, we bring Chrome to the foreground so the
      // login tab is visible.
      server.log.append("lifecycle", "Bridge: bringing headless Chrome to the foreground for login session...");
      await server.cdp.stop("bridge-login-visibility");
      await server.cdp.start({
        visible: true,
        onProgress: (_stage, message) => {
          try { server.log.append("cdp", message); } catch (_) {}
        },
      });
    } else {
      // Already running visibly — nothing to do.
      server.log.append("lifecycle", "Bridge: CDP already visible for login session.");
    }
    return {
      ok: true,
      cdpState: server.cdp.getState(),
      cdpEndpoint: server.cdp.isRunning()
        ? `http://127.0.0.1:${server.cdp.port}`
        : null,
    };
  } catch (err) {
    server.log.append("lifecycle:stderr", `Bridge: ensure-visible failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ─── Open platform login tab ─────────────────────────────────────────────
// The web app's modal calls this when the user clicks "Open in Chrome" on a
// platform card. We ensure CDP is up + visible, then open the platform's
// login URL in a new tab. Cookies land directly in the CDP Chrome's profile.
async function handleOpenLogin(method, pathname, body, server) {
  if (method !== "POST" || pathname !== "/api/bridge/cdp/open-login") return null;

  const platform = body && body.platform;
  const p = PLATFORMS.find((x) => x.key === platform);
  if (!p) throw new Error(`Unknown platform: ${platform}`);

  // Ensure CDP is up + visible.
  if (!server.cdp.isRunning()) {
    try {
      server.log.append("lifecycle", `Bridge: starting CDP visibly for ${p.label} sign-in...`);
      await server.cdp.start({
        skipProfileCopy: false,
        visible: true,
        onProgress: (_stage, message) => {
          try { server.log.append("cdp", message); } catch (_) {}
        },
      });
      server.env.upsert("CDP_ENDPOINT", `http://127.0.0.1:${server.cdp.port}`);
      server.env.upsert("BROWSER_MODE", "cdp");
    } catch (err) {
      return { ok: false, error: `Could not start Chrome: ${err.message}` };
    }
  } else if (server.cdp.startedVisible === false) {
    // CDP is running headless — restart visibly so the user can see the
    // login tab.
    try {
      server.log.append("lifecycle", "Bridge: bringing headless Chrome to the foreground for sign-in...");
      await server.cdp.stop("bridge-visibility-change");
      await server.cdp.start({
        visible: true,
        onProgress: (_stage, message) => {
          try { server.log.append("cdp", message); } catch (_) {}
        },
      });
    } catch (err) {
      return { ok: false, error: `Could not bring Chrome to foreground: ${err.message}` };
    }
  }

  const ok = await server.cdp.openTab(p.loginUrl);
  if (!ok) {
    return { ok: false, error: `Could not open ${p.label} login tab in the CDP Chrome.` };
  }
  server.log.append("lifecycle", `Bridge: opened ${p.label} login tab in CDP Chrome.`);
  return { ok: true, cdpState: server.cdp.getState(), loginUrl: p.loginUrl };
}

// ─── Restart CDP (re-clone profile) ──────────────────────────────────────
async function handleRestart(method, pathname, body, server) {
  if (method !== "POST" || pathname !== "/api/bridge/cdp/restart") return null;

  const visible = body && typeof body.visible === "boolean"
    ? body.visible
    : true;
  try {
    await server.cdp.restart({
      visible,
      onProgress: (_stage, message) => {
        try { server.log.append("cdp", message); } catch (_) {}
      },
    });
    server.env.upsert("CDP_ENDPOINT", `http://127.0.0.1:${server.cdp.port}`);
    server.env.upsert("BROWSER_MODE", "cdp");
    return { ok: true, cdpState: server.cdp.getState() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Open web app inside CDP Chrome ──────────────────────────────────────
// Used when the web app is currently loaded in the user's default browser
// but the user wants to sign in / re-authenticate — clicking this switches
// them INTO the CDP Chrome where cookies set during login are the ones
// automation uses.
async function handleOpenWebappInCdp(method, pathname, _body, server) {
  if (method !== "POST" || pathname !== "/api/bridge/cdp/open-webapp-in-cdp") return null;

  const port = (server.lifecycle.server && server.lifecycle.server.port) || 3000;
  const webAppUrl = `http://localhost:${port}`;
  if (!server.cdp.isRunning()) {
    try {
      await server.cdp.start({
        visible: true,
        onProgress: (_stage, message) => {
          try { server.log.append("cdp", message); } catch (_) {}
        },
      });
      server.env.upsert("CDP_ENDPOINT", `http://127.0.0.1:${server.cdp.port}`);
      server.env.upsert("BROWSER_MODE", "cdp");
    } catch (err) {
      return { ok: false, error: `Could not start Chrome: ${err.message}` };
    }
  } else if (server.cdp.startedVisible === false) {
    try {
      await server.cdp.stop("bridge-visibility-change");
      await server.cdp.start({ visible: true });
    } catch (err) {
      return { ok: false, error: `Could not bring Chrome to foreground: ${err.message}` };
    }
  }
  const ok = await server.cdp.openTab(webAppUrl);
  return { ok, webAppUrl };
}

// ─── Browser-mode setting ────────────────────────────────────────────────
function handleBrowserModeGet(method, pathname, _body, server) {
  if (method !== "GET" || pathname !== "/api/bridge/settings/browser-mode") return null;

  const env = server.env.readEnv();
  const mode =
    String(env.CDP_VISIBLE_DEFAULT || "").toLowerCase() === "true"
      ? "visible"
      : "background";
  return { ok: true, mode };
}

function handleBrowserModePost(method, pathname, body, server) {
  if (method !== "POST" || pathname !== "/api/bridge/settings/browser-mode") return null;

  const mode = body && body.mode;
  if (mode !== "background" && mode !== "visible") {
    throw new Error("mode must be 'background' or 'visible'");
  }
  server.env.upsert("CDP_VISIBLE_DEFAULT", mode === "visible" ? "true" : "false");
  server.log.append("lifecycle", `Bridge: browser mode set to '${mode}' (applies on next Start).`);
  return { ok: true, mode };
}

// ─── Sign-in sentinel ────────────────────────────────────────────────────
function handleSigninComplete(method, pathname, _body, server) {
  if (method !== "POST" || pathname !== "/api/bridge/signin/complete") return null;

  server._markSigninComplete();
  return { ok: true };
}

function handleSigninReset(method, pathname, _body, server) {
  if (method !== "POST" || pathname !== "/api/bridge/signin/reset") return null;

  server._clearSigninComplete();
  return { ok: true };
}

// ─── Dispatcher ──────────────────────────────────────────────────────────
// Ordered list of every route handler. Order doesn't matter functionally
// (each handler matches on method + pathname and returns null otherwise),
// but the order here mirrors the original _route for readability.
const HANDLERS = [
  handleHealth,
  handleState,
  handleSessions,
  handleEnsureVisible,
  handleOpenLogin,
  handleRestart,
  handleOpenWebappInCdp,
  handleBrowserModeGet,
  handleBrowserModePost,
  handleSigninComplete,
  handleSigninReset,
];

/**
 * Run each handler in order until one returns a non-null result.
 * Returns the canonical "Not found" error object if no handler matches.
 */
async function dispatchRoute(method, pathname, body, server) {
  for (const handler of HANDLERS) {
    const result = await handler(method, pathname, body, server);
    if (result !== null && result !== undefined) {
      return result;
    }
  }
  return { ok: false, error: `Not found: ${method} ${pathname}` };
}

module.exports = { dispatchRoute, HANDLERS };
