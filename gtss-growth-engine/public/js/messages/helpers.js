/**
 * messages/helpers.js — Pure helpers + platform-filter loader for the
 * Message Generator page.
 *
 * Exposes (via global scope):
 *   - platformLabel(platform)         — display label for a platform key
 *   - platformClass(platform)         — CSS class for a platform badge
 *   - scoreColorClass(score)          — CSS class for a lead-score badge
 *   - truncate(text, len)             — short text preview with ellipsis
 *   - escapeHtml(str)                 — HTML-escape via textContent roundtrip
 *   - relativeTime(dateStr)           — humanized "5m ago" / "3d ago" string
 *   - getCharLimitForPlatform(p)      — per-platform DM/connect char limit
 *   - loadPlatformFilterOptions()     — async loader that populates the
 *                                        #platform-filter <select> from the
 *                                        platform catalog exposed by app.js
 *
 * Depends on (from messages/state.js, loaded earlier):
 *   - platformLabels, platformCatalog, defaultPlatform, charLimits,
 *     platformFilter
 * Depends on (from window.gtss, set up in state.js):
 *   - loadPlatformCatalog, formatPlatformLabel
 */

function platformLabel(p) {
  return platformLabels[p] || window.gtss.formatPlatformLabel(p) || p || "—";
}

function platformClass(p) {
  return `platform-${(p || "").toLowerCase()}`;
}

function scoreColorClass(score) {
  if (score == null) return "";
  if (score < 40) return "score-red";
  if (score < 70) return "score-amber";
  return "score-green";
}

function truncate(text, len) {
  if (!text) return "—";
  return text.length > len ? text.slice(0, len) + "…" : text;
}

function escapeHtml(str) {
  const el = document.createElement("span");
  el.textContent = str || "";
  return el.innerHTML;
}

function relativeTime(dateStr) {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function getCharLimitForPlatform(platform) {
  if (platform === "x") return 500;
  // Determine the key based on platform
  const connectKey = `${platform}_connect`;
  const dmKey = `${platform}_dm`;
  return charLimits[connectKey] || charLimits[dmKey] || 1000;
}

/**
 * Badge for how a message was produced. AI (API/Web) is what Automation
 * will send; template / template-fallback is emergency-only unless the
 * founder explicitly approves it with no AI alternative.
 */
function sourceBadgeHtml(generatedBy) {
  const key = String(generatedBy || "").toLowerCase();
  if (key === "ai" || key === "ai-web") {
    const label = key === "ai-web" ? "AI · Web" : "AI · API";
    return `<span class="source-badge source-ai" title="Gemini-generated — preferred for DM send">${label}</span>`;
  }
  if (key === "template-fallback") {
    return `<span class="source-badge source-fallback" title="Emergency template — only sent if founder approves and no AI body exists">Template fallback</span>`;
  }
  if (key === "template") {
    return `<span class="source-badge source-template" title="Canonical template">Template</span>`;
  }
  return "";
}

async function loadPlatformFilterOptions() {
  platformCatalog = await window.gtss.loadPlatformCatalog();
  platformLabels = Object.fromEntries(
    platformCatalog.map((platform) => [platform.key, platform.label]),
  );
  defaultPlatform = platformCatalog[0]?.key || "";

  if (!platformFilter) {
    return;
  }

  const currentValue = platformFilter.value;
  platformFilter.innerHTML = [
    '<option value="">All Platforms</option>',
    ...platformCatalog.map(
      (platform) =>
        `<option value="${platform.key}">${escapeHtml(platform.label || window.gtss.formatPlatformLabel(platform.key))}</option>`,
    ),
  ].join("");

  if (currentValue) {
    platformFilter.value = currentValue;
  }
}
