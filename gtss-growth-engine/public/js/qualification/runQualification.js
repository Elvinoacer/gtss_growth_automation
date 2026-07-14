/**
 * qualification/runQualification.js — Run / Stop / Resume the bulk AI
 * qualification flow for the Lead Qualification page.
 *
 * Exposes (via global scope):
 *   - runQualification()          — async; kicks off a fresh bulk AI
 *                                    scoring job via
 *                                    POST /api/qualification/run, then
 *                                    attaches the live listener
 *   - stopQualification()         — async; sends a stop signal to
 *                                    POST /api/qualification/stop/:jobId
 *   - resumeActiveQualification() — async; called once on page load. If a
 *                                    qualification batch is already running
 *                                    (started from this tab before a
 *                                    refresh, or from another tab),
 *                                    rehydrates the progress panel and
 *                                    reattaches the live listener instead
 *                                    of showing the idle Run button as if
 *                                    nothing were happening.
 *
 * Also runs one immediate top-level statement at script-load time:
 *   - stopQualificationBtn?.addEventListener("click", stopQualification)
 * This is preserved verbatim from the original IIFE body, where it
 * appeared right after the resumeActiveQualification declaration.
 *
 * Depends on (from qualification/state.js, loaded earlier):
 *   - fetchJSON, showToast, runAllBtn, stopQualificationBtn, progressPanel,
 *     progressFill, progressText, progressLabelText, activeJobId
 * Depends on (from qualification/qualificationStream.js, loaded earlier):
 *   - attachQualificationStream
 */

async function runQualification() {
  runAllBtn.disabled = true;
  progressPanel.classList.add("visible");
  progressFill.style.width = "0%";
  progressText.textContent = "Starting...";
  progressLabelText.textContent = "Scoring leads with Gemini AI...";

  try {
    const { jobId } = await fetchJSON("/api/qualification/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    if (!jobId) {
      showToast("No pending leads to qualify", "info");
      progressPanel.classList.remove("visible");
      runAllBtn.disabled = false;
      return;
    }

    activeJobId = jobId;
    stopQualificationBtn?.classList.remove("hidden");
    attachQualificationStream(jobId, "Qualification complete!");
  } catch (err) {
    showToast(err.message, "error");
    progressPanel.classList.remove("visible");
    runAllBtn.disabled = false;
  }
}

async function stopQualification() {
  if (!activeJobId) return;
  await fetchJSON(`/api/qualification/stop/${activeJobId}`, { method: "POST" });
  showToast("Stop signal sent.", "warn");
}

// Called once on page load. If a qualification batch is already running
// (started from this tab before a refresh, or from another tab),
// rehydrate the progress panel and reattach the live listener instead of
// showing the idle Run button as if nothing were happening.
async function resumeActiveQualification() {
  try {
    const status = await fetchJSON("/api/qualification/active");
    if (!status.active) return;

    activeJobId = status.jobId;
    runAllBtn.disabled = true;
    stopQualificationBtn?.classList.remove("hidden");
    progressPanel.classList.add("visible");
    progressText.textContent = "Reconnecting...";
    progressLabelText.textContent = "Scoring leads with Gemini AI...";
    attachQualificationStream(status.jobId, "Qualification complete!");
  } catch (err) {
    console.error("Failed to check active qualification job", err);
  }
}

stopQualificationBtn?.addEventListener("click", stopQualification);
