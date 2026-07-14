/* global gtss */
/**
 * scheduler/pauseState.js — Scheduler pause toggle loader + UI sync.
 *
 * Pulled verbatim from the original scheduler.js DOMContentLoaded callback
 * (lines 579-607). Fetches /api/scheduler/pause and updates the toggle pill
 * + status label + banner.
 */

// ── Pause State ──

async function loadPauseState() {
  try {
    const data = await fetchJSON("/api/scheduler/pause");
    isPaused = data.paused;
    updatePauseUI();
  } catch {
    /* ignore */
  }
}

function updatePauseUI() {
  if (isPaused) {
    pauseToggle.classList.replace("bg-primary", "bg-gray-300");
    pauseToggleDot.style.right = "auto";
    pauseToggleDot.style.left = "4px";
    pauseBanner.classList.remove("hidden");
    pauseBanner.classList.add("flex");
    schedulerStatusLabel.textContent = "Paused";
  } else {
    pauseToggle.classList.replace("bg-gray-300", "bg-primary");
    pauseToggleDot.style.left = "auto";
    pauseToggleDot.style.right = "4px";
    pauseBanner.classList.add("hidden");
    pauseBanner.classList.remove("flex");
    schedulerStatusLabel.textContent = "Currently active";
  }
}
