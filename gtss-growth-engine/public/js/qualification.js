/* global gtss, io */
/**
 * qualification.js — Lead Qualification page (module loader)
 *
 * Features (split across the qualification/ subdirectory):
 *   - Paginated lead table with per-status filter tabs (all / pending /
 *     approved / rejected / scoring_failed / overridden), sort dropdown
 *     (score / name / platform / date), and per-row checkboxes for bulk
 *     actions
 *   - Stats cards: pending / qualified / deprioritized / overridden /
 *     scoring-failed; pulses the "Proceed to Messages" CTA when qualified
 *     leads exist
 *   - Bulk "Run All" with live Socket.IO progress panel + legacy SSE
 *     trigger + resume-on-page-load (reattaches to an in-flight job) +
 *     Stop button
 *   - Manual-actions dropdown: Qualify All Manually (no AI), Qualify
 *     Selected Manually, Retry Failed (re-runs AI on scoring-failed leads)
 *   - Lead detail drawer: name / platform / score / role / company /
 *     location / website + profile URL / AI reasoning / inline score
 *     override / notes auto-save / Approve / Reject / Skip
 *   - Inline score-override input on the score cell (Enter to commit,
 *     Escape to cancel)
 *   - URL-hash filter restore on page load
 *
 * This file is a thin loader. The actual UI code has been split into
 * thematic files in the qualification/ subdirectory for maintainability
 * (each <500 lines). Each split file is loaded synchronously via
 * document.write() during the initial page parse, preserving the original
 * single-<script> behavior — the HTML still references
 * `/js/qualification.js`, and every split file shares the same global
 * scope exactly as the original IIFE did (the original was a single IIFE
 * whose entire body has been hoisted into the global lexical environment
 * of classic <script> tags).
 *
 * File manifest (loaded in dependency order):
 *   qualification/state.js              — gtss API destructure (fetchJSON,
 *                                         showToast, getSocket), shared
 *                                         mutable state (currentFilter,
 *                                         currentSort, currentPage,
 *                                         pageLimit (const), totalLeads,
 *                                         selectedIds, openDrawerLead,
 *                                         activeSocketHandler, activeJobId,
 *                                         cachedLeads), cached DOM refs
 *                                         (stat/tab/progress/filter/table/
 *                                         bulk/drawer refs)
 *   qualification/helpers.js            — platformLabel, platformClass,
 *                                         scoreColorClass, statusClass,
 *                                         truncate, escapeHtml
 *   qualification/stats.js              — loadStats (stat-card + tab
 *                                         counter refresh + Proceed CTA
 *                                         pulse toggle)
 *   qualification/table.js              — sortQueryParam, loadLeads,
 *                                         renderTable, renderPagination,
 *                                         updateBulkBar
 *   qualification/manualActions.js      — closeManualActionsMenu,
 *                                         toggleManualActionsMenu
 *   qualification/qualificationStream.js
 *                                       — attachQualificationStream
 *                                         (Socket.IO + legacy SSE listener
 *                                         for a qualification batch job)
 *   qualification/runQualification.js   — runQualification,
 *                                         stopQualification,
 *                                         resumeActiveQualification +
 *                                         the stop-qualification-btn
 *                                         listener (immediate)
 *   qualification/actions.js            — updateLeadStatus, overrideScore,
 *                                         bulkStatusUpdate,
 *                                         manualQualifyLeads,
 *                                         retryFailedLeads
 *   qualification/drawer.js             — openDrawer, closeDrawer,
 *                                         startInlineOverride
 *   qualification/events.js             — all top-level event listeners
 *                                         (filter tabs, sort, Run All,
 *                                         manual-actions dropdown +
 *                                         click-outside, manual-qualify /
 *                                         retry buttons, select-all, row
 *                                         delegation, bulk approve/reject,
 *                                         pagination, drawer events,
 *                                         notes auto-save)
 *   qualification/init.js               — restoreFilterFromHash +
 *                                         launch-time boot (loadStats →
 *                                         loadLeads →
 *                                         resumeActiveQualification)
 *
 * Original qualification.js was ~864 lines; this loader is the only file
 * the HTML references directly (see public/pages/lead-qualification.html
 * line 1020).
 */

(function () {
  // The split files in dependency order. state.js must load first (it
  // declares every shared `let`/`const` binding in the global lexical
  // environment, plus the gtss API destructure); init.js must load last
  // (it runs the launch-time boot sequence, which references functions
  // declared in every other split file). runQualification.js must come
  // before events.js because runQualification.js wires up the
  // stop-qualification-btn listener at parse time and events.js expects
  // `runQualification` to exist when its own listeners fire (function
  // declarations are hoisted anyway, but explicit ordering keeps the
  // dependency graph readable). manualActions.js must come before
  // events.js because events.js calls closeManualActionsMenu /
  // toggleManualActionsMenu from its handlers (same hoisting rationale).
  var files = [
    'qualification/state.js',
    'qualification/helpers.js',
    'qualification/stats.js',
    'qualification/table.js',
    'qualification/manualActions.js',
    'qualification/qualificationStream.js',
    'qualification/runQualification.js',
    'qualification/actions.js',
    'qualification/drawer.js',
    'qualification/events.js',
    'qualification/init.js'
  ];

  // Resolve the base URL of THIS script (qualification.js) so the split
  // files load from the same directory regardless of how the app is
  // mounted. `document.currentScript.src` is e.g. "/js/qualification.js"
  // (or an absolute URL like "http://host/js/qualification.js"); stripping
  // the trailing "qualification.js" leaves the "/js/" base, so e.g.
  // "qualification/state.js" resolves to "/js/qualification/state.js".
  var base = (document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/qualification\.js$/, '')
    : 'js/';

  // document.write() of a <script> tag during parse is synchronous — the
  // browser blocks on fetching and executing each script before moving on.
  // This is exactly what we want: it preserves the original "everything
  // available by the time DOMContentLoaded fires" guarantee.
  files.forEach(function (f) {
    document.write('<script src="' + base + f + '"><\/script>');
  });
})();
