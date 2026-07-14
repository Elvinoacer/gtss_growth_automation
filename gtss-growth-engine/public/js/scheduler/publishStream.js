/* global gtss, io */
/**
 * scheduler/publishStream.js — Live publish-log stream for the Content
 * Scheduler page.
 *
 * Pulled verbatim from the original scheduler.js DOMContentLoaded callback
 * (lines 643-688). Wires up a Socket.IO listener (scheduler:event) plus a
 * legacy SSE stream (/api/scheduler/stream/:jobId) — the SSE stream is only
 * there to trigger the backend executor; the actual log lines arrive over
 * the socket. When the job finishes ("done" or "error"), the panel is
 * hidden after 3s and the calendar + queue are reloaded.
 */

// ── SSE Live Publish Log ──

function startPublishStream(jobId) {
  liveLogPanel.classList.remove("hidden");
  liveLogBody.innerHTML = "";

  // Legacy SSE to trigger backend stream
  const legacySSE = window.gtss.initSSE(
    `/api/scheduler/stream/${jobId}`,
    () => {},
  );

  const socket = getSocket();
  if (!socket) return;

  function onSchedulerEvent(data) {
    if (!data) return;
    if (data.jobId && String(data.jobId) !== String(jobId)) return;

    const line = document.createElement("div");
    const icon =
      data.type === "published" ? "✓" : data.type === "error" ? "✗" : "›";
    line.textContent = `${icon} ${data.message || data.type}`;
    if (data.type === "error") line.classList.add("text-error");
    if (data.type === "published") line.classList.add("text-green-600");
    liveLogBody.appendChild(line);
    liveLogBody.scrollTop = liveLogBody.scrollHeight;

    if (data.type === "done" || data.type === "error") {
      showToast(data.message, data.type === "done" ? "success" : "error");
      cleanup();
      setTimeout(() => {
        liveLogPanel.classList.add("hidden");
        loadCalendar();
        loadQueue();
      }, 3000);
    }
  }

  function cleanup() {
    socket.off("scheduler:event", onSchedulerEvent);
    if (legacySSE) legacySSE.close();
  }

  socket.on("scheduler:event", onSchedulerEvent);
}
