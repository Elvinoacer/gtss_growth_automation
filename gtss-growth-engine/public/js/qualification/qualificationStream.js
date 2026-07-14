/**
 * qualification/qualificationStream.js — Socket.IO + legacy SSE listener
 * for a single qualification batch job on the Lead Qualification page.
 *
 * Exposes (via global scope):
 *   - attachQualificationStream(jobId, doneLabel = "Qualification complete!")
 *       Wires the progress panel + socket listener to a job that is
 *       already running server-side. Used both right after `runQualification`
 *       creates a new job AND on page load by `resumeActiveQualification`
 *       (so a refresh or a second tab sees the same live progress instead
 *       of the idle Run button). Subscribes to the `qualification:event`
 *       socket channel and to a legacy SSE stream (whose only purpose is
 *       to trigger the backend stream registration).
 *
 * Depends on (from qualification/state.js, loaded earlier):
 *   - showToast, getSocket, progressFill, progressText, progressLabelText,
 *     progressPanel, runAllBtn, stopQualificationBtn, activeSocketHandler,
 *     activeJobId
 * Depends on (from qualification/table.js, loaded earlier):
 *   - loadLeads
 * Depends on (from qualification/stats.js, loaded earlier):
 *   - loadStats
 * Depends on (from window.gtss, set up in state.js):
 *   - initSSE
 */

function attachQualificationStream(
  jobId,
  doneLabel = "Qualification complete!",
) {
  // Legacy SSE to trigger backend stream
  const legacySSE = window.gtss.initSSE(`/api/qualification/stream/${jobId}`, () => {});

  const socket = getSocket();
  if (!socket) return;

  function onQualEvent(event) {
    if (!event) return;
    if (event.jobId && String(event.jobId) !== String(jobId)) return;

    if (event.type === "progress") {
      const pct =
        event.total > 0
          ? Math.round((event.processed / event.total) * 100)
          : 0;
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `${event.processed} / ${event.total} leads scored`;
    }

    if (event.type === "scored") {
      loadLeads();
    }

    if (event.type === "stopped") {
      progressLabelText.textContent = event.message || "Qualification stopped.";
      showToast("Qualification stopped.", "warn");
      cleanup();
      runAllBtn.disabled = false;
      stopQualificationBtn?.classList.add("hidden");
      activeJobId = null;
      loadStats();
      loadLeads();
    }

    if (event.type === "done") {
      progressFill.style.width = "100%";
      progressLabelText.textContent = doneLabel;
      progressText.textContent = `${event.result.processed} processed — ${event.result.qualified} qualified, ${event.result.deprioritized} deprioritized`;
      showToast(
        `Qualification complete: ${event.result.qualified} qualified`,
        "success",
      );
      showToast(
        "Qualification complete! Click 'Proceed to Messages' to generate outreach messages.",
        "success",
        8000,
      );

      cleanup();
      runAllBtn.disabled = false;
      stopQualificationBtn?.classList.add("hidden");
      activeJobId = null;
      loadStats();
      loadLeads();

      setTimeout(() => {
        progressPanel.classList.remove("visible");
      }, 5000);
    }

    if (event.type === "error") {
      showToast(`Error: ${event.message}`, "error");
    }
  }

  function cleanup() {
    socket.off('qualification:event', onQualEvent);
    if (legacySSE) legacySSE.close();
    activeSocketHandler = null;
  }

  activeSocketHandler = onQualEvent;
  socket.on('qualification:event', onQualEvent);
}
