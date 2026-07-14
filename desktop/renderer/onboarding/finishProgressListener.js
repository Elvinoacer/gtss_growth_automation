/**
 * onboarding/finishProgressListener.js — IPC progress subscription.
 *
 * `let progressUnsubscribe` is module-private to this file (only ever
 * read/written by startFinishProgressListener / stopFinishProgressListener)
 * — kept here next to its sole users, same convention as
 * scheduler/instagram.js's `let dragSrcEl`.
 *
 * startFinishProgressListener() — subscribes to the structured
 * "onboarding:progress" IPC channel (window.gtss.onboarding.onProgress).
 * Each event is { stage, message, ts } where `stage` is a stable
 * identifier emitted by Lifecycle.startAll(). Maps stages to UI step
 * updates:
 *   - "*:error"    → markFinishStageError(baseStage, message)
 *   - "*:warning"  → markFinishStageWarning(baseStage, message) (NEW)
 *   - "ready"      → markAllFinishStagesDone()
 *   - any STAGE_ORDER member → markFinishStageActive(stage)
 *   - "start"      → no-op (initial banner, no step change)
 *
 * stopFinishProgressListener() — unsubscribes the listener (defensive
 * try/catch in case the unsubscribe function itself throws). Called
 * after a successful finish (after a 30s defensive delay) and
 * immediately on finish failure.
 *
 * MUST be called BEFORE window.gtss.onboarding.complete() so we don't
 * miss the early stages (server / browser init can fire within
 * milliseconds). See finishHandlers.js.
 *
 * Cross-file dependencies (call-time only): STAGE_ORDER (state.js),
 * markFinishStageError, markFinishStageWarning,
 * markAllFinishStagesDone, markFinishStageActive (finishProgress.js),
 * window.gtss.onboarding.onProgress (provided by the Electron preload
 * bridge).
 */

let progressUnsubscribe = null;

function startFinishProgressListener() {
  if (!window.gtss || !window.gtss.onboarding || !window.gtss.onboarding.onProgress) return;
  progressUnsubscribe = window.gtss.onboarding.onProgress(({ stage, message }) => {
    if (!stage) return;
    // Error stages are suffixed with ":error".
    if (stage.endsWith(":error")) {
      const baseStage = stage.slice(0, -":error".length);
      markFinishStageError(baseStage, message);
      return;
    }
    // Warning stages are suffixed with ":warning" (NEW).
    // These are non-fatal but actionable: we keep the step visually
    // "done" and surface a yellow callout with a Restart button so the
    // user can recover without re-running the whole wizard.
    if (stage.endsWith(":warning")) {
      const baseStage = stage.slice(0, -":warning".length);
      markFinishStageWarning(baseStage, message);
      return;
    }
    if (stage === "ready") {
      // Everything done.
      markAllFinishStagesDone();
      return;
    }
    if (STAGE_ORDER.includes(stage)) {
      markFinishStageActive(stage);
    }
    // "start" is just an initial banner — no step change.
  });
}

function stopFinishProgressListener() {
  if (typeof progressUnsubscribe === "function") {
    try { progressUnsubscribe(); } catch (_) {}
    progressUnsubscribe = null;
  }
}
