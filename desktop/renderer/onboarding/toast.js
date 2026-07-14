/**
 * onboarding/toast.js — Lightweight toast notifications.
 *
 * toast(message, kind, durationMs) — creates a styled toast element
 * (info / success / warning / error) inside a #toast-container (which
 * is created on first call if missing). Auto-dismisses after
 * durationMs (default 4000) with a 300ms fade-out.
 *
 * Used throughout the wizard: passphrase validation errors, Gemini
 * key validation errors, finish/start failure messages, restart-Chrome
 * status, etc. Kept as its own split file because every other split
 * file references it by bare name.
 *
 * Cross-file dependencies: none.
 */

function toast(message, kind = "info", durationMs = 4000) {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 0.3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, durationMs);
}
