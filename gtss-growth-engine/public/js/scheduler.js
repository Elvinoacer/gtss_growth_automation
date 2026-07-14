/* global gtss, io */
/**
 * scheduler.js — Content Scheduler Page (module loader)
 *
 * Features (split across the scheduler/ subdirectory):
 *   - Weekly calendar grid with click-to-edit post cards
 *   - Up-next queue list (top 5 soonest scheduled posts)
 *   - Published-post log with inline stats editing (likes / comments / reach)
 *   - Composer with per-platform character counters
 *   - Instagram-specific options: feed / story / carousel post types,
 *     9:16 story aspect-ratio check, 5-8 hashtag recommendation,
 *     drag-and-drop carousel thumbnail reorder (max 10 images)
 *   - AI caption generation (Gemini) with web fallback
 *   - AI image generation with live SSE job-stream log
 *   - Pause / resume scheduler toggle (PATCH /api/scheduler/pause)
 *   - Edit-post modal (update schedule, delete, publish-now)
 *   - Live publish log via Socket.IO (scheduler:event) + legacy SSE trigger
 *
 * This file is a thin loader. The actual UI code has been split into
 * thematic files in the scheduler/ subdirectory for maintainability (each
 * <500 lines). Each split file is loaded synchronously via document.write()
 * during the initial page parse, preserving the original single-<script>
 * behavior — the HTML still references `/js/scheduler.js`, and every split
 * file shares the same global scope exactly as the original monolith did
 * (the original was a single DOMContentLoaded callback whose entire body
 * has been hoisted into the global lexical environment of classic
 * <script> tags).
 *
 * File manifest (loaded in dependency order):
 *   scheduler/state.js          — gtss API destructure (fetchJSON,
 *                                 showToast, getSocket), LIMITS,
 *                                 PLATFORM_COLORS, getMonday (used by the
 *                                 currentWeekStart initializer), shared
 *                                 mutable state (currentWeekStart,
 *                                 uploadedMediaPath, uploadedMediaFilePath,
 *                                 editingPostId, editingPostMedia, isPaused,
 *                                 carouselFiles, schedulerContext, dragSrcEl),
 *                                 `$` DOM-id helper
 *   scheduler/domRefs.js        — every cached `const` DOM element reference
 *                                 (postBody, charCounters, scheduleDate,
 *                                 scheduleTime, postNowBtn, scheduleBtn,
 *                                 generateCaptionBtn, aiTopic, mediaFileInput,
 *                                 mediaDropzone, mediaPlaceholder,
 *                                 mediaPreview, mediaThumb, mediaFilename,
 *                                 mediaRemoveBtn, calendarGrid,
 *                                 weekRangeLabel, queueList, queueCountBadge,
 *                                 pauseToggle, pauseToggleDot, pauseBanner,
 *                                 schedulerStatusLabel, liveLogPanel,
 *                                 liveLogBody, publishedBody, imageGenTopic,
 *                                 imageGenStyle, imageGenPlatform,
 *                                 imageGenStartBtn, imageGenStatus,
 *                                 imageGenOutput, imageGenPrompt,
 *                                 imageGenFile, imageGenLog, imageGenContext,
 *                                 igPostOptions, igCaptionHelper, igPreviewBox,
 *                                 igHashtagRecommendation, igStoryWarning,
 *                                 igCarouselPanel, carouselFileInput,
 *                                 carouselThumbnails)
 *   scheduler/helpers.js        — getSelectedPlatforms, formatDate,
 *                                 formatLocalDateInput, formatWeekRange,
 *                                 refreshSchedulerViews, firstContextValue,
 *                                 joinContextValue, getImageContextSummary,
 *                                 loadSchedulerContext, updateCharCounters
 *   scheduler/instagram.js      — toggleInstagramOptions,
 *                                 updateInstagramCaptionHelper,
 *                                 checkStoryAspectRatio, handleDragStart,
 *                                 handleDragOver, handleDragLeave,
 *                                 handleDragEnter, handleDrop, handleDragEnd,
 *                                 renderCarouselThumbnails
 *   scheduler/calendar.js       — loadCalendar (weekly grid renderer)
 *   scheduler/queue.js          — loadQueue (up-next sidebar) +
 *                                 loadPublishedLog (published table with
 *                                 stats editing)
 *   scheduler/pauseState.js     — loadPauseState + updatePauseUI
 *   scheduler/editModal.js      — openEditModal + closeEditModal (loaders
 *                                 only; bindings live in bindEditModal.js)
 *   scheduler/publishStream.js  — startPublishStream (Socket.IO +
 *                                 legacy SSE for live publish log)
 *   scheduler/imageGeneration.js — appendImageGenLog,
 *                                 refreshImageGenResult, startImageGenStream
 *   scheduler/uploadMedia.js    — uploadMediaFile (single-image uploader,
 *                                 extracted from the original bindEvents
 *                                 inner function)
 *   scheduler/bindComposer.js   — bindComposer() — composer event bindings
 *                                 (postBody input, platform-checkbox,
 *                                 media upload, IG post-type radios,
 *                                 carousel upload, AI caption, AI image gen)
 *   scheduler/bindPostActions.js — bindPostActions() — Post Now + Schedule
 *                                 button bindings
 *   scheduler/bindNavigation.js — bindNavigation() — calendar week-nav
 *                                 (prev/next/today) + tab-calendar /
 *                                 tab-published + pause-toggle bindings
 *   scheduler/bindEditModal.js  — bindEditModal() — edit-modal close /
 *                                 backdrop / save / delete / publish-now
 *                                 bindings
 *   scheduler/init.js           — bindEvents() (calls the 4 bind*
 *                                 functions) + init() + DOMContentLoaded
 *                                 boot (prefills scheduleDate / scheduleTime
 *                                 with the next rounded hour, then init())
 *
 * Original scheduler.js was ~1,313 lines; this loader is the only file
 * the HTML references directly (see public/pages/content-scheduler.html
 * line 426).
 */

(function () {
  // The split files in dependency order. state.js must load first (it
  // declares every shared `let`/`const` binding in the global lexical
  // environment, plus the `getMonday` function the `currentWeekStart`
  // initializer depends on); init.js must load last (it wires up
  // DOMContentLoaded, which fires after parse). Everything in between can
  // be re-ordered without breaking behavior because function declarations
  // are looked up at call time, not at parse time — the only constraint is
  // that domRefs.js must come before any file that references a DOM ref
  // at parse time (none of them do; they only reference DOM refs inside
  // function bodies, which run later).
  var files = [
    'scheduler/state.js',
    'scheduler/domRefs.js',
    'scheduler/helpers.js',
    'scheduler/instagram.js',
    'scheduler/calendar.js',
    'scheduler/queue.js',
    'scheduler/pauseState.js',
    'scheduler/editModal.js',
    'scheduler/publishStream.js',
    'scheduler/imageGeneration.js',
    'scheduler/uploadMedia.js',
    'scheduler/bindComposer.js',
    'scheduler/bindPostActions.js',
    'scheduler/bindNavigation.js',
    'scheduler/bindEditModal.js',
    'scheduler/init.js'
  ];

  // Resolve the base URL of THIS script (scheduler.js) so the split files
  // load from the same directory regardless of how the app is mounted.
  // `document.currentScript.src` is e.g. "/js/scheduler.js" (or an absolute
  // URL like "http://host/js/scheduler.js"); stripping the trailing
  // "scheduler.js" leaves the "/js/" base, so e.g. "scheduler/state.js"
  // resolves to "/js/scheduler/state.js".
  var base = (document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/scheduler\.js$/, '')
    : 'js/';

  // document.write() of a <script> tag during parse is synchronous — the
  // browser blocks on fetching and executing each script before moving on.
  // This is exactly what we want: it preserves the original "everything
  // available by the time DOMContentLoaded fires" guarantee.
  files.forEach(function (f) {
    document.write('<script src="' + base + f + '"><\/script>');
  });
})();
