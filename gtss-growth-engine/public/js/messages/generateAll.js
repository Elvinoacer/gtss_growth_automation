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
 *   - retryFallbacks() — re-runs Gemini for leads stuck on template /
 *       template-fallback drafts via POST /api/messages/retry-fallbacks.
 *
 * Depends on (from messages/state.js, loaded earlier):
 *   - fetchJSON, showToast, getSocket, generateAllBtn, retryFallbacksBtn,
 *     progressPanel, progressFill, progressText, progressLabelText,
 *     activeSocketCleanup, selectedTone, selectedProduct
 * Depends on (from messages/table.js, loaded earlier):
 *   - loadMessages
 * Depends on (from messages/stats.js, loaded earlier):
 *   - loadStats
 */

function setBulkGenButtonsDisabled(disabled) {
  isBulkGenRunning = Boolean(disabled);
  if (generateAllBtn) generateAllBtn.disabled = disabled;
  // Retry is only locked while a bulk job is running — never permanently
  // from a stale fallback count.
  if (retryFallbacksBtn) {
    retryFallbacksBtn.disabled = disabled;
    if (!disabled && typeof updateRetryFallbacksButton === "function") {
      // Re-apply badge/title from latest table + stats.
      updateRetryFallbacksButton(null, null, { fromTable: true });
    }
  }
}

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

    if (event.type === "info" && event.message) {
      // Show cascade steps (API → Web → template) in the progress label.
      progressLabelText.textContent = String(event.message).slice(0, 120);
    }

    if (event.type === "generated") {
      loadMessages();
    }

    if (event.type === "done") {
      progressFill.style.width = "100%";
      progressLabelText.textContent = "Generation complete!";
      const aiApi = Number(event.result?.aiCount || 0);
      const aiWeb = Number(event.result?.aiWebCount || 0);
      const fbN = Number(event.result?.fallbackCount || 0);
      const failed = Number(event.result?.failed || 0);
      progressText.textContent = `${aiApi} API · ${aiWeb} Web · ${fbN} template · ${failed} failed`;
      const succeeded = Number(event.result?.succeeded || 0);
      showToast(
        `Generated messages for ${succeeded} lead${succeeded === 1 ? "" : "s"}`,
        "success",
      );

      cleanup();
      setBulkGenButtonsDisabled(false);
      loadStats();
      loadMessages();

      const aiN = aiApi + aiWeb;
      if (fbN > 0 && aiN === 0) {
        showToast(
          `Still on template fallback for ${fbN} lead(s). Check Gemini API key and Gemini browser login, then Retry All Fallbacks.`,
          "error",
        );
      } else if (fbN > 0) {
        showToast(
          `${aiApi} via API, ${aiWeb} via Web; ${fbN} still on template.`,
          "info",
        );
      } else if (aiWeb > 0) {
        showToast(
          `${aiApi} via API, ${aiWeb} via Gemini Web.`,
          "success",
        );
      }

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
    if (!status.active) {
      // Ensure buttons are free after a reclaimed stale job.
      setBulkGenButtonsDisabled(false);
      return;
    }
    setBulkGenButtonsDisabled(true);
    attachToMessageJob(status.jobId, { alreadyRunning: true });
  } catch (err) {
    console.error("Failed to check active message-generation job", err);
    setBulkGenButtonsDisabled(false);
  }
}

async function generateAll() {
  setBulkGenButtonsDisabled(true);
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
      setBulkGenButtonsDisabled(false);
      return;
    }

    attachToMessageJob(jobId);
  } catch (err) {
    showToast(err.message, "error");
    progressPanel.classList.remove("visible");
    setBulkGenButtonsDisabled(false);
  }
}

/**
 * Re-attempt Gemini for every lead currently stuck on Template fallback.
 * Visible only when stats.fallback_leads > 0.
 */
async function retryFallbacks() {
  setBulkGenButtonsDisabled(true);
  progressPanel.classList.add("visible");
  progressFill.style.width = "0%";
  progressText.textContent = "Starting...";
  progressLabelText.textContent =
    "Retrying fallbacks: Gemini API → Gemini Web → template...";

  try {
    const { jobId, pendingCount, message } = await fetchJSON(
      "/api/messages/retry-fallbacks",
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
      showToast(message || "No template-fallback messages to retry", "info");
      progressPanel.classList.remove("visible");
      setBulkGenButtonsDisabled(false);
      return;
    }

    showToast(
      `Retrying Gemini for ${pendingCount} lead(s) with template fallbacks...`,
      "info",
    );
    attachToMessageJob(jobId);
  } catch (err) {
    showToast(err.message, "error");
    progressPanel.classList.remove("visible");
    setBulkGenButtonsDisabled(false);
  }
}
