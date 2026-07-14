/* global gtss */
/**
 * scheduler/init.js — Boot orchestrator for the Content Scheduler page.
 *
 * Defines:
 *   - bindEvents() — calls the four thematic bind* functions in order
 *     (bindComposer, bindPostActions, bindNavigation, bindEditModal).
 *   - init() — async boot: bindEvents → loadSchedulerContext → loadPauseState
 *     → refreshSchedulerViews, then start a 60s polling interval.
 *
 * Wires `DOMContentLoaded` to a callback that:
 *   1. Pre-fills scheduleDate / scheduleTime with the next rounded hour.
 *   2. Calls init().
 *
 * This preserves the exact timing of the original scheduler.js (which
 * wrapped its entire body in a single DOMContentLoaded callback). Because
 * the <script src="/js/scheduler.js"> tag lives at the END of
 * public/pages/content-scheduler.html, every DOM element is already
 * parsed by the time DOMContentLoaded fires — but using the DOMContentLoaded
 * event keeps the relative ordering with app.js's own DOMContentLoaded
 * listener (initShell) intact.
 */

function bindEvents() {
  bindComposer();
  bindPostActions();
  bindNavigation();
  bindEditModal();
}

async function init() {
  bindEvents();
  await loadSchedulerContext();
  await loadPauseState();
  await refreshSchedulerViews();

  setInterval(() => {
    refreshSchedulerViews();
  }, 60_000);
}

document.addEventListener("DOMContentLoaded", () => {
  // Set default schedule to next rounded hour
  const now = new Date();
  now.setHours(now.getHours() + 1, 0, 0, 0);
  scheduleDate.value = formatLocalDateInput(now);
  scheduleTime.value = now.toTimeString().slice(0, 5);

  init();
});
