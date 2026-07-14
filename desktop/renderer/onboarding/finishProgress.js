/**
 * onboarding/finishProgress.js — Finish-step progress checklist UI.
 *
 * Six helpers that mutate the finish-progress checklist DOM (the
 * #finish-progress panel shown when the user clicks "Finish & start").
 * Each stage in STAGE_ORDER (server / browser / clone / endpoint /
 * ready) has a corresponding .finish-progress-step element with
 * data-stage="..." (cached in finishStepEls in state.js at load time).
 *
 * Exposes:
 *   - showFinishProgress()          — reveals the panel, resets every
 *                                     step to pending, hides the error
 *                                     element + the warning callout.
 *                                     Called when the user clicks
 *                                     "Finish & start" and again when
 *                                     they click "Restart Chrome".
 *   - markFinishStageActive(stage)  — marks the given stage "active"
 *                                     and all earlier stages "done"
 *                                     (handles skipped stages like
 *                                     "clone" when attaching to an
 *                                     existing Chrome).
 *   - markFinishStageDone(stage)    — marks the given stage "done".
 *   - markFinishStageError(stage, message)
 *                                   — marks the given stage "error"
 *                                     (red ✗) and surfaces the message
 *                                     in the dedicated error element.
 *                                     Falls back to "server" if the
 *                                     stage isn't tracked.
 *   - markFinishStageWarning(stage, message)
 *                                   — non-fatal-but-actionable variant
 *                                     (yellow callout with a Restart
 *                                     Chrome button). Keeps the step
 *                                     visually "done" but stashes the
 *                                     stage on the callout's dataset
 *                                     so the Restart button knows
 *                                     which recovery action to invoke.
 *                                     Used for "clone:warning" (Chrome
 *                                     is locked) and "browser:warning"
 *                                     (fell back to isolated-browser
 *                                     mode).
 *   - markAllFinishStagesDone()     — marks every stage "done" (used
 *                                     when the "ready" stage arrives).
 *
 * Cross-file dependencies (call-time only): $ (state.js), STAGE_ORDER,
 * finishStepEls, finishErrorEl (state.js).
 */

function showFinishProgress() {
  if (!finishProgressEl) return;
  finishProgressEl.hidden = false;
  // Reset all steps to pending.
  STAGE_ORDER.forEach((key) => {
    const el = finishStepEls[key];
    if (!el) return;
    el.classList.remove("active", "done", "error");
  });
  if (finishErrorEl) {
    finishErrorEl.hidden = true;
    finishErrorEl.textContent = "";
  }
  // Reset the warning callout too (NEW). A previous run may have left
  // it visible after a clone:warning; when the user clicks Restart
  // Chrome (or Finish & start again), we want a clean slate.
  const warningCallout = $("#finish-progress-warning");
  if (warningCallout) {
    warningCallout.hidden = true;
    const msgEl = warningCallout.querySelector(".finish-warning-message");
    if (msgEl) msgEl.textContent = "";
    delete warningCallout.dataset.stage;
  }
}

function markFinishStageActive(stage) {
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx < 0) return;
  // Mark all earlier stages as done (they must have completed for us to
  // reach this stage). This handles skipped stages (e.g., "clone" is
  // skipped when we attach to an existing Chrome) gracefully.
  for (let i = 0; i < idx; i++) {
    const el = finishStepEls[STAGE_ORDER[i]];
    if (el) {
      el.classList.remove("active", "error");
      el.classList.add("done");
    }
  }
  const el = finishStepEls[stage];
  if (el) {
    el.classList.remove("done", "error");
    el.classList.add("active");
  }
}

function markFinishStageDone(stage) {
  const el = finishStepEls[stage];
  if (!el) return;
  el.classList.remove("active", "error");
  el.classList.add("done");
}

function markFinishStageError(stage, message) {
  // If the stage isn't one of our tracked steps, fall back to "server"
  // so the error is at least visible somewhere.
  const key = STAGE_ORDER.includes(stage) ? stage : "server";
  const el = finishStepEls[key];
  if (el) {
    el.classList.remove("active", "done");
    el.classList.add("error");
  }
  if (finishErrorEl && message) {
    finishErrorEl.hidden = false;
    finishErrorEl.textContent = message;
  }
}

// ─── Warning callout (NEW) ─────────────────────────────────────────────────
//
// Distinct from `markFinishStageError`: a warning is a non-fatal but
// actionable condition. The step is still considered "done" (we did
// finish cloning — we just didn't get any sessions out of it) but the
// user needs to do something (close Chrome and click Restart). The
// warning callout shows the message + a Restart Chrome button so the
// user can re-trigger the clone without restarting the whole app.
//
// Used for:
//   - "clone:warning" — Chrome is locked, profile copy produced no sessions
//   - "browser:warning" — fell back to isolated-browser mode (no cloned
//     sessions will be available; the user will need to sign in manually)
function markFinishStageWarning(stage, message) {
  // Keep the step visually "done" (the clone did run, the browser did
  // come up) — but show a yellow callout with the actionable message.
  const key = STAGE_ORDER.includes(stage) ? stage : null;
  if (key) {
    markFinishStageDone(key);
  }
  const callout = $("#finish-progress-warning");
  if (callout && message) {
    callout.hidden = false;
    const msgEl = callout.querySelector(".finish-warning-message");
    if (msgEl) msgEl.textContent = message;
    // Stash the stage on the callout so the Restart button knows which
    // recovery action to invoke.
    callout.dataset.stage = stage || "";
  }
}

function markAllFinishStagesDone() {
  STAGE_ORDER.forEach((key) => markFinishStageDone(key));
}
