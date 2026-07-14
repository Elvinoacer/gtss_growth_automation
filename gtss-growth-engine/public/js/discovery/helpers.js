/**
 * discovery/helpers.js — Pure UI helpers for the Discovery page.
 *
 * Exposes (via global scope):
 *   - platformBadge(platform)  — HTML string for a platform badge <span>
 *   - escapeHtml(value)         — HTML-escape via 5-character regex
 *                                  replacement (kept separate from
 *                                  other pages' escapeHtml — this is the
 *                                  Discovery page's own implementation,
 *                                  preserved verbatim from the original)
 *   - formatDate(value)         — localized short-date formatter
 *   - selectedPlatforms()       — array of currently-checked
 *                                  `input[name="platforms"]:checked`
 *                                  values (used by startDiscovery,
 *                                  rerun, etc.)
 *
 * Depends on (from discovery/state.js, loaded earlier):
 *   - platformLabels
 * Depends on (from window.gtss, available via app.js):
 *   - formatPlatformLabel
 */

function platformBadge(platform) {
  const label =
    platformLabels[platform] ||
    window.gtss.formatPlatformLabel(platform) ||
    platform;
  return `<span class="platform-badge platform-${platform}">${label}</span>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function selectedPlatforms() {
  return [...document.querySelectorAll('input[name="platforms"]:checked')].map(
    (input) => input.value,
  );
}
