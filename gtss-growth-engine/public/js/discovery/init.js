/**
 * discovery/init.js — Launch-time boot sequence for the Discovery page.
 * Loaded LAST (after every other split file) so all referenced functions
 * are guaranteed to exist.
 *
 * Registers a single DOMContentLoaded handler that runs the boot calls in
 * order:
 *   1. loadPlatformControls()       — render the platform checkbox row +
 *      the #platform-filter <select>
 *   2. loadDiscoveryConfig()        — restore the saved max-leads value
 *   3. loadKeywordSelector()        — render the pipeline-keyword filter
 *      panel (best-effort — .catch(() => {}) so a missing catalog doesn't
 *      break the rest of the page)
 *   4. bindEvents()                 — wire all DOM event listeners (must
 *      come AFTER loadPlatformControls so the platform checkboxes exist)
 *   5. loadResults()                — first page of discovered leads
 *      (best-effort)
 *   6. loadHistory()                — refresh the history table (best-
 *      effort)
 *   7. resumeActiveDiscovery()      — reattach to a running discovery
 *      job, if any
 *
 * Depends on (from discovery/platformControls.js, loaded earlier):
 *   - loadPlatformControls
 * Depends on (from discovery/discoveryConfig.js, loaded earlier):
 *   - loadDiscoveryConfig
 * Depends on (from discovery/keywordSelector.js, loaded earlier):
 *   - loadKeywordSelector
 * Depends on (from discovery/events.js, loaded earlier):
 *   - bindEvents
 * Depends on (from discovery/results.js, loaded earlier):
 *   - loadResults
 * Depends on (from discovery/history.js, loaded earlier):
 *   - loadHistory
 * Depends on (from discovery/discoveryStream.js, loaded earlier):
 *   - resumeActiveDiscovery
 * Depends on (from window.gtss, available via app.js):
 *   - showToast
 */

document.addEventListener("DOMContentLoaded", async () => {
  await loadPlatformControls();
  await loadDiscoveryConfig();
  await loadKeywordSelector().catch(() => {});
  bindEvents();
  loadResults().catch((error) => window.gtss.showToast(error.message, "error"));
  loadHistory().catch((error) => window.gtss.showToast(error.message, "error"));
  resumeActiveDiscovery();
});
