/**
 * signin-modal/init.js — Boot function and the DOMContentLoaded listener.
 *
 * init() does:
 *   - abort if not on "/" or "/dashboard"
 *   - probe the bridge in parallel with the server-side session check
 *   - merge sessions from both sources
 *   - auto-show the modal if sign-in isn't completed OR any required platform
 *     is missing in BOTH sources
 *   - expose window.gtss.openSigninModal + window.gtss.refreshSigninModal so
 *     other parts of the web app can pop the modal programmatically
 *
 * Original signin-modal.js was 656 lines; this is one of its thematic splits.
 */

"use strict";

// ─── Init ──────────────────────────────────────────────────────────────

async function init() {
  // Don't run on non-dashboard pages — the modal is only for "/".
  if (window.location.pathname !== "/" && window.location.pathname !== "/dashboard") {
    return;
  }

  // Probe the bridge in parallel with the server-side session check.
  // We don't return early if the bridge is unreachable — the modal
  // can still be useful in standalone mode by routing the user to
  // /settings#platform-sessions.
  const [base, serverState] = await Promise.all([
    findBridge(),
    loadServerSessions(),
  ]);

  if (serverState) {
    sessionState = mergeSessions(serverState, sessionState);
  }

  let state = null;
  if (base) {
    try {
      state = await bridgeFetch("/api/bridge/state");
    } catch (_) {
      state = null;
    }
  }

  if (state && state.ok) {
    signinCompleted = !!state.signinCompleted;
    if (state.sessions) {
      // Merge bridge sessions on top of server sessions.
      sessionState = mergeSessions(serverState, state.sessions);
    }
  }

  // Decide whether to auto-show. We use the merged sessionState so
  // the modal opens whenever a required platform isn't signed in
  // according to EITHER source — matching what the Settings page
  // would show.
  const requiredMissing = PLATFORMS.filter(
    (p) =>
      p.required &&
      !(sessionState[p.key] && sessionState[p.key].loggedIn),
  );
  const shouldShow = !signinCompleted || requiredMissing.length > 0;

  if (shouldShow && !modalDismissed) {
    showModal();
  }

  // Expose a manual re-open handle on window.gtss so other parts of the
  // web app (e.g., a "Sign in to accounts" link) can pop the modal.
  window.gtss = window.gtss || {};
  window.gtss.openSigninModal = showModal;
  // Expose a refresh handle so Settings → "Re-open sign-in modal"
  // can re-probe sessions after a successful authenticate().
  window.gtss.refreshSigninModal = pollOnce;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
