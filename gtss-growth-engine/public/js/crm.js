/**
 * crm.js — CRM Kanban & List page (module loader)
 *
 * This file is a thin loader. The actual UI code has been split into thematic
 * files in the crm/ subdirectory for maintainability (each <500 lines). Each
 * split file is loaded synchronously via document.write() during the initial
 * page parse, preserving the original single-<script> behavior — the HTML
 * still references `/js/crm.js`, and every split file shares the same global
 * scope exactly as the original monolith did.
 *
 * File manifest (loaded in dependency order):
 *   crm/state.js                    — gtss destructure + leads/currentView/
 *                                     currentDrawerLeadId/platformLabels
 *                                     state vars + els (DOM-refs object) +
 *                                     STATUSES (kanban column order)
 *   crm/loadPlatformFilterOptions.js — populate platform-filter dropdown
 *                                     from the shared platform catalog
 *   crm/loadStats.js                 — fetch /api/crm/stats + render header
 *                                     counters (total / avg days to reply /
 *                                     avg days to convert / conversion rate)
 *   crm/loadLeads.js                 — fetch /api/crm/leads + trigger render
 *   crm/render.js                    — render() top-level dispatcher (kanban
 *                                     vs. list) with search + platform filter
 *   crm/renderKanban.js              — renderKanban (5-column distribution +
 *                                     per-column counts) + createKanbanCard
 *                                     (draggable card with day-since-contact
 *                                     color coding; click opens drawer)
 *   crm/renderList.js                — renderList (table rows of filtered
 *                                     leads; click opens drawer)
 *   crm/dragDrop.js                  — setupDragAndDrop (native HTML5 D&D:
 *                                     document dragstart/dragend + per-column
 *                                     dragover/dragleave/drop; optimistic
 *                                     PATCH /api/crm/leads/:id/status with
 *                                     revert on failure)
 *   crm/drawer.js                    — openDrawer (populate fields + fetch
 *                                     touchpoints) + closeDrawer +
 *                                     renderTimeline (colored touchpoint items)
 *   crm/bindEvents.js                — bindEvents (view toggle, search, filter,
 *                                     drawer close, notes auto-save w/ 1s
 *                                     debounce, action dropdown, save-action
 *                                     button, Detect Replies SSE+Socket.IO)
 *   crm/init.js                      — init() async boot + DOMContentLoaded-
 *                                     aware init() invocation
 *
 * Original crm.js was 578 lines; this loader is the only file the HTML
 * references directly (see public/pages/crm.html line 555).
 */

/* global gtss, io */

(function () {
  // The split files in dependency order. state.js must load first (it
  // destructures `window.gtss` and declares all shared `let`/`const` bindings
  // in the global lexical environment); init.js must load last (it registers
  // the DOMContentLoaded listener that calls init()). Everything in between
  // can be re-ordered without breaking behavior because function declarations
  // are looked up at call time, not at parse time.
  var files = [
    'crm/state.js',
    'crm/loadPlatformFilterOptions.js',
    'crm/loadStats.js',
    'crm/loadLeads.js',
    'crm/render.js',
    'crm/renderKanban.js',
    'crm/renderList.js',
    'crm/dragDrop.js',
    'crm/drawer.js',
    'crm/bindEvents.js',
    'crm/init.js'
  ];

  // Resolve the base URL of THIS script (crm.js) so the split files load
  // from the same directory regardless of how the app is mounted.
  var base = (document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/crm\.js$/, '')
    : 'js/';

  // document.write() of a <script> tag during parse is synchronous — the
  // browser blocks on fetching and executing each script before moving on.
  // This is exactly what we want: it preserves the original "everything
  // available by the time DOMContentLoaded fires" guarantee.
  files.forEach(function (f) {
    document.write('<script src="' + base + f + '"><\/script>');
  });
})();
