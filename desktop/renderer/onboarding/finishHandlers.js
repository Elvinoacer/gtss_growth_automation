/**
 * onboarding/finishHandlers.js — Finish button + Restart Chrome button.
 *
 * Two top-level event listeners (attached at script-load time):
 *
 *   1. $("#onboard-finish").addEventListener("click", ...) — the main
 *      "Finish & start" button. Disables the button, shows the progress
 *      checklist, subscribes to the onboarding:progress stream BEFORE
 *      calling complete() (so we don't miss early stages), then calls
 *      window.gtss.onboarding.complete({ passphrase, geminiKey }).
 *      On success: shows "Done! ✓", keeps the listener attached for
 *      any final "ready" event, and defensively stops the listener
 *      after 30s in case the window swap is delayed. On failure:
 *      re-enables the button, surfaces the error in the dedicated
 *      error element + as a toast, stops the listener so the user
 *      can retry.
 *
 *   2. $("#finish-warning-restart")?.addEventListener("click", ...) —
 *      the "Restart Chrome" button inside the warning callout
 *      (clone:warning / browser:warning). Hides the callout, re-shows
 *      the progress checklist, re-subscribes to the progress stream,
 *      and calls window.gtss.cdp.restart() (which closes the spawned
 *      Chrome, re-runs the profile clone, and re-spawns Chrome). Falls
 *      back to a toast telling the user to click "Finish & start"
 *      again if window.gtss.cdp.restart isn't available (older main
 *      process build).
 *
 * Cross-file dependencies (call-time only): $ (state.js), collected
 * (state.js — read), showFinishProgress (finishProgress.js),
 * startFinishProgressListener, stopFinishProgressListener
 * (finishProgressListener.js), toast (toast.js),
 * window.gtss.onboarding.complete / window.gtss.cdp.restart (provided
 * by the Electron preload bridge), finishErrorEl (state.js — read).
 */

// ─── Step 3: Finish ──────────────────────────────────────────────────────────

$("#onboard-finish").addEventListener("click", async () => {
  const btn = $("#onboard-finish");
  btn.disabled = true;
  btn.textContent = "Saving & starting...";
  showFinishProgress();
  // Subscribe BEFORE calling complete() so we don't miss the early
  // stages (server / browser init can fire within milliseconds).
  startFinishProgressListener();
  const res = await window.gtss.onboarding.complete({
    passphrase: collected.passphrase,
    geminiKey: collected.geminiKey,
  });
  if (res && res.ok) {
    // main.js will close this window and open the control panel.
    // The progress checklist stays visible (showing all-green ✓) until
    // the window is destroyed. We keep the listener attached so any
    // final "ready" event arrives cleanly.
    btn.textContent = "Done! ✓";
    btn.classList.add("btn-success");
    // Defensive: stop the listener after 30s in case the window swap
    // is delayed for some reason.
    setTimeout(() => stopFinishProgressListener(), 30000);
  } else {
    // Startup failed — keep the onboarding window open so the user can
    // see the error and retry. The failing step already shows a red ✗
    // via markFinishStageError(); we also surface the error message in
    // the dedicated error element under the checklist.
    btn.disabled = false;
    btn.textContent = "Finish & start →";
    if (finishErrorEl) {
      finishErrorEl.hidden = false;
      finishErrorEl.textContent = res?.error || "Failed to start the server. Click Finish & start to retry.";
    }
    stopFinishProgressListener();
    toast(res?.error || "Failed to save onboarding data.", "error");
  }
});

// ─── Restart Chrome button (NEW) ─────────────────────────────────────────────
//
// The warning callout (clone:warning / browser:warning) surfaces a
// "Restart Chrome" button so the user can recover from a locked-Chrome
// condition without re-running the entire wizard. Clicking it:
//   1. Hides the warning callout.
//   2. Re-runs the CDP restart path (which closes the spawned Chrome,
//      re-runs the profile clone, and re-spawns Chrome).
//   3. Re-subscribes to the progress stream so the checklist updates
//      as the restart progresses.
//
// If window.gtss.cdp.restart isn't available (older main process),
// we fall back to telling the user to click "Finish & start" again.
$("#finish-warning-restart")?.addEventListener("click", async () => {
  const restartBtn = $("#finish-warning-restart");
  if (!restartBtn) return;
  const original = restartBtn.textContent;
  restartBtn.disabled = true;
  restartBtn.textContent = "Restarting Chrome...";
  const callout = $("#finish-progress-warning");
  // Hide the callout immediately so the user sees their click registered.
  if (callout) callout.hidden = true;
  // Re-show the progress checklist in its "in progress" state.
  showFinishProgress();
  startFinishProgressListener();
  try {
    if (window.gtss && window.gtss.cdp && typeof window.gtss.cdp.restart === "function") {
      const res = await window.gtss.cdp.restart();
      if (!res || !res.ok) {
        toast(res?.error || "Couldn't restart Chrome automatically. Close Chrome manually and click Finish & start again.", "warning", 7000);
      }
    } else {
      toast("Restart Chrome isn't available in this build. Close Chrome manually and click Finish & start again.", "warning", 7000);
    }
  } catch (err) {
    toast(`Failed to restart Chrome: ${err.message || err}`, "error");
  } finally {
    restartBtn.disabled = false;
    restartBtn.textContent = original;
  }
});
