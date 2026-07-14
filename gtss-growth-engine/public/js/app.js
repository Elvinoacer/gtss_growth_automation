/* global io */
/**
 * app.js — Shared GTSS front-end API + shell (module loader)
 *
 * This is the global helper bundle loaded on EVERY page (after socket.io,
 * before any page-specific script). It exposes `window.gtss` (and the
 * legacy alias `window.GTSS`) — a single object bundling every shared
 * utility the page scripts need:
 *
 *   - HTTP:     fetchJSON (Promise + JSON-parse + .status/.body/.hint err)
 *   - UI:       showToast, relayoutToasts, showConfirmDialog, escapeHtml,
 *               renderPlatformBadge, renderStatusBadge, renderScoreBadge,
 *               renderStatCard, renderConfirmModal, renderEmptyState,
 *               renderDataTable
 *   - Realtime: getSocket, initSocket, joinRoom, leaveRoom, initSSE
 *   - Sessions: updateSessionDots, updateActionBadge (sidebar dots + the
 *               "Actions today: X / Y limit" badge in the topbar)
 *   - Platforms: formatPlatformLabel, loadPlatformCatalog
 *   - Shell:    initShell (sidebar collapse, page title/subtitle, nav-link
 *               active state, Ctrl+B shortcut, notification dropdown,
 *               version stamp, fallback polling) — runs on DOMContentLoaded.
 *
 * This file is a thin loader. The actual implementation has been split
 * into thematic files in the app/ subdirectory for maintainability (each
 * <500 lines). Each split file is loaded synchronously via document.write()
 * during the initial page parse, preserving the original single-<script>
 * behavior — the HTML still references `/js/app.js`, and every split file
 * shares the same global scope exactly as the original classic <script>
 * did (the original was NOT an IIFE — every `function` declaration was a
 * top-level global that other scripts on the page could reference by bare
 * name; the split preserves that exact surface via the global lexical
 * environment shared across classic scripts).
 *
 * File manifest (loaded in dependency order):
 *   app/fetchJson.js      — fetchJSON (no deps; pure Promise+JSON wrapper)
 *   app/toasts.js         — showToast, relayoutToasts (deps: escapeHtml at
 *                           call time only — renderHelpers.js)
 *   app/confirmDialog.js  — showConfirmDialog (deps: escapeHtml at call
 *                           time only — renderHelpers.js)
 *   app/sse.js            — initSSE (deps: showToast at call time only —
 *                           toasts.js)
 *   app/socket.js         — _socket let, getSocket, initSocket, joinRoom,
 *                           leaveRoom (deps: updateActionBadge +
 *                           updateSessionDots at call time only —
 *                           shellState.js)
 *   app/shellState.js     — updateSessionDots, updateActionBadge (deps:
 *                           fetchJSON + showToast at call time only)
 *   app/platforms.js      — formatPlatformLabel, loadPlatformCatalog
 *                          (deps: fetchJSON at call time only)
 *   app/renderHelpers.js  — renderPlatformBadge, renderStatusBadge,
 *                           renderScoreBadge, renderStatCard,
 *                           renderConfirmModal, renderEmptyState,
 *                           renderDataTable, escapeHtml (deps:
 *                           formatPlatformLabel at call time only —
 *                           platforms.js)
 *   app/initShell.js      — initShell (deps: updateSessionDots +
 *                           updateActionBadge + getSocket at call time
 *                           only — shellState.js + socket.js)
 *   app/init.js           — DOMContentLoaded listener (→ initShell) +
 *                           sharedApi const + window.gtss / window.GTSS
 *                           assignment. MUST load LAST — the sharedApi
 *                           object literal references every function by
 *                           bare name, which only works once every
 *                           function declaration has been hoisted to the
 *                           global object by its owning split file's
 *                           evaluation.
 *
 * Original app.js was ~702 lines; this loader is the only file the HTML
 * references directly (see public/pages/dashboard.html line 74 and every
 * other page that does `<script src="/js/app.js"></script>`).
 */

(function () {
  // The split files in dependency order. fetchJson.js loads first (it
  // declares fetchJSON, the most-fundamental helper, which several other
  // split files call at parse-or-call time). init.js loads last because
  // its `const sharedApi = { fetchJSON, showToast, ... }` literal
  // references every function by bare name — those references only
  // resolve once every owning split file has been evaluated and its
  // function declarations have created the corresponding properties on
  // the global object. The mid-list ordering among toasts / confirm /
  // sse / socket / shellState / platforms / renderHelpers / initShell is
  // not strictly load-sensitive (all their cross-file references happen
  // at function-call time, by which point every script has loaded), but
  // the chosen order roughly follows the dependency DAG for readability:
  // primitives (fetchJSON) → UI primitives (toasts / confirm / sse) →
  // realtime (socket) → state derivations (shellState) → platform
  // catalog (platforms) → UI renderers (renderHelpers) → shell
  // bootstrap (initShell) → API export (init).
  var files = [
    'app/fetchJson.js',
    'app/toasts.js',
    'app/confirmDialog.js',
    'app/sse.js',
    'app/socket.js',
    'app/shellState.js',
    'app/platforms.js',
    'app/renderHelpers.js',
    'app/initShell.js',
    'app/init.js'
  ];

  // Resolve the base URL of THIS script (app.js) so the split files
  // load from the same directory regardless of how the app is mounted.
  // `document.currentScript.src` is e.g. "/js/app.js" (or an absolute
  // URL like "http://host/js/app.js"); stripping the trailing "app.js"
  // leaves the "/js/" base, so e.g. "app/fetchJson.js" resolves to
  // "/js/app/fetchJson.js".
  var base = (document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/app\.js$/, '')
    : 'js/';

  // document.write() of a <script> tag during parse is synchronous — the
  // browser blocks on fetching and executing each script before moving on.
  // This is exactly what we want: it preserves the original "everything
  // available by the time DOMContentLoaded fires" guarantee.
  files.forEach(function (f) {
    document.write('<script src="' + base + f + '"><\/script>');
  });
})();
