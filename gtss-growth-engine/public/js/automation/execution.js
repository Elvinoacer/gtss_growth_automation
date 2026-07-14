/* global gtss, io */
/**
 * automation/execution.js — Start / stop / resume / attach-to-running-job
 * for the Automation Control page.
 *
 * Pulled verbatim from the original automation.js IIFE (lines 645-791).
 * attachToAutomationJob is the core: it wires the Run button, Stop button,
 * log stream, and Socket.IO listeners to a job that is already running
 * server-side. Used both right after startAutomation creates a new job
 * AND when resumeActiveAutomation (called once on init) discovers a job
 * was already in progress — so a refresh or a second tab shows the same
 * "running" state instead of the idle Run Queue button.
 *
 * Exposes (via global scope):
 *   - attachToAutomationJob(jobId, { alreadyRunning }) — wires UI + socket
 *     listeners; sets up cleanup via finishRun() on "done" / terminal
 *     "error" events
 *   - resumeActiveAutomation() — GET /api/automation/active; if active,
 *     calls attachToAutomationJob(jobId, { alreadyRunning: true })
 *   - startAutomation() — POST /api/automation/run, then
 *     attachToAutomationJob(jobId)
 *   - stopAutomation() — POST /api/automation/stop/:jobId; shows a 10s
 *     "Stopping…" state on the Stop button as a graceful-halt affordance
 *
 * Top-level bindings (registered at script-load time):
 *   - runAllBtn "click" → startAutomation
 *   - stopBtn  "click" → stopAutomation
 */

// ----------------------------------------------------------------
// Automation Execution
// ----------------------------------------------------------------

function attachToAutomationJob(jobId, { alreadyRunning = false } = {}) {
  activeJobId = jobId;
  isAutomationRunning = true;
  runAllBtn.disabled = true;
  runAllBtn.innerHTML = `<span class="material-symbols-outlined animate-spin text-[18px]">refresh</span> <span class="truncate max-w-[200px]">${alreadyRunning ? "Running..." : "Starting..."}</span>`;
  stopBtn.style.display = "flex";

  appendLog(
    "info",
    alreadyRunning
      ? `Reconnected to automation job ${jobId} (already running)`
      : "Connected to real-time execution stream...",
  );

  // Connect SSE just to trigger the executor (backend needs it). If the
  // job is already running, this just registers the stream for future
  // log lines — see the /api/automation/stream handler, which only
  // triggers the executor for jobs still in pendingExecutors.
  const legacySSE = window.gtss.initSSE(`/api/automation/stream/${jobId}`, () => {});

  // Listen for all automation events via Socket.IO
  function onAutomationLog(event) {
    if (!event) return;
    appendLog(event.type, event.message, event);

    if (event.type === "captcha") {
      showCaptchaWarning(event.platform);
    }

    if (event.type === "state") {
      runAllBtn.innerHTML = `<span class="material-symbols-outlined animate-spin text-[18px]">refresh</span> <span class="truncate max-w-[200px]">${event.message}</span>`;
    }

    if (event.type === "done") {
      renderRunSummary(event);
      finishRun();
    }

    if (event.type === "error" && !event.message?.includes("Processing")) {
      // Only finish on terminal errors, not per-action errors
      if (event.message?.includes("Executor error") || event.message?.includes("stopped by user")) {
        finishRun();
      }
    }
  }

  function onAutomationRefresh() {
    loadLimits();
    loadQueue();
  }

  function onQueueUpdate() {
    loadQueue();
  }

  const socket = getSocket();
  if (socket) {
    socket.on('automation:log', onAutomationLog);
    socket.on('automation:refresh', onAutomationRefresh);
    socket.on('automation:queue', onQueueUpdate);
  }

  function finishRun() {
    if (legacySSE) legacySSE.close();
    if (socket) {
      socket.off('automation:log', onAutomationLog);
      socket.off('automation:refresh', onAutomationRefresh);
      socket.off('automation:queue', onQueueUpdate);
    }
    isAutomationRunning = false;
    activeJobId = null;
    runAllBtn.disabled = false;
    runAllBtn.innerHTML = `<span class="material-symbols-outlined" style="font-variation-settings: 'FILL' 1">play_arrow</span> Run Queue`;
    stopBtn.style.display = "none";
    loadQueue();
    loadLimits();
  }
}

// Called once on init. If automation is already running (started from
// this tab before a refresh, or from another tab), rehydrate the running
// UI and reattach listeners instead of showing the idle button.
async function resumeActiveAutomation() {
  try {
    const status = await fetchJSON("/api/automation/active");
    if (!status.active) return;
    attachToAutomationJob(status.jobId, { alreadyRunning: true });
  } catch (err) {
    // Non-fatal — worst case the page just shows the idle state until
    // the next automation:* event happens to arrive.
    console.error("Failed to check active automation job", err);
  }
}

async function startAutomation() {
  if (isAutomationRunning) return;

  // Clear captcha warning if visible
  captchaBanner.style.display = "none";
  if (postRunBanner) postRunBanner.hidden = true;

  try {
    const res = await fetchJSON("/api/automation/run", { method: "POST" });
    attachToAutomationJob(res.jobId);
  } catch (err) {
    showToast(err.message, "error");
    appendLog("error", err.message);
  }
}

async function stopAutomation() {
  if (!activeJobId) return;

  try {
    await fetchJSON(`/api/automation/stop/${activeJobId}`, {
      method: "POST",
    });
    appendLog("warn", "Stop signal sent.");
    stopBtn.disabled = true;
    stopBtn.innerHTML = `<span class="material-symbols-outlined animate-spin">refresh</span> Stopping…`;
    setTimeout(() => {
      if (stopBtn.disabled) {
        stopBtn.disabled = false;
        stopBtn.innerHTML = `<span class="material-symbols-outlined">stop_circle</span> Stop`;
        showToast(
          "Stop signal sent — automation will halt after the current action.",
          "warn",
        );
      }
    }, 10_000);
  } catch (err) {
    showToast(err.message, "error");
  }
}

// Top-level bindings — registered at script-load time (matches the
// original IIFE behavior, where these addEventListener calls sat at the
// bottom of the IIFE body and ran immediately when the IIFE executed).
runAllBtn.addEventListener("click", startAutomation);
stopBtn.addEventListener("click", stopAutomation);
