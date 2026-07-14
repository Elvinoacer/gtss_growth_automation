/* global gtss, io */
/**
 * settings.js — Settings Page (module loader)
 *
 * Features (split across the settings/ subdirectory):
 *   - Account credentials: Gemini API key (save / test), Gmail (save /
 *     test email), pipeline reliability presets
 *   - Automation Browser visibility (CDP_VISIBLE_DEFAULT) via the desktop
 *     launcher's bridge HTTP server (ports 9224–9227)
 *   - Per-platform rate-limit table (with reset to last-loaded values)
 *   - Session grid: per-platform login / re-authenticate / clear-session
 *     buttons (delegates to /api/sessions/authenticate + /api/sessions/clear)
 *   - Notification checkboxes (auto-saved on change)
 *   - Instagram warmup / discovery / selector settings (16 knobs)
 *   - Message template editor: per-platform tabs, variable badges, char
 *     count (1000-char cap for instagram_dm), save / reset / apply-to-all
 *   - Passphrase change + danger-zone "Delete all data" (typed "DELETE")
 *   - Pipeline settings: mode / cron / stage modes / qualification knobs /
 *     max-DMs / max-connections / outreach-platforms / outreach modes +
 *     Run / Abort / Pause / Resume buttons with live Socket.IO updates +
 *     keyword add/remove + last-5-runs table
 *   - Brand Context (Phase 1): 19 plain-text fields + 6 multiline array
 *     fields + 5 scoring-weight inputs (must sum to 100) + reset-to-defaults
 *     + 4-tab preview modal (qualification / messages / caption / image)
 *   - Centralized extensions: Message Generation Source (AI / template
 *     segmented control) + Scheduler pause toggle (with status pill)
 *   - Settings nav scrollspy (IntersectionObserver) + smooth-scroll on
 *     nav-link click (avoids sticky-topbar occlusion) + URL-hash update
 *
 * This file is a thin loader. The actual UI code has been split into
 * thematic files in the settings/ subdirectory for maintainability (each
 * <500 lines). Each split file is loaded synchronously via document.write()
 * during the initial page parse, preserving the original single-<script>
 * behavior — the HTML still references `/js/settings.js`, and every split
 * file shares the same global scope exactly as the original monolith did.
 *
 * File manifest (loaded in dependency order):
 *   settings/state.js                     — constants (variables,
 *                                           settingsState, pipelineState,
 *                                           activePipelineRunId,
 *                                           pipelineSocketSubscribed,
 *                                           previewData) declared first so
 *                                           every other split file can
 *                                           reference them at parse time.
 *   settings/helpers.js                   — platformLabel,
 *                                           formatTemplateLabel,
 *                                           getLimitFieldOrder, getLimitValue,
 *                                           setLimitValue, formatLimitField,
 *                                           confirmModal, setInline
 *   settings/settingsLoad.js              — loadSettings, loadSessions,
 *                                           renderLimits, collectLimits,
 *                                           applyNotifications,
 *                                           collectNotifications,
 *                                           renderTemplateTabs,
 *                                           renderTemplateEditor,
 *                                           updateCharCount, insertAtCursor
 *   settings/accountHandlers.js           — bindEvents,
 *                                           savePipelineReliability,
 *                                           togglePassword, saveGemini,
 *                                           testGemini, BRIDGE_PORTS,
 *                                           findBridgeBase, loadBrowserMode,
 *                                           saveBrowserMode, saveGmail,
 *                                           testEmail, saveLimits,
 *                                           saveNotifications
 *   settings/templateSessionHandlers.js   — saveInstagramSettings,
 *                                           saveTemplate, resetTemplate,
 *                                           applyTemplateToAll,
 *                                           changePassphrase, clearData,
 *                                           authenticatePlatform,
 *                                           clearPlatform
 *   settings/pipelineSettings.js          — loadPipelineSettings,
 *                                           applyPipelineConfig,
 *                                           renderOutreachPlatforms,
 *                                           collectOutreachPlatforms,
 *                                           renderKeywords,
 *                                           renderPipelineRuns,
 *                                           savePipelineSettings, runPipeline,
 *                                           abortPipeline, pausePipeline,
 *                                           resumePipeline,
 *                                           finishPipelineControls,
 *                                           subscribeToPipelineStream,
 *                                           addKeyword, removeKeyword,
 *                                           bindPipelineEvents
 *   settings/context.js                   — CTX_ARRAY_FIELDS, CTX_TEXT_FIELDS,
 *                                           loadContext, populateContextForm,
 *                                           renderScoringWeights,
 *                                           collectContextPayload, saveContext,
 *                                           resetContextToDefaults,
 *                                           openContextPreview,
 *                                           buildQualificationPreview,
 *                                           buildMessagePreview,
 *                                           buildCaptionPreview,
 *                                           buildImagePreview
 *   settings/centralExtensions.js         — bindCentralizedExtensions,
 *                                           loadMessageSource,
 *                                           updateMsgSourceSegmentedVisual,
 *                                           saveMessageSource,
 *                                           loadSchedulerPaused,
 *                                           applySchedulerState,
 *                                           saveSchedulerPaused
 *   settings/scrollspy.js                 — initSettingsNavScrollspy
 *   settings/init.js                      — top-level event wiring
 *                                           (context preview modal) +
 *                                           DOMContentLoaded boot
 *
 * Original settings.js was ~1,679 lines; this loader is the only file the
 * HTML references directly (see public/pages/settings.html line 1854).
 */

(function () {
  // The split files in dependency order. state.js must load first (it
  // declares all shared `let`/`const` bindings in the global lexical
  // environment); init.js must load last (it wires up DOMContentLoaded,
  // which fires after parse, and references every other split file's
  // functions by bare name). Everything in between can be re-ordered
  // without breaking behavior because function declarations are looked
  // up at call time, not at parse time.
  var files = [
    'settings/state.js',
    'settings/helpers.js',
    'settings/settingsLoad.js',
    'settings/accountHandlers.js',
    'settings/templateSessionHandlers.js',
    'settings/pipelineSettings.js',
    'settings/context.js',
    'settings/centralExtensions.js',
    'settings/scrollspy.js',
    'settings/init.js'
  ];

  // Resolve the base URL of THIS script (settings.js) so the split files
  // load from the same directory regardless of how the app is mounted.
  // `document.currentScript.src` is e.g. "/js/settings.js" (or an absolute
  // URL like "http://host/js/settings.js"); stripping the trailing
  // "settings.js" leaves the "/js/" base, so e.g. "settings/state.js"
  // resolves to "/js/settings/state.js".
  var base = (document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/settings\.js$/, '')
    : 'js/';

  // document.write() of a <script> tag during parse is synchronous — the
  // browser blocks on fetching and executing each script before moving on.
  // This is exactly what we want: it preserves the original "everything
  // available by the time DOMContentLoaded fires" guarantee.
  files.forEach(function (f) {
    document.write('<script src="' + base + f + '"><\/script>');
  });
})();
