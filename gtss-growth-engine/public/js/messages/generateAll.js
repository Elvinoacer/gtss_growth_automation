/**
 * messages/generateAll.js — Bulk "Generate All" message-generation flow for
 * the Message Generator page.
 *
 * Exposes (via global scope):
 *   - attachToMessageJob(jobId, { alreadyRunning }) — wires the progress
 *       panel + socket listener to an already-running server-side job.
 *       Used both right after `generateAll` creates a new job AND on page
 *       load by `resumeActiveMessageGeneration` (so a refresh or a second
 *       tab sees the same live progress instead of the idle button).
 *   - resumeActiveMessageGeneration() — called once on page load; if a
 *       bulk message-generation job is already running, rehydrates the
 *       progress panel and reattaches the live listener.
 *   - generateAll() — kicks off a fresh bulk-generation job via
 *       POST /api/messages/generate-all using the current tone + product
 *       pitch, then attaches the live listener.
 *
 * Depends on (from messages/state.js, loaded earlier):
 *   - fetchJSON, showToast, getSocket, generateAllBtn, progressPanel,
 *     progressFill, progressText, progressLabelText, activeSocketCleanup,
 *     selectedTone, selectedProduct
 * Depends on (from messages/table.js, loaded earlier):
 *   - loadMessages
 * Depends on (from messages/stats.js, loaded earlier):
 *   - loadStats
 */

// Wire the progress panel + socket listener to a job that is already
// running server-side. Used both right after creating a new job
// (generateAll) and when we discover on page load that one was already
// in progress (resumeActiveMessageGeneration) — so a refresh or a second
// tab shows the same live progress instead of the idle button.
function attachToMessageJob(jobId, { alreadyRunning = false } = {}) {
  progressPanel.classList.add("visible");
  if (alreadyRunning) {
    progressText.textContent = "Reconnecting...";
    progressLabelText.textContent = "Generating messages with Gemini AI...";
  }

  // Legacy SSE to trigger backend stream. If the job is already running,
  // this just registers the stream for future events (see the
  // /api/messages/stream handler, which only calls registerJobStream).
  const legacySSE = window.gtss.initSSE(`/api/messages/stream/${jobId}`, () => {});

  const socket = getSocket();
  if (!socket) return;

  function onMsgEvent(event) {
    if (!event) return;
    if (event.jobId && String(event.jobId) !== String(jobId)) return;

    if (event.type === "progress") {
      const pct =
        event.total > 0
          ? Math.round((event.processed / event.total) * 100)
          : 0;
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `${event.processed} / ${event.total} messages generated`;
    }

    if (event.type === "generated") {
      loadMessages();
    }

    if (event.type === "done") {
      progressFill.style.width = "100%";
      progressLabelText.textContent = "Generation complete!";
      progressText.textContent = `${event.result.succeeded} generated, ${event.result.failed} failed`;
      showToast(
        `Generated messages for ${event.result.succeeded} leads`,
        "success",
      );

      cleanup();
      generateAllBtn.disabled = false;
      loadStats();
      loadMessages();

      setTimeout(() => {
        progressPanel.classList.remove("visible");
      }, 5000);
    }

    if (event.type === "error") {
      showToast(`Error: ${event.message}`, "error");
    }
  }

  function cleanup() {
    socket.off('messages:event', onMsgEvent);
    if (legacySSE) legacySSE.close();
    activeSocketCleanup = null;
  }

  activeSocketCleanup = cleanup;
  socket.on('messages:event', onMsgEvent);
}

// Called once on page load. If a bulk message-generation job is already
// running, rehydrate the progress panel and reattach the live listener
// instead of showing the idle Generate button as if nothing were
// happening.
async function resumeActiveMessageGeneration() {
  try {
    const status = await fetchJSON("/api/messages/active");
    if (!status.active) return;
    generateAllBtn.disabled = true;
    attachToMessageJob(status.jobId, { alreadyRunning: true });
  } catch (err) {
    console.error("Failed to check active message-generation job", err);
  }
}

async function generateAll() {
  generateAllBtn.disabled = true;
  progressPanel.classList.add("visible");
  progressFill.style.width = "0%";
  progressText.textContent = "Starting...";
  progressLabelText.textContent = "Generating messages with Gemini AI...";

  try {
    const { jobId, pendingCount } = await fetchJSON(
      "/api/messages/generate-all",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productPitch: selectedProduct,
          tone: selectedTone,
        }),
      },
    );

    if (!jobId) {
      showToast("No qualified leads without messages", "info");
      progressPanel.classList.remove("visible");
      generateAllBtn.disabled = false;
      return;
    }

    attachToMessageJob(jobId);
  } catch (err) {
    showToast(err.message, "error");
    progressPanel.classList.remove("visible");
    generateAllBtn.disabled = false;
  }
}
