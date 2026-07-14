/* global gtss, io */
/**
 * messages.js — Message Generator page (module loader)
 *
 * Features (split across the messages/ subdirectory):
 *   - Paginated message table with per-status filter tabs (all / pending /
 *     approved / sent / followups) + platform filter + search
 *   - Stats cards: pending / approved / sent / skipped / followups +
 *     "unscored qualified" helper note
 *   - Bulk "Generate All" with live Socket.IO progress panel + legacy SSE
 *     trigger + resume-on-page-load (reattaches to an in-flight job)
 *   - Review-and-approve modal: lead context, both A/B variants in editable
 *     textareas with per-platform char counters, regenerate, skip
 *   - Per-row inline Approve / Review / Regenerate / Skip actions
 *   - Bulk Approve-all-A / Approve-all-B buttons
 *   - Settings sidebar: tone selector, AI-vs-Template message source
 *     toggle (persisted to /api/settings), product pitch selector with
 *     custom pitch input
 *   - Platform-aware modal hint card (X follow-first vs DM-only, LinkedIn
 *     connect-first vs DM-only) sourced from the pipeline config
 *
 * This file is a thin loader. The actual UI code has been split into
 * thematic files in the messages/ subdirectory for maintainability (each
 * <500 lines). Each split file is loaded synchronously via document.write()
 * during the initial page parse, preserving the original single-<script>
 * behavior — the HTML still references `/js/messages.js`, and every split
 * file shares the same global scope exactly as the original IIFE did (the
 * original was a single IIFE whose entire body has been hoisted into the
 * global lexical environment of classic <script> tags).
 *
 * File manifest (loaded in dependency order):
 *   messages/state.js        — gtss API destructure (fetchJSON, showToast,
 *                              getSocket), shared mutable state (currentFilter,
 *                              currentPlatform, currentSearch, currentPage,
 *                              pageLimit (const), totalMessages,
 *                              cachedMessages, activeSocketCleanup, charLimits,
 *                              platformCatalog, platformLabels, defaultPlatform,
 *                              pipelineConfig, selectedTone, selectedProduct,
 *                              modalLeadId, modalVariantA, modalVariantB),
 *                              cached DOM refs (stat/tab/progress/filter/table/
 *                              modal/settings refs)
 *   messages/helpers.js      — platformLabel, platformClass, scoreColorClass,
 *                              truncate, escapeHtml, relativeTime,
 *                              getCharLimitForPlatform, loadPlatformFilterOptions
 *   messages/stats.js        — loadStats (stat-card + tab counter refresh)
 *   messages/table.js        — loadMessages, renderTable, renderPagination
 *                              (paginated message-table rendering)
 *   messages/generateAll.js  — attachToMessageJob (Socket.IO + legacy SSE
 *                              listener for a bulk-generation job),
 *                              resumeActiveMessageGeneration (reattach to
 *                              in-flight job on page load), generateAll
 *                              (kick off a fresh bulk job)
 *   messages/modal.js        — openModal, closeModal, updateCharCounter
 *                              (review-and-approve modal with per-platform
 *                              outreach hints)
 *   messages/actions.js      — approveVariant, skipMessage, approveRowMessage,
 *                              bulkApprove, regenerateVariants
 *   messages/events.js       — all top-level event listeners (filter tabs,
 *                              platform filter, search, generate-all button,
 *                              approve-all-A/B buttons, pagination, row-action
 *                              delegation, modal events, char-counter updates,
 *                              settings sidebar, tone selector, AI/template
 *                              source toggle, product selector, keyboard
 *                              shortcuts)
 *   messages/init.js         — loadPipelineConfig + launch-time boot
 *                              (loadPlatformFilterOptions → loadPipelineConfig
 *                              → loadStats + loadMessages +
 *                              resumeActiveMessageGeneration)
 *
 * Original messages.js was ~886 lines; this loader is the only file the
 * HTML references directly (see public/pages/message-generator.html
 * line 1097).
 */

(function () {
  // The split files in dependency order. state.js must load first (it
  // declares every shared `let`/`const` binding in the global lexical
  // environment, plus the gtss API destructure); init.js must load last
  // (it runs the launch-time boot sequence, which references functions
  // declared in every other split file). Everything in between can be
  // re-ordered without breaking behavior because function declarations
  // are looked up at call time, not at parse time — the only constraint
  // is that state.js must come before any file that references a state
  // binding or DOM ref at parse time (none of them do; they only
  // reference them inside function bodies, which run later, EXCEPT
  // events.js which calls addEventListener at parse time — those calls
  // only reference the DOM-ref bindings by reading them, so state.js
  // must still precede events.js).
  var files = [
    'messages/state.js',
    'messages/helpers.js',
    'messages/stats.js',
    'messages/table.js',
    'messages/generateAll.js',
    'messages/modal.js',
    'messages/actions.js',
    'messages/events.js',
    'messages/init.js'
  ];

  // Resolve the base URL of THIS script (messages.js) so the split files
  // load from the same directory regardless of how the app is mounted.
  // `document.currentScript.src` is e.g. "/js/messages.js" (or an absolute
  // URL like "http://host/js/messages.js"); stripping the trailing
  // "messages.js" leaves the "/js/" base, so e.g. "messages/state.js"
  // resolves to "/js/messages/state.js".
  var base = (document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/messages\.js$/, '')
    : 'js/';

  // document.write() of a <script> tag during parse is synchronous — the
  // browser blocks on fetching and executing each script before moving on.
  // This is exactly what we want: it preserves the original "everything
  // available by the time DOMContentLoaded fires" guarantee.
  files.forEach(function (f) {
    document.write('<script src="' + base + f + '"><\/script>');
  });
})();
