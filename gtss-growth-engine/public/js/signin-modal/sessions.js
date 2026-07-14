/**
 * signin-modal/sessions.js — Server-side session detection and merge logic.
 *
 * loadServerSessions calls /api/sessions/details (the SAME endpoint the
 * /settings#platform-sessions page uses) and translates the response into
 * the { loggedIn } shape the modal expects. mergeSessions merges two
 * session-state maps — if either source says logged-in, the platform is
 * considered logged-in.
 *
 * Original signin-modal.js was 656 lines; this is one of its thematic splits.
 */

"use strict";

// ─── Server-side session detection ─────────────────────────────────────
//
// Same endpoint the /settings#platform-sessions page uses. Returns a
// map of platformKey -> { status, last_active, is_valid }. We translate
// that into the { loggedIn } shape the modal expects, and merge it
// with the bridge's live cookie state.
async function loadServerSessions() {
  try {
    const res = await fetch("/api/sessions/details", {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return {};
    const data = await res.json();
    if (!data || typeof data !== "object") return {};
    const out = {};
    for (const p of PLATFORMS) {
      let found = null;
      for (const sk of p.serverKeys) {
        const row = data[sk];
        if (row && row.is_valid && row.status === "active") {
          found = row;
          break;
        }
      }
      if (found) {
        out[p.key] = {
          loggedIn: true,
          source: "server",
          lastActive: found.last_active || null,
        };
      }
    }
    return out;
  } catch (_) {
    return {};
  }
}

// Merge two session-state maps. If either source says logged-in, the
// platform is considered logged-in. We preserve the freshest
// metadata.
function mergeSessions(serverState, bridgeState) {
  const next = {};
  for (const p of PLATFORMS) {
    const s = serverState[p.key];
    const b = bridgeState[p.key];
    if (s && s.loggedIn) {
      next[p.key] = s;
    } else if (b && b.loggedIn) {
      next[p.key] = b;
    } else if (b) {
      next[p.key] = b;
    } else if (s) {
      next[p.key] = s;
    } else {
      next[p.key] = { loggedIn: false };
    }
  }
  return next;
}
