/**
 * signin-modal/polling.js — Polling loop that merges server-side session
 * state with the live bridge CDP cookies every 4 seconds.
 *
 * Includes: pollOnce, startPolling, stopPolling.
 *
 * Original signin-modal.js was 656 lines; this is one of its thematic splits.
 */

"use strict";

// ─── Polling ───────────────────────────────────────────────────────────
//
// Every poll we fetch BOTH:
//   - /api/sessions/details (server-side DB state — always available
//     as long as the web app server is up), and
//   - /api/bridge/cdp/sessions (live CDP cookies — only if bridge is
//     reachable AND Chrome is running).
// We merge the two so a session saved by either flow shows up green.

async function pollOnce() {
  // Always fetch the server-side state in parallel with the bridge.
  const serverPromise = loadServerSessions();
  const bridgePromise = (async () => {
    if (!bridgeBase) return null;
    try {
      return await bridgeFetch("/api/bridge/cdp/sessions");
    } catch (_) {
      return null;
    }
  })();

  const [serverState, bridgeRes] = await Promise.all([serverPromise, bridgePromise]);

  let bridgeState = {};
  if (bridgeRes && bridgeRes.sessions) {
    updateCdpStateLabel(true);
    bridgeState = bridgeRes.sessions;
  } else {
    updateCdpStateLabel(false);
  }

  // Merge: preserve previously-detected logins (avoid flicker if one
  // source temporarily drops), but let a fresh positive from either
  // source flip the card green immediately.
  const next = mergeSessions(serverState, bridgeState);
  for (const p of PLATFORMS) {
    const prev = sessionState[p.key];
    const fresh = next[p.key];
    if (prev && prev.loggedIn && fresh && !fresh.loggedIn) {
      // Keep the previous "logged in" verdict — don't flicker off
      // just because the bridge momentarily returned no cookies.
      next[p.key] = prev;
    }
  }
  sessionState = next;
  renderGrid();
  updateDoneButton();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollOnce();
  pollTimer = setInterval(pollOnce, 4000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
