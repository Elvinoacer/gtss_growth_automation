/**
 * renderer.js — control-center UI logic (module loader).
 *
 * The launcher is intentionally minimal. The web app at localhost:3000 is
 * the real application — this window just starts/stops it, shows status,
 * shows logs, and surfaces friendly error cards when something goes wrong.
 *
 * Talks to the main process entirely through window.gtss.* (the preload
 * bridge). No Node access, no filesystem access, no direct IPC.
 *
 * Original renderer.js (~819 lines) was split into thematic files inside
 * the renderer/ subdirectory for maintainability. This loader synchronously
 * document.writes each split file in dependency order — exactly preserving
 * the original "everything available by the time DOMContentLoaded fires"
 * semantics (same approach used by Task 5 pipelines.js, Task 10 settings.js,
 * and Task 11 scheduler.js / automation.js). Plain classic scripts (no
 * IIFE) share the global lexical environment across files, exactly as the
 * original monolith's closure scope did.
 *
 * Manifest (loaded in this order):
 *   1. helpers.js     — $, $$, escapeHtml, toast (used by every split)
 *   2. sessions.js    — CDP Chrome session-health badge + hint card + poll loop
 *   3. tabs.js        — top-tab switcher
 *   4. status.js      — server/CDP status hero + 1.5s poll loop (defines refreshStatus)
 *   5. lifecycle.js   — Start / Stop / Restart / Open / CDP / DevTools buttons
 *   6. errorCard.js   — crashed-state error card retry + copy-logs
 *   7. logs.js        — Logs pane live tail + filter checkboxes + clear (defines loadInitialLogs)
 *   8. updater.js     — auto-updater indicator + modal state machine (defines openUpdateModal)
 *   9. about.js       — About tab version info + check-updates (uses openUpdateModal)
 *  10. init.js        — launch-time boot calls (must be last; uses loaders defined above)
 *
 * HTML reference (desktop/renderer/index.html line 329:
 *   <script src="renderer.js"></script>) is unchanged — the loader takes
 * the place of the original monolith at the same path.
 */

(function () {
  var files = [
    "renderer/helpers.js",
    "renderer/sessions.js",
    "renderer/tabs.js",
    "renderer/status.js",
    "renderer/lifecycle.js",
    "renderer/errorCard.js",
    "renderer/logs.js",
    "renderer/updater.js",
    "renderer/about.js",
    "renderer/init.js",
  ];
  var base = (document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/renderer\.js$/, "")
    : "";
  files.forEach(function (f) {
    document.write('<script src="' + base + f + '"><\/script>');
  });
})();
