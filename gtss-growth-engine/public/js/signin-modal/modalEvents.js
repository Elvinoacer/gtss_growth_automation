/**
 * signin-modal/modalEvents.js — Modal button + backdrop click handlers.
 *
 * wireModalEvents is called once on first modal creation by ensureModal.
 *
 * Original signin-modal.js was 656 lines; this is one of its thematic splits.
 */

"use strict";

// ─── Events ────────────────────────────────────────────────────────────

function wireModalEvents() {
  modalEl.querySelector(".gtss-signin-close").addEventListener("click", () => {
    modalDismissed = true;
    hideModal();
  });
  modalEl.querySelector("#gtss-signin-later").addEventListener("click", () => {
    modalDismissed = true;
    hideModal();
  });
  modalEl.querySelector("#gtss-signin-done").addEventListener("click", async () => {
    // Mark sign-in complete so the launcher's next Start uses the
    // normal (background) flow instead of the first-time visible flow.
    if (bridgeBase) {
      try {
        await bridgeFetch("/api/bridge/signin/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      } catch (_) {
        // Non-fatal — the user can still dismiss the modal.
      }
    }
    signinCompleted = true;
    hideModal();
    showToast("All set! Future Starts will run Chrome in the background. You can change this in Settings.", "success");
  });
  modalEl.querySelector("#gtss-signin-refresh").addEventListener("click", () => {
    pollOnce();
  });
  // Click on the backdrop (outside the modal) closes it.
  modalEl.addEventListener("click", (e) => {
    if (e.target === modalEl) {
      modalDismissed = true;
      hideModal();
    }
  });
}
