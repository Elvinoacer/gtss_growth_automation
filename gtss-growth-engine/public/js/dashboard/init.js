/**
 * dashboard/init.js — Dashboard boot.
 *
 * Loaded LAST. Provides:
 *   - init() — the async boot sequence: bindEvents →
 *     initQuickStartDismissal → await loadStats → initSocketListeners.
 *     Same order as the original dashboard.js (which called init()
 *     inside its DOMContentLoaded callback).
 *   - document.addEventListener("DOMContentLoaded", init) — registers
 *     the boot callback. The DOMContentLoaded event fires AFTER every
 *     split file has been parsed and evaluated (because the dashboard.js
 *     loader's document.write'd scripts run synchronously during page
 *     parse, before DOMContentLoaded), so every function init() calls
 *     is guaranteed to exist as a global property by the time init()
 *     actually runs.
 *
 * Cross-file dependencies (call-time only): bindEvents (events.js),
 * initQuickStartDismissal (quickStart.js), loadStats (loadStats.js),
 * initSocketListeners (socketListeners.js).
 */

async function init() {
  bindEvents();
  initQuickStartDismissal();
  await loadStats();
  initSocketListeners();
}

document.addEventListener("DOMContentLoaded", init);
