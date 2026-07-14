/* global gtss, io */
/**
 * automation.js — Automation Control Page (module loader)
 *
 * Features (split across the automation/ subdirectory):
 *   - Run Queue / Stop buttons with real-time log stream (Socket.IO)
 *   - Reconnect to an already-running automation job on page refresh
 *     (resumeActiveAutomation)
 *   - Per-platform daily-action limit cards (used / limit + DM-limit input)
 *   - Per-platform session status badges (Active / Expired) with one-click
 *     re-authentication (POST /api/sessions/authenticate/:platform)
 *   - Queue table grouped by Runnable / Waiting / Blocked, with per-row
 *     Retry / Skip hover buttons + checkbox multi-select for bulk retry
 *   - Queue summary bar with one-click "Retry all / waiting / blocked /
 *     by-category" buttons
 *   - Post-run summary banner (sent / failed / skipped / waiting / blocked)
 *   - Manual DOM Recorder (capture a rendered DOM + screenshot as a
 *     "checkpoint" for a given platform / pipeline / tab / label)
 *   - CAPTCHA banner with manual-open-browser + manual-resume buttons
 *   - Passive Socket.IO listener for cross-tab queue updates
 *
 * This file is a thin loader. The actual UI code has been split into
 * thematic files in the automation/ subdirectory for maintainability (each
 * <500 lines). Each split file is loaded synchronously via document.write()
 * during the initial page parse, preserving the original single-<script>
 * behavior — the HTML still references `/js/automation.js`, and every
 * split file shares the same global scope exactly as the original
 * monolith did (the original was a single IIFE whose entire body has been
 * hoisted into the global lexical environment of classic <script> tags).
 *
 * File manifest (loaded in dependency order):
 *   automation/state.js        — gtss API destructure (fetchJSON,
 *                                showToast, initSocket, getSocket), shared
 *                                mutable state (activeJobId,
 *                                isAutomationRunning, socketSub,
 *                                sessionStatus, cachedLimits,
 *                                currentCaptchaPlatform, selectedRetryIds),
 *                                and every cached `const` DOM element
 *                                reference (run/stop buttons, queue body,
 *                                log container, limit cards, queue summary,
 *                                post-run banner, retry buttons, DOM-capture
 *                                controls, captcha banner / manual open /
 *                                manual resume)
 *   automation/helpers.js      — escapeHtml (regex-based — the original
 *                                IIFE declared escapeHtml twice and the
 *                                regex version won; only that version is
 *                                included here), formatDateTime
 *   automation/logging.js      — appendLog (timestamped log-line appender
 *                                colored by type) + logClearBtn click
 *                                binding (empties the log container)
 *   automation/domCapture.js   — Manual DOM Recorder: setDomCaptureStatus,
 *                                loadDomTabs, loadDomCaptures, saveDomCapture
 *                                + the 4 DOM-capture-panel event bindings
 *   automation/limits.js       — loadSessionStatus, loadLimits,
 *                                renderLimitCards + save-limit-btn +
 *                                auth-btn click bindings
 *   automation/queue.js        — loadQueue, buildQueueSummary,
 *                                renderQueueSummary, renderRunSummary,
 *                                renderQueueGroup, renderQueueRow,
 *                                renderQueue
 *   automation/retryActions.js — retryQueue, retrySelectedQueue,
 *                                updateSelectedRetryButton + queueBody
 *                                delegated click (checkbox / retry-btn /
 *                                skip-btn) + queueSummary category-btn +
 *                                retrySelectedBtn / queueSelectAll /
 *                                retryAllBtn / retryWaitingBtn /
 *                                retryBlockedBtn bindings
 *   automation/execution.js    — attachToAutomationJob (wires UI + socket
 *                                listeners to a running job; cleanup via
 *                                finishRun on done/error),
 *                                resumeActiveAutomation, startAutomation,
 *                                stopAutomation + runAllBtn / stopBtn
 *                                bindings
 *   automation/captcha.js      — showCaptchaWarning + manualOpenBtn /
 *                                manualResumeBtn bindings
 *   automation/socket.js       — Global passive Socket.IO listener
 *                                (automation:queue → reload queue + limits)
 *   automation/init.js         — init() (boot orchestrator: load status →
 *                                limits → queue → DOM captures → hide
 *                                post-run banner → resumeActiveAutomation →
 *                                startPolling [NOTE: startPolling /
 *                                POLL_IDLE_MS are referenced but not
 *                                defined anywhere in the codebase — this
 *                                throws at runtime, exactly as the
 *                                original did; behavior preserved verbatim])
 *                                + initial UI state setup (hide stop btn
 *                                + captcha banner) + init() call
 *
 * Original automation.js was ~963 lines; this loader is the only file
 * the HTML references directly (see public/pages/automation.html line 714).
 */

(function () {
  // The split files in dependency order. state.js must load first (it
  // declares every shared `let`/`const` binding in the global lexical
  // environment, plus the gtss API destructure that several other files
  // call at top-level — e.g. socket.js's `const socket = getSocket();`).
  // init.js must load last (it calls init() at the end, after every other
  // split file has registered its top-level bindings). The middle files
  // can be re-ordered without breaking behavior because:
  //   - Function declarations are looked up at call time, not at parse
  //     time — cross-file forward references resolve correctly because
  //     they're only invoked at runtime (after all split files are loaded).
  //   - Top-level addEventListener calls only need their target element
  //     to exist, which is guaranteed because the script tag lives at
  //     the end of <body> in automation.html.
  var files = [
    'automation/state.js',
    'automation/helpers.js',
    'automation/logging.js',
    'automation/domCapture.js',
    'automation/limits.js',
    'automation/queue.js',
    'automation/retryActions.js',
    'automation/execution.js',
    'automation/captcha.js',
    'automation/socket.js',
    'automation/init.js'
  ];

  // Resolve the base URL of THIS script (automation.js) so the split
  // files load from the same directory regardless of how the app is
  // mounted. `document.currentScript.src` is e.g. "/js/automation.js"
  // (or an absolute URL like "http://host/js/automation.js"); stripping
  // the trailing "automation.js" leaves the "/js/" base, so e.g.
  // "automation/state.js" resolves to "/js/automation/state.js".
  var base = (document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/automation\.js$/, '')
    : 'js/';

  // document.write() of a <script> tag during parse is synchronous — the
  // browser blocks on fetching and executing each script before moving on.
  // This is exactly what we want: it preserves the original "everything
  // available by the time the IIFE's init() runs" guarantee.
  files.forEach(function (f) {
    document.write('<script src="' + base + f + '"><\/script>');
  });
})();
