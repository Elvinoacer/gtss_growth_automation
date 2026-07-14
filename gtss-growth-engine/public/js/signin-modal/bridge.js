/**
 * signin-modal/bridge.js — Network helpers to talk to the GTSS desktop bridge
 * (127.0.0.1:9224, with auto-increment fallback ports 9225/9226/9227).
 *
 * Includes: findBridge, bridgeFetch.
 *
 * Original signin-modal.js was 656 lines; this is one of its thematic splits.
 */

"use strict";

// Probe the candidate bridge ports in order and cache the first one that
// responds with a 2xx on /api/bridge/health.
async function findBridge() {
  if (bridgeChecked) return bridgeBase;
  bridgeChecked = true;
  for (const port of BRIDGE_PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/bridge/health`, {
        method: "GET",
      });
      if (res.ok) {
        bridgeBase = `http://127.0.0.1:${port}`;
        return bridgeBase;
      }
    } catch (_) {
      // Port not answering — try the next.
    }
  }
  return null;
}

// GET/POST a JSON path on the bridge. Throws if the bridge is unreachable
// or the response is non-2xx. Returns the parsed JSON (or { raw: text } if
// the body isn't JSON).
async function bridgeFetch(path, options) {
  const base = await findBridge();
  if (!base) throw new Error("Bridge not reachable");
  const res = await fetch(`${base}${path}`, options);
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data;
}
