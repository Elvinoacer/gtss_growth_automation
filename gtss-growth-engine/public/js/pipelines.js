/**
 * pipelines.js — Pipeline Operations Center UI (module loader)
 *
 * Features (split across the pipelines/ subdirectory):
 *   - Full lifecycle controls: Run Now / Pause / Resume / Stop / Restart / Retry-Stage / Resume-from-Checkpoint
 *   - Real-time progress bar + current stage indicator (Socket.IO)
 *   - Per-stage checkpoint visualization (done / active / failed / skipped)
 *   - Health metrics: last run, next run, uptime, success rate, failure rate, avg duration, retries, consecutive failures
 *   - Execution history with drill-down (state, error, stack trace, checkpoints, logs)
 *   - Searchable / filterable structured logs viewer
 *   - Live log tail (Socket.IO)
 *
 * This file is a thin loader. The actual UI code has been split into thematic
 * files in the pipelines/ subdirectory for maintainability (each <500 lines).
 * Each split file is loaded synchronously via document.write() during the
 * initial page parse, preserving the original single-<script> behavior — the
 * HTML still references `/js/pipelines.js`, and every split file shares the
 * same global scope exactly as the original monolith did.
 *
 * File manifest (loaded in dependency order):
 *   pipelines/state.js              — constants (CRON_PRESETS, PIPELINE_META,
 *                                     ALL_PLATFORMS, STATE_META, MASS_FOLLOW_PLATFORMS)
 *                                     and shared mutable state (pipelinesData,
 *                                     healthData, activeLogsSub, expandedPipelines,
 *                                     userInteracting, interactionGraceUntil,
 *                                     progressReloadTimer)
 *   pipelines/formatHelpers.js      — formatDate / formatRelative / formatDuration /
 *                                     formatUptime / statusBadge / liveDot /
 *                                     actionStyle / disabledAttr
 *   pipelines/interactionGuard.js   — anti-flicker focus tracking + form-value
 *                                     snapshot/restore (isUserInteracting,
 *                                     readCardFormValues, applyCardFormValues,
 *                                     focusin/focusout document listeners)
 *   pipelines/dirtyTracking.js      — Save-button dirty-state tracking
 *                                     (markCardDirty, snapshotCardCleanValues,
 *                                     recheckCardDirty, attachDirtyTracking)
 *   pipelines/renderCard.js         — renderPipelineCard + sub-piece renderers
 *                                     (cron picker, limit fields, platform
 *                                     checkboxes, stage progress, health section,
 *                                     progress section, dynamic banners, action
 *                                     buttons)
 *   pipelines/renderPipelines.js    — renderPipelines + patchPipelineCardInPlace +
 *                                     attachActionBtnListeners + refreshHealthSections
 *                                     + renderGlobalHealthStrip + attachCardListeners
 *   pipelines/feedback.js           — inline banners + button feedback helpers
 *                                     (showPipelineActionError, showPipelineActionInfo,
 *                                     withActionFeedback, optimisticStateForAction,
 *                                     showButtonSuccess, withButtonFeedback)
 *   pipelines/runConfirmationModal.js — openRunConfirmationModal +
 *                                     renderRunSettingsSummary
 *   pipelines/api.js                — backend API + action handlers
 *                                     (loadPipelines, loadHealth, savePipeline,
 *                                     togglePipeline, runNow, restartPipeline,
 *                                     pausePipeline, resumePipeline,
 *                                     pausePipelineLegacy, stopPipeline,
 *                                     retryStage, resumeFromCheckpoint,
 *                                     forceClearPipeline, loadExecutions,
 *                                     loadExecutionDetail, loadLogs, openLogsModal)
 *   pipelines/executionsModal.js    — renderExecutionsModal +
 *                                     renderExecutionDetailModal
 *   pipelines/logsModal.js          — renderLogsModalShell + renderLogRow +
 *                                     refreshLogsModal + attachLogsModalListeners
 *   pipelines/socket.js             — scheduleProgressReload +
 *                                     applyProgressEventInPlace + initPipelineSocket
 *   pipelines/massFollowModal.js    — Mass-Follow Target Manager modal
 *                                     (massFollowStatusBadge,
 *                                     renderMassFollowTargetsModal,
 *                                     loadMassFollowTargets, renderMassFollowTable,
 *                                     renderMassFollowSummary,
 *                                     refreshMassFollowTable,
 *                                     openMassFollowTargetsModal)
 *   pipelines/init.js               — DOMContentLoaded boot (initial load +
 *                                     socket + polling fallbacks)
 *
 * Original pipelines.js was ~2,955 lines; this loader is the only file the
 * HTML references directly (see public/pages/pipelines.html line 398).
 */

/* global gtss, io */

(function () {
  // The split files in dependency order. state.js must load first (it declares
  // all shared `let`/`const` bindings in the global lexical environment);
  // init.js must load last (it wires up DOMContentLoaded, which fires after
  // parse). Everything in between can be re-ordered without breaking
  // behavior because function declarations are looked up at call time, not
  // at parse time.
  var files = [
    'pipelines/state.js',
    'pipelines/formatHelpers.js',
    'pipelines/interactionGuard.js',
    'pipelines/dirtyTracking.js',
    'pipelines/renderCard.js',
    'pipelines/renderPipelines.js',
    'pipelines/feedback.js',
    'pipelines/runConfirmationModal.js',
    'pipelines/api.js',
    'pipelines/executionsModal.js',
    'pipelines/logsModal.js',
    'pipelines/socket.js',
    'pipelines/massFollowModal.js',
    'pipelines/init.js'
  ];

  // Resolve the base URL of THIS script (pipelines.js) so the split files
  // load from the same directory regardless of how the app is mounted.
  // `document.currentScript.src` is e.g. "/js/pipelines.js" (or an absolute
  // URL like "http://host/js/pipelines.js"); stripping the trailing
  // "pipelines.js" leaves the "/js/" base, so e.g. "pipelines/state.js"
  // resolves to "/js/pipelines/state.js".
  var base = (document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/pipelines\.js$/, '')
    : 'js/';

  // document.write() of a <script> tag during parse is synchronous — the
  // browser blocks on fetching and executing each script before moving on.
  // This is exactly what we want: it preserves the original "everything
  // available by the time DOMContentLoaded fires" guarantee.
  files.forEach(function (f) {
    document.write('<script src="' + base + f + '"><\/script>');
  });
})();
