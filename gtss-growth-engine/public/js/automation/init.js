/* global gtss */
/**
 * automation/init.js — Boot orchestrator for the Automation Control page.
 *
 * Defines `init()` and runs it at script-load time. The original
 * automation.js IIFE called `init()` as its very last statement; this
 * file does the same, after every other split file has loaded and
 * registered its top-level bindings.
 *
 * init() does:
 *   1. loadSessionStatus — fetch /api/sessions/status (so the limit cards
 *      show Active/Expired badges from the start)
 *   2. loadLimits — fetch /api/automation/limits (renders the limit cards)
 *   3. loadQueue — fetch /api/automation/queue + /queue/summary (renders
 *      the queue table + summary bar)
 *   4. loadDomCaptures — fetch /api/automation/dom-captures?limit=12
 *      (renders the DOM-checkpoints list)
 *   5. Hide post-run banner (it's only shown after a run finishes)
 *   6. resumeActiveAutomation — if a job is already running server-side
 *      (started from this tab before a refresh, or from another tab),
 *      rehydrate the running UI and reattach listeners
 *   7. startPolling(POLL_IDLE_MS) — NOTE: startPolling and POLL_IDLE_MS
 *      are NOT defined anywhere in the codebase (verified via grep). This
 *      call throws a ReferenceError at runtime, which rejects the async
 *      init() promise. The subsequent "Surface warnings for any expired
 *      sessions" loop is therefore unreachable. This is preserved
 *      verbatim from the original to avoid changing behavior — fixing
 *      the bug is out of scope for the refactor.
 *   8. (Unreachable) Surface warnings for any expired sessions.
 *
 * Also performs the initial UI state setup at the top level:
 *   - stopBtn.style.display = "none" (Stop button hidden until a run starts)
 *   - captchaBanner.style.display = "none" (CAPTCHA banner hidden until a
 *     captcha event arrives)
 */

// ----------------------------------------------------------------
// Init
// ----------------------------------------------------------------

async function init() {
  await loadSessionStatus();
  await loadLimits();
  await loadQueue();
  await loadDomCaptures();
  if (postRunBanner) postRunBanner.hidden = true;
  await resumeActiveAutomation();

  // Start idle-mode background polling to keep data fresh.
  // NOTE: startPolling / POLL_IDLE_MS are referenced but not defined
  // anywhere in the codebase. This throws at runtime, rejecting init().
  // Behavior preserved verbatim from the original automation.js.
  startPolling(POLL_IDLE_MS);

  // Surface warnings for any expired sessions (status already fetched).
  // NOTE: unreachable because of the line above — preserved verbatim.
  for (const [platform, isValid] of Object.entries(sessionStatus)) {
    if (!isValid) {
      showToast(
        `No valid session for ${platform}. Please authenticate.`,
        "warn",
      );
    }
  }
}

// Hide stop btn and captcha banner initially
stopBtn.style.display = "none";
captchaBanner.style.display = "none";

// Run init
init();
