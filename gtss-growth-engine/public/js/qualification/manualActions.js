/**
 * qualification/manualActions.js — Small helpers for the manual-actions
 * dropdown menu on the Lead Qualification page.
 *
 * The dropdown lives in the toolbar next to "Run All" and groups the less
 * common bulk actions (Qualify All Manually / Qualify Selected / Retry
 * Failed). These two helpers open/close the dropdown; the click-outside
 * listener that calls `closeManualActionsMenu` is wired in events.js.
 *
 * Exposes (via global scope):
 *   - closeManualActionsMenu()    — hide the dropdown
 *   - toggleManualActionsMenu()   — toggle the dropdown visibility
 *
 * Depends on (from qualification/state.js, loaded earlier):
 *   - manualActionsDropdown
 */

function closeManualActionsMenu() {
  if (manualActionsDropdown) {
    manualActionsDropdown.hidden = true;
  }
}

function toggleManualActionsMenu() {
  if (!manualActionsDropdown) return;
  manualActionsDropdown.hidden = !manualActionsDropdown.hidden;
}
