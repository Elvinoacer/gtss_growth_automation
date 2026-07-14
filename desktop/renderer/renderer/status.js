/**
 * renderer/status.js — server/CDP status hero card + 1.5s poll loop.
 *
 * Polls window.gtss.lifecycle.status() every 1.5s and renders the result
 * into the hero card (#hero-icon / #hero-label / #hero-meta) plus the
 * error card (#error-card) when state==='crashed'. Also drives the
 * enabled/disabled state of every lifecycle + CDP control button so the
 * UI never offers an action that would be no-op'd by the backend.
 *
 * Extracted from the original renderer.js for maintainability.
 */

/* global window, setInterval */

const heroIcon = (state) => {
  const el = $("#hero-icon");
  el.classList.remove("stopped", "starting", "running", "crashed");
  el.classList.add(state);
};

function updateHero(server, cdp) {
  const state = server.state;
  heroIcon(state);

  const labels = {
    stopped: "Stopped",
    starting: "Starting...",
    running: "Running",
    stopping: "Stopping...",
    crashed: "Crashed",
  };
  $("#hero-label").textContent = labels[state] || state;

  if (state === "running") {
    const since = server.startedAt ? new Date(server.startedAt).toLocaleTimeString() : "";
    const cdpInfo = cdp.state === "running"
      ? ` · Chrome CDP on port ${cdp.port} (automation browser, background)`
      : " · CDP inactive (isolated browser mode)";
    $("#hero-meta").textContent = `Server up since ${since} · PID ${server.pid} · http://localhost:${server.port}${cdpInfo}`;
  } else if (state === "starting") {
    $("#hero-meta").textContent =
      "Booting the server... check the Logs tab for live progress. The web app opens in your default browser once the port is ready.";
  } else if (state === "stopping") {
    $("#hero-meta").textContent = "Shutting down...";
  } else if (state === "crashed") {
    $("#hero-meta").textContent = "The server crashed. See the error above.";
  } else {
    $("#hero-meta").textContent = "Click Start to launch the app in your default browser.";
  }

  // Show/hide error card.
  const errorCard = $("#error-card");
  const statusHero = $("#status-hero");
  if (state === "crashed" && server.lastDiagnostic) {
    errorCard.classList.remove("hidden");
    statusHero.classList.add("hidden");
    $("#error-title").textContent = server.lastDiagnostic.title;
    $("#error-message").textContent = server.lastDiagnostic.message;
    $("#error-remedy").textContent = server.lastDiagnostic.remedy || "";
  } else {
    errorCard.classList.add("hidden");
    statusHero.classList.remove("hidden");
  }

  // Button states.
  const isRunning = state === "running";
  const isStarting = state === "starting";
  const isStopped = state === "stopped";
  const isCrashed = state === "crashed";
  // Start is allowed when stopped OR crashed (retry from error). Disabled
  // while starting/running/stopping so the user can't kick off a second
  // boot while the first is in flight.
  $("#start-btn").disabled = !isStopped && !isCrashed;
  // Stop is allowed whenever there's something to stop — including a
  // "starting" state, so the user can cancel a slow boot instead of being
  // forced to wait for the 30s port timeout.
  $("#stop-btn").disabled = !isRunning && !isStarting;
  $("#open-browser-btn").disabled = !isRunning;
  $("#server-restart-btn").disabled = !isRunning;

  // CDP controls.
  $("#cdp-start-btn").disabled = cdp.state === "running";
  $("#cdp-stop-btn").disabled = cdp.state !== "running";

  // If CDP is running, show a small banner so the user knows.
  if (cdp.state === "running") {
    $("#hero-meta").textContent += " · CDP automation browser active (background)";
  }

  // About tab — runtime info.
  $("#about-runtime").textContent = server.nodeRuntime || "—";
}

async function refreshStatus() {
  try {
    const status = await window.gtss.lifecycle.status();
    updateHero(status.server, status.cdp);
  } catch (err) {
    console.error("Status refresh failed:", err);
  }
}

setInterval(refreshStatus, 1500);
refreshStatus();
