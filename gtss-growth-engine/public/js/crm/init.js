/**
 * crm/init.js — Boot function and the DOMContentLoaded-aware init() call.
 *
 * init() wires events, populates the platform-filter dropdown, loads stats +
 * leads in parallel, and sets up drag-and-drop.
 *
 * Original crm.js was 578 lines; this is one of its thematic splits. The
 * original wrapped everything in a single DOMContentLoaded callback; this
 * preserves that behavior via the readyState check (DOMContentLoaded if still
 * loading, otherwise immediate — handles the case where the script is loaded
 * after DOMContentLoaded has already fired).
 */

"use strict";

async function init() {
  bindEvents();
  await loadPlatformFilterOptions();
  await Promise.all([loadStats(), loadLeads()]);
  setupDragAndDrop();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
