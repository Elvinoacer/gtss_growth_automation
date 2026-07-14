/* global gtss, io */
/**
 * discovery.js — Discovery page (module loader)
 *
 * Features (split across the discovery/ subdirectory):
 *   - Multi-platform lead discovery (LinkedIn / X / Facebook / Instagram)
 *     with per-run keyword + max-leads + platform-checkbox inputs
 *   - Instagram-specific strategy panel: hashtag chips (with debounced
 *     save-back to /api/discovery/keywords), geolocation dropdown,
 *     competitor scraper, suggested-competitors mode, auto-warmup toggle
 *   - Pipeline keyword-filter panel (load/save named keyword groups,
 *     trigger the outreach pipeline with a selection)
 *   - Live log via Socket.IO (discovery:event) + legacy SSE stream
 *     trigger; resume-on-page-load reattaches to an in-flight job
 *   - Result summary card on completion (new leads + duplicates skipped +
 *     platforms scanned + Proceed-to-Qualification CTA)
 *   - Paginated discovered-leads results table with platform / keyword /
 *     date-range filters, per-row checkbox, bulk "Qualify Selected" /
 *     "Dismiss Selected" actions, per-row "Add to Queue" / "Dismiss"
 *   - Discovery history table with one-click "Re-run"
 *   - Max-leads config persisted to /api/discovery/config
 *
 * This file is a thin loader. The actual UI code has been split into
 * thematic files in the discovery/ subdirectory for maintainability
 * (each <500 lines). Each split file is loaded synchronously via
 * document.write() during the initial page parse, preserving the original
 * single-<script> behavior — the HTML still references
 * `/js/discovery.js`, and every split file shares the same global scope
 * exactly as the original classic <script> did (the original was NOT an
 * IIFE — every `let`/`const`/`function` was a top-level global that
 * other scripts on the page could reference by bare name; the split
 * preserves that exact surface).
 *
 * File manifest (loaded in dependency order):
 *   discovery/state.js              — discoveryState object, platformLabels
 *                                     map, keywordGroups cache,
 *                                     DISCOVERY_PLATFORM_KEYS Set
 *   discovery/helpers.js            — platformBadge, escapeHtml,
 *                                     formatDate, selectedPlatforms
 *   discovery/keywordSelector.js    — loadKeywordSelector,
 *                                     selectedPipelineKeywords,
 *                                     saveKeywordGroup,
 *                                     runOutreachWithKeywords
 *   discovery/platformControls.js   — loadPlatformControls (renders the
 *                                     platform checkbox row + the
 *                                     platform-filter <select>)
 *   discovery/instagramHashtags.js  — selectedHashtags, defaultHashtags,
 *                                     igKeywordsLoaded, igHashtagsHydrating,
 *                                     saveHashtagsTimer,
 *                                     loadInstagramDiscoveryKeywords,
 *                                     scheduleHashtagSave,
 *                                     saveInstagramHashtags, addHashtagChip,
 *                                     removeHashtagChip, renderHashtagChips
 *   discovery/discoveryStream.js    — appendLog, formatEventMessage,
 *                                     enterRunningState,
 *                                     resumeActiveDiscovery, startDiscovery,
 *                                     openDiscoveryStream, stopDiscovery
 *   discovery/results.js            — buildResultQuery, loadResults,
 *                                     renderResults, renderPagination,
 *                                     updateBulkBar
 *   discovery/queueActions.js       — addToQueue, dismiss, removeRows
 *   discovery/history.js            — loadHistory, rerun
 *   discovery/discoveryConfig.js    — loadDiscoveryConfig,
 *                                     saveDiscoveryConfig
 *   discovery/events.js             — bindEvents() (single function that
 *                                     wires every DOM event listener; must
 *                                     run AFTER loadPlatformControls so
 *                                     the platform-row checkboxes exist)
 *   discovery/init.js               — DOMContentLoaded boot (loadPlatform
 *                                     Controls → loadDiscoveryConfig →
 *                                     loadKeywordSelector → bindEvents →
 *                                     loadResults → loadHistory →
 *                                     resumeActiveDiscovery)
 *
 * Original discovery.js was ~863 lines; this loader is the only file the
 * HTML references directly (see public/pages/discovery.html line 832).
 */

(function () {
  // The split files in dependency order. state.js must load first (it
  // declares every shared `let`/`const` binding in the global lexical
  // environment); init.js must load last (it registers the DOMContentLoaded
  // handler that boots the page, which references functions declared in
  // every other split file). helpers.js must precede keywordSelector.js /
  // platformControls.js / results.js / history.js because they call
  // escapeHtml / selectedPlatforms / platformBadge / formatDate by bare
  // name. instagramHashtags.js must precede platformControls.js because
  // loadPlatformControls references loadInstagramDiscoveryKeywords (called
  // inside the IG-checkbox change handler — but function declarations are
  // hoisted, so this is more for readability than a hard requirement).
  // discoveryStream.js loads before results.js / history.js because its
  // onDiscoveryEvent callback calls loadResults / loadHistory, but those
  // calls happen at event-fire time, not at parse time — function
  // declarations are looked up at call time, so the load order between
  // discoveryStream.js and results.js / history.js is not a hard
  // requirement either (kept in this order for readability: stream →
  // results → queueActions → history).
  var files = [
    'discovery/state.js',
    'discovery/helpers.js',
    'discovery/keywordSelector.js',
    'discovery/platformControls.js',
    'discovery/instagramHashtags.js',
    'discovery/discoveryStream.js',
    'discovery/results.js',
    'discovery/queueActions.js',
    'discovery/history.js',
    'discovery/discoveryConfig.js',
    'discovery/events.js',
    'discovery/init.js'
  ];

  // Resolve the base URL of THIS script (discovery.js) so the split files
  // load from the same directory regardless of how the app is mounted.
  // `document.currentScript.src` is e.g. "/js/discovery.js" (or an absolute
  // URL like "http://host/js/discovery.js"); stripping the trailing
  // "discovery.js" leaves the "/js/" base, so e.g. "discovery/state.js"
  // resolves to "/js/discovery/state.js".
  var base = (document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/discovery\.js$/, '')
    : 'js/';

  // document.write() of a <script> tag during parse is synchronous — the
  // browser blocks on fetching and executing each script before moving on.
  // This is exactly what we want: it preserves the original "everything
  // available by the time DOMContentLoaded fires" guarantee.
  files.forEach(function (f) {
    document.write('<script src="' + base + f + '"><\/script>');
  });
})();
