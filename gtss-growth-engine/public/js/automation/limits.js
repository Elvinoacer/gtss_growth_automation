/* global gtss */
/**
 * automation/limits.js — Daily-action limit cards + per-platform session
 * status for the Automation Control page.
 *
 * Pulled verbatim from the original automation.js IIFE (lines 166-281 for
 * the loaders/renderers; lines 835-851 for the save-limit-btn click
 * binding; lines 898-918 for the auth-btn click binding). All three
 * concerns (session status, limit cards, auth) live here because they
 * share the per-platform state (`sessionStatus`, `cachedLimits`) and the
 * same UI surface (the limit-cards grid).
 *
 * Exposes (via global scope):
 *   - loadSessionStatus() — GET /api/sessions/status, updates
 *     `sessionStatus`, re-renders limit cards if already loaded
 *   - loadLimits() — GET /api/automation/limits, caches + renders cards
 *   - renderLimitCards(limitsObj) — rebuilds the `.limit-cards` grid with
 *     per-platform used/limit, status badge (Active/Expired), auth button,
 *     and inline DM-limit input + Save button
 *
 * Top-level bindings (registered at script-load time):
 *   - limitCards "click" on .save-limit-btn → PATCH
 *     /api/automation/limits with the new DM-limit value
 *   - limitCards "click" on .auth-btn → POST /api/sessions/authenticate/:platform
 *     (opens browser for manual login, then refreshes session status)
 */

// ----------------------------------------------------------------
// Session Status
// ----------------------------------------------------------------

async function loadSessionStatus() {
  try {
    const data = await fetchJSON("/api/sessions/status");
    sessionStatus = data || {};
    // If limits are already loaded, re-render cards so badges update live
    if (cachedLimits) {
      renderLimitCards(cachedLimits);
    }
  } catch (err) {
    console.error("Failed to load session status", err);
  }
}

// ----------------------------------------------------------------
// Load Limits
// ----------------------------------------------------------------

async function loadLimits() {
  try {
    const data = await fetchJSON("/api/automation/limits");
    cachedLimits = data;
    renderLimitCards(data);
  } catch (err) {
    console.error("Failed to load limits", err);
  }
}

function renderLimitCards(limitsObj) {
  if (!limitCards) return;

  limitCards.innerHTML = "";
  const icons = {
    linkedin: "work",
    x: "tag",
    facebook: "groups",
    instagram: "photo_camera",
  };

  const colors = {
    linkedin: "primary-container",
    x: "on-surface",
    facebook: "secondary",
    instagram: "tertiary",
  };

  for (const [platform, counts] of Object.entries(limitsObj)) {
    const icon = icons[platform] || "web";
    const bgClass = colors[platform] || "primary";
    const pct =
      counts.limit > 0
        ? Math.min(100, Math.round((counts.used / counts.limit) * 100))
        : 0;

    const isActive = !!sessionStatus[platform];

    // Status badge next to the platform name
    const statusBadge = isActive
      ? `<span class="inline-flex items-center gap-1 text-[11px] font-semibold text-green-500">
            <span class="w-1.5 h-1.5 rounded-full bg-green-500 inline-block"></span>
            Active
          </span>`
      : `<span class="inline-flex items-center gap-1 text-[11px] font-semibold text-error">
            <span class="w-1.5 h-1.5 rounded-full bg-error inline-block"></span>
            Expired
          </span>`;

    // Subtle red border for expired sessions
    const borderClass = isActive
      ? "border-outline-variant"
      : "border-error/30";

    // Auth control: small icon for active, prominent Login button for expired
    const authControl = isActive
      ? `<button class="auth-btn p-1 rounded text-outline hover:text-primary hover:bg-surface-variant/50 transition-colors" data-platform="${platform}" title="Re-authenticate ${platform}" type="button">
            <span class="material-symbols-outlined text-base">login</span>
          </button>`
      : `<button class="auth-btn inline-flex items-center gap-1 rounded bg-error/15 border border-error/50 px-2 py-0.5 text-[11px] font-bold text-error hover:bg-error/25 transition-colors" data-platform="${platform}" title="Authenticate ${platform}" type="button">
            <span class="material-symbols-outlined text-[14px]">login</span>
            Login
          </button>`;

    const card = `
      <div class="bg-surface-container-lowest border ${borderClass} shadow-sm rounded-lg p-4 flex flex-col justify-between min-h-32 relative overflow-hidden">
        <div class="flex justify-between items-start gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <span class="font-label-caps text-label-caps text-on-surface-variant capitalize truncate">${platform}</span>
            ${statusBadge}
          </div>
          <div class="flex items-center gap-1 shrink-0">
            ${authControl}
            <span class="material-symbols-outlined text-${bgClass} text-lg">${icon}</span>
          </div>
        </div>
        <div class="mt-2">
          <div class="text-on-surface flex items-baseline gap-1" style="font-size:20px;font-weight:700;line-height:1.25">
              ${counts.used} <span class="text-[12px] text-on-surface-variant font-normal">/ ${counts.limit}</span>
          </div>
          <div class="w-full h-1.5 bg-surface-container-high rounded-full mt-2 overflow-hidden">
              <div class="h-full bg-${bgClass} rounded-full transition-all" style="width: ${pct}%"></div>
          </div>
        </div>
        <div class="mt-2 flex items-center gap-2 text-[11px] text-on-surface-variant">
          <label class="flex items-center gap-1">DM limit
            <input class="automation-limit-input w-14 rounded border border-outline-variant bg-surface px-2 py-0.5 text-on-surface" data-limit-platform="${platform}" data-limit-action="dms" type="number" min="1" max="1000" value="${counts.dmsLimit || 1}" />
          </label>
          <button class="save-limit-btn rounded border border-outline-variant px-2 py-0.5 hover:border-primary hover:text-primary" data-platform="${platform}" type="button">Save</button>
        </div>
      </div>
    `;
    limitCards.insertAdjacentHTML("beforeend", card);
  }
}

// ----------------------------------------------------------------
// Save-limit-btn click binding (PATCH /api/automation/limits)
// ----------------------------------------------------------------

limitCards?.addEventListener("click", async (e) => {
  const saveBtn = e.target.closest(".save-limit-btn");
  if (!saveBtn) return;
  const platform = saveBtn.dataset.platform;
  const input = document.querySelector(`[data-limit-platform="${platform}"][data-limit-action="dms"]`);
  try {
    await fetchJSON("/api/automation/limits", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [platform]: { dms: Number(input.value) } }),
    });
    showToast(`${platform} DM limit saved`, "success");
    await loadLimits();
  } catch (err) {
    showToast(err.message, "error");
  }
});

// ----------------------------------------------------------------
// Auth-btn click binding (POST /api/sessions/authenticate/:platform)
// ----------------------------------------------------------------

limitCards.addEventListener("click", async (e) => {
  const authBtn = e.target.closest(".auth-btn");
  if (!authBtn) return;

  const platform = authBtn.dataset.platform;
  showToast(`Opening browser to authenticate ${platform}...`, "info");
  appendLog("info", `Manual authentication requested for ${platform}`);

  try {
    await fetchJSON(`/api/sessions/authenticate/${platform}`, {
      method: "POST",
    });
    showToast(`${platform} authenticated successfully!`, "success");
    appendLog("done", `${platform} authenticated`);
    // Refresh session status — re-renders limit cards with updated badge
    await loadSessionStatus();
  } catch (err) {
    showToast(`Auth failed: ${err.message}`, "error");
    appendLog("error", `Auth failed: ${err.message}`);
  }
});
