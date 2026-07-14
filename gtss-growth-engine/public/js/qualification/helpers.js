/**
 * qualification/helpers.js — Pure UI helpers for the Lead Qualification
 * page.
 *
 * Exposes (via global scope):
 *   - platformLabel(platform) — display label for a platform key
 *   - platformClass(platform) — CSS class for a platform badge
 *   - scoreColorClass(score)  — CSS class for a lead-score badge
 *   - statusClass(status)     — CSS class for a status pill
 *   - truncate(text, len)     — short text preview with ellipsis
 *   - escapeHtml(str)         — HTML-escape via textContent roundtrip
 *
 * Depends on (from window.gtss, set up in qualification/state.js):
 *   - formatPlatformLabel
 */

function platformLabel(platform) {
  return window.gtss.formatPlatformLabel(platform) || platform || "—";
}

function platformClass(platform) {
  return `platform-${(platform || "").toLowerCase()}`;
}

function scoreColorClass(score) {
  if (score == null) return "";
  if (score < 40) return "score-red";
  if (score < 70) return "score-amber";
  return "score-green";
}

function statusClass(status) {
  return `status-${(status || "discovered").toLowerCase()}`;
}

function truncate(text, len) {
  if (!text) return "—";
  return text.length > len ? text.slice(0, len) + "..." : text;
}

function escapeHtml(str) {
  const el = document.createElement("span");
  el.textContent = str || "";
  return el.innerHTML;
}
