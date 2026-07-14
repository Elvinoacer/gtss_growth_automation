/**
 * signin-modal.js — Platform sign-in modal (module loader)
 *
 * The modal renders on the dashboard ("/") and lets the user sign in to
 * each platform. The modal uses the SAME central server-side authentication
 * flow that powers /settings#platform-sessions: clicking a platform's
 * "Login / Re-authenticate" button calls
 *
 *   POST /api/sessions/authenticate/:platform
 *
 * which (in src/automation/executor.js#authenticatePlatform) launches a
 * visible automation browser, navigates to the platform's login page, waits
 * for the user to sign in, and persists the session to the `platform_sessions`
 * SQLite table.
 *
 * Because the modal uses the same endpoint as Settings → Platform Sessions,
 * the two are perfectly interchangeable: a session started from the dashboard
 * shows up in Settings (and vice versa), and the sidebar status dots stay in
 * sync via window.gtss.updateSessionDots().
 *
 * ─── Session validation sources ─────────────────────────────────────────
 *
 * The modal merges TWO sources of session state so it always reflects what
 * the /settings#platform-sessions page shows (and what the automation engine
 * will actually use at runtime):
 *
 *   1. Server-side DB sessions — /api/sessions/details
 *      The SAME endpoint the Settings page uses. Reads the `platform_sessions`
 *      SQLite table (written by the server-side authenticate flow in
 *      /api/sessions/authenticate/:platform, and by markSessionActive() during
 *      automation runs).
 *
 *   2. Bridge CDP cookies — /api/bridge/cdp/sessions
 *      Live cookie detection inside the CDP Chrome (only available inside the
 *      Electron launcher). Used as a secondary source so the modal reflects
 *      logins performed in the open CDP Chrome tab too.
 *
 * If EITHER source says the platform is logged in, the card shows green.
 *
 * This file is a thin loader. The actual UI code has been split into thematic
 * files in the signin-modal/ subdirectory for maintainability (each <500
 * lines). Each split file is loaded synchronously via document.write() during
 * the initial page parse, preserving the original single-<script> behavior —
 * the HTML still references `/js/signin-modal.js`, and every split file
 * shares the same global scope exactly as the original monolith did.
 *
 * File manifest (loaded in dependency order):
 *   signin-modal/state.js          — BRIDGE_PORTS + bridgeBase + bridgeChecked
 *                                    + PLATFORMS array (google/linkedin/
 *                                    facebook/x/instagram) + sessionState +
 *                                    signinCompleted + modalDismissed +
 *                                    pollTimer + modalEl
 *   signin-modal/bridge.js         — findBridge (port scan 9224-9227) +
 *                                    bridgeFetch (GET/POST JSON helper)
 *   signin-modal/sessions.js       — loadServerSessions (calls
 *                                    /api/sessions/details) + mergeSessions
 *                                    (server OR bridge -> logged-in)
 *   signin-modal/modalMarkup.js    — buildModal (modal DOM tree) +
 *                                    ensureModal (lazy singleton, wires
 *                                    events on first creation)
 *   signin-modal/renderCards.js    — renderGrid (per-platform cards +
 *                                    Login/Re-authenticate button wiring) +
 *                                    updateDoneButton + updateCdpStateLabel +
 *                                    updateBridgeNote
 *   signin-modal/polling.js        — pollOnce (parallel server+bridge fetch
 *                                    + merge + re-render) + startPolling +
 *                                    stopPolling (4s interval)
 *   signin-modal/modalShowHide.js  — showModal (lazy create + render + poll)
 *                                    + hideModal (visible=false + delayed
 *                                    stop polling)
 *   signin-modal/modalEvents.js    — wireModalEvents (close/later/done/
 *                                    refresh/backdrop click handlers; "done"
 *                                    posts /api/bridge/signin/complete)
 *   signin-modal/helpers.js        — escapeHtml + showToast
 *   signin-modal/init.js           — init() boot (path check + parallel
 *                                    bridge+server probe + merge + auto-show
 *                                    decision + window.gtss.openSigninModal
 *                                    exposure) + DOMContentLoaded listener
 *
 * Original signin-modal.js was 656 lines; this loader is the only file the
 * HTML references directly (see public/pages/dashboard.html line 1029).
 */

/* global gtss, io */

(function () {
  // The split files in dependency order. state.js must load first (it
  // declares all shared `let`/`const` bindings in the global lexical
  // environment); init.js must load last (it registers the DOMContentLoaded
  // listener that calls init()). Everything in between can be re-ordered
  // without breaking behavior because function declarations are looked up at
  // call time, not at parse time.
  var files = [
    'signin-modal/state.js',
    'signin-modal/bridge.js',
    'signin-modal/sessions.js',
    'signin-modal/modalMarkup.js',
    'signin-modal/renderCards.js',
    'signin-modal/polling.js',
    'signin-modal/modalShowHide.js',
    'signin-modal/modalEvents.js',
    'signin-modal/helpers.js',
    'signin-modal/init.js'
  ];

  // Resolve the base URL of THIS script (signin-modal.js) so the split
  // files load from the same directory regardless of how the app is mounted.
  var base = (document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/signin-modal\.js$/, '')
    : 'js/';

  // document.write() of a <script> tag during parse is synchronous — the
  // browser blocks on fetching and executing each script before moving on.
  // This is exactly what we want: it preserves the original "everything
  // available by the time DOMContentLoaded fires" guarantee.
  files.forEach(function (f) {
    document.write('<script src="' + base + f + '"><\/script>');
  });
})();
