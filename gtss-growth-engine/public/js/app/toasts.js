/**
 * toasts.js — Toast notifications
 *
 * showToast(message, type, duration) — creates a styled toast element with
 *   an icon, message, progress bar, and close button. Stacks vertically via
 *   relayoutToasts(). Auto-dismisses after `duration` ms; click anywhere on
 *   the toast to dismiss early.
 * relayoutToasts() — repositions all visible + fading-out toasts so they
 *   stack without overlapping. Called by showToast() and on toast dismissal.
 */

function showToast(message, type = "info", duration = 4000) {
  // Pick an icon per type so the user gets an immediate visual signal of
  // severity without having to read the message. This is especially
  // helpful for error toasts that may stack up after a failed action.
  const icons = {
    success: "✓",
    error: "✕",
    warning: "⚠",
    warn: "⚠",
    info: "ℹ",
  };
  const icon = icons[type] || icons.info;

  const toast = document.createElement("div");
  toast.className = `gtss-toast ${type}`;
  // Sync the progress-bar animation with the actual duration so the bar
  // doesn't finish early on long-lived error toasts (the previous default
  // was a fixed 4000ms regardless of the `duration` argument).
  toast.style.setProperty("--toast-duration", `${duration}ms`);
  toast.innerHTML = `
    <span class="gtss-toast__icon" aria-hidden="true">${icon}</span>
    <span class="gtss-toast__msg">${escapeHtml(message)}</span>
    <span class="toast-progress" aria-hidden="true"></span>
    <button class="gtss-toast__close" type="button" aria-label="Dismiss notification">✕</button>
  `;
  document.body.appendChild(toast);

  // Stack: nudge this toast above any others currently visible so multiple
  // toasts don't overlap into an unreadable blob.
  relayoutToasts();

  // Click anywhere on the toast (or the explicit close button) dismisses
  // it early — important for long-lived error toasts.
  const dismiss = () => {
    toast.classList.remove("visible");
    window.setTimeout(() => {
      toast.remove();
      relayoutToasts();
    }, 220);
  };
  toast.addEventListener("click", (e) => {
    // Avoid double-handling when the close button is the click target.
    if (e.target.closest(".gtss-toast__close")) return;
    dismiss();
  });
  toast.querySelector(".gtss-toast__close").addEventListener("click", dismiss);

  requestAnimationFrame(() => toast.classList.add("visible"));
  window.setTimeout(dismiss, duration);
}

/**
 * Re-position all visible toasts so they stack vertically without
 * overlapping. Called whenever a toast is added or removed.
 */
function relayoutToasts() {
  const toasts = Array.from(document.querySelectorAll(".gtss-toast.visible"));
  // Also include toasts that are mid-removal so a freshly-added toast
  // doesn't briefly overlap one that's fading out.
  const all = Array.from(document.querySelectorAll(".gtss-toast"));
  let offset = 0;
  all.forEach((t) => {
    t.style.setProperty("--toast-stack-offset", `${offset}px`);
    offset += t.offsetHeight + 12;
  });
}
