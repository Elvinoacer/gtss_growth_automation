/**
 * campaign-detail.js — Campaign Detail & Telemetry page (module loader)
 *
 * This file is a thin loader. The actual UI code has been split into thematic
 * files in the campaign-detail/ subdirectory for maintainability (each <500
 * lines). Each split file is loaded synchronously via document.write() during
 * the initial page parse, preserving the original single-<script> behavior —
 * the HTML still references `/js/campaign-detail.js`, and every split file
 * shares the same global scope exactly as the original monolith did.
 *
 * File manifest (loaded in dependency order):
 *   campaign-detail/state.js        — gtss destructure + campaignId + all
 *                                     shared `let` state vars + all DOM refs
 *                                     (titleEl, platformBadge, statusBadge,
 *                                     lockDot/Text, pause/resume/run buttons,
 *                                     progress widgets, stat counters, tabs,
 *                                     tables, paging, telemetry log)
 *   campaign-detail/helpers.js      — escapeHtml + getPlatformBadgeClass +
 *                                     getStatusBadgeStyle +
 *                                     getJobStatusBadgeClass
 *   campaign-detail/api.js          — refreshCampaignDataSilently +
 *                                     loadCampaignDetail + loadConnectionJobs
 *                                     + loadDmJobs + loadAdvisoryLock +
 *                                     updateQueueControlButtons +
 *                                     handleTogglePause + handleStopQueue +
 *                                     handleTriggerQueue
 *   campaign-detail/renderHeader.js — renderHeaderInfo (title + platform
 *                                     badge + status badge + pause/resume
 *                                     button config)
 *   campaign-detail/renderStats.js  — renderStatsDashboard +
 *                                     renderProgressWidgets (circular SVG
 *                                     progress + stat counters)
 *   campaign-detail/renderTables.js — renderConnectionJobs + renderDmJobs +
 *                                     renderTablePagination
 *   campaign-detail/telemetryLog.js — appendTelemetryLog (live terminal-log
 *                                     stream appender for campaign events and
 *                                     queue logs)
 *   campaign-detail/events.js       — setupEventListeners (tab/pagination/
 *                                     pause-resume/stop-queue/run-queue/
 *                                     clear-log clicks)
 *                                     + setupSocketSubscriptions (joins
 *                                     `campaigns:<id>` + `campaigns` rooms,
 *                                     handles `event` + `queue:log` events)
 *   campaign-detail/init.js         — init() async boot (loads details +
 *                                     connections + dms + advisory lock, starts
 *                                     5s lock poller, wires events + socket)
 *                                     + the init() invocation. Preserves the
 *                                     original IIFE-level early-return when
 *                                     campaignId is invalid (now an early
 *                                     return inside init()).
 *
 * Original campaign-detail.js was 684 lines; this loader is the only file
 * the HTML references directly (see public/pages/campaign-detail.html
 * line 364).
 */

/* global gtss, io */

(function () {
  // The split files in dependency order. state.js must load first (it
  // destructures `window.gtss` and declares all shared `let`/`const` bindings
  // in the global lexical environment); init.js must load last (it calls
  // init() which is the entry point). Everything in between can be re-ordered
  // without breaking behavior because function declarations are looked up at
  // call time, not at parse time.
  var files = [
    'campaign-detail/state.js',
    'campaign-detail/helpers.js',
    'campaign-detail/api.js',
    'campaign-detail/renderHeader.js',
    'campaign-detail/renderStats.js',
    'campaign-detail/renderTables.js',
    'campaign-detail/telemetryLog.js',
    'campaign-detail/events.js',
    'campaign-detail/init.js'
  ];

  // Resolve the base URL of THIS script (campaign-detail.js) so the split
  // files load from the same directory regardless of how the app is mounted.
  // `document.currentScript.src` is e.g. "/js/campaign-detail.js" (or an
  // absolute URL like "http://host/js/campaign-detail.js"); stripping the
  // trailing "campaign-detail.js" leaves the "/js/" base, so e.g.
  // "campaign-detail/state.js" resolves to "/js/campaign-detail/state.js".
  var base = (document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/campaign-detail\.js$/, '')
    : 'js/';

  // document.write() of a <script> tag during parse is synchronous — the
  // browser blocks on fetching and executing each script before moving on.
  // This is exactly what we want: it preserves the original "everything
  // available by the time DOMContentLoaded fires" guarantee.
  files.forEach(function (f) {
    document.write('<script src="' + base + f + '"><\/script>');
  });
})();
