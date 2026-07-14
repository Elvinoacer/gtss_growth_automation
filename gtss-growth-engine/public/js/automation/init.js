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
 *   7. Surface warnings for any expired sessions.
 *   8. Start a 15s background poll that keeps queue + limits fresh even
 *      when no socket event arrives (defensive fallback so the page never
 *      feels stale if Socket.IO is silent).
 *
 * Also performs the initial UI state setup at the top level:
 *   - stopBtn.style.display = "none" (Stop button hidden until a run starts)
 *   - captchaBanner.style.display = "none" (CAPTCHA banner hidden until a
 *     captcha event arrives)
 */

// Idle polling interval — keeps the queue + limits fresh even when no
// socket event arrives. The original automation.js referenced this name
// but never declared it (and never declared startPolling either), which
// threw a ReferenceError at runtime and aborted init() before the expired-
// session-warning loop could run. We declare both here so init() completes.
const POLL_IDLE_MS = 15_000;

function startPolling(intervalMs = POLL_IDLE_MS) {
  setInterval(async () => {
    try {
      await Promise.all([loadQueue(), loadLimits(), loadSessionStatus()]);
    } catch (err) {
      // Silent — polling is best-effort. The socket will still deliver
      // real-time updates when it's connected.
    }
  }, intervalMs);
}

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
  startPolling(POLL_IDLE_MS);

  // Surface warnings for any expired sessions (status already fetched).
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
