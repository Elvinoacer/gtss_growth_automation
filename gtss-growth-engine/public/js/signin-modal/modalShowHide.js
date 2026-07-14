/**
 * signin-modal/modalShowHide.js — Modal visibility toggles.
 *
 * showModal creates the modal lazily, renders cards, and starts polling.
 * hideModal removes the visible class and stops polling after a 5-second
 * grace period so the sidebar dots catch up after dismiss.
 *
 * Original signin-modal.js was 656 lines; this is one of its thematic splits.
 */

"use strict";

// ─── Show / hide ───────────────────────────────────────────────────────

function showModal() {
  ensureModal();
  modalEl.classList.add("visible");
  modalEl.setAttribute("aria-hidden", "false");
  updateBridgeNote();
  renderGrid();
  updateDoneButton();
  pollOnce();
  startPolling();
}

function hideModal() {
  if (!modalEl) return;
  modalEl.classList.remove("visible");
  modalEl.setAttribute("aria-hidden", "true");
  // Keep polling briefly so the sidebar dots catch up after dismiss.
  setTimeout(stopPolling, 5000);
}
