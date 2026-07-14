/**
 * Show a styled, Promise-based confirmation dialog and resolve with the
 * user's choice (true = confirmed, false = cancelled).
 *
 * This replaces the jarring native `confirm()` calls used across the
 * pipeline page (Stop / Restart / Force-Clear). The native dialog blocks
 * the main thread, can't be styled, and gives no visual hierarchy for
 * destructive actions. This version:
 *   - matches the dark glassmorphism theme of the rest of the app
 *   - supports a title + multi-line body
 *   - supports a `danger` flag that turns the confirm button red
 *   - supports custom confirm/cancel labels
 *   - closes on Escape and on backdrop click (cancel)
 *   - auto-focuses the confirm button so Enter works immediately
 *
 * @param {object} opts
 * @param {string} opts.title - Short headline.
 * @param {string} opts.body  - Detailed explanation (may contain \n).
 * @param {string} [opts.confirmLabel='Confirm'] - Confirm button text.
 * @param {string} [opts.cancelLabel='Cancel']   - Cancel button text.
 * @param {boolean} [opts.danger=false]          - Red confirm button for destructive actions.
 * @param {string} [opts.icon]                   - Optional emoji icon shown next to the title.
 * @returns {Promise<boolean>}
 */
function showConfirmDialog({
  title,
  body = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  icon = "",
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "gtss-confirm-overlay gtss-confirm-overlay--dialog";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "gtss-dialog-title");

    const bodyHtml = escapeHtml(body).replace(/\n/g, "<br/>");

    overlay.innerHTML = `
      <div class="gtss-confirm-modal gtss-confirm-modal--dialog${danger ? " gtss-confirm-modal--danger" : ""}">
        <div class="gtss-confirm-modal__head">
          ${icon ? `<span class="gtss-confirm-modal__icon" aria-hidden="true">${icon}</span>` : ""}
          <h3 id="gtss-dialog-title" class="gtss-confirm-modal__title">${escapeHtml(title || "Please confirm")}</h3>
        </div>
        ${body ? `<div class="gtss-confirm-modal__body">${bodyHtml}</div>` : ""}
        <div class="gtss-confirm-modal__actions">
          <button type="button" class="gtss-btn gtss-btn--ghost gtss-confirm-cancel">${escapeHtml(cancelLabel)}</button>
          <button type="button" class="gtss-btn ${danger ? "gtss-btn--danger" : "gtss-btn--primary"} gtss-confirm-ok">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      overlay.classList.remove("visible");
      window.setTimeout(() => overlay.remove(), 180);
      resolve(val);
    };

    // Animate in.
    requestAnimationFrame(() => overlay.classList.add("visible"));

    const cancelBtn = overlay.querySelector(".gtss-confirm-cancel");
    const okBtn = overlay.querySelector(".gtss-confirm-ok");

    cancelBtn.addEventListener("click", () => finish(false));
    okBtn.addEventListener("click", () => finish(true));

    // Backdrop click = cancel.
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(false);
    });

    // Escape = cancel.
    const onKey = (e) => {
      if (e.key === "Escape") {
        finish(false);
        document.removeEventListener("keydown", onKey);
      } else if (e.key === "Enter") {
        finish(true);
        document.removeEventListener("keydown", onKey);
      }
    };
    document.addEventListener("keydown", onKey);

    // Auto-focus the confirm button so keyboard users can press Enter.
    requestAnimationFrame(() => okBtn.focus());
  });
}
