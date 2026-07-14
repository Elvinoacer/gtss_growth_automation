/**
 * dashboard/events.js — Top-level dashboard event wiring.
 *
 * bindEvents() — wires three independent interactions:
 *   1. Export dropdown toggle (click the export button → toggle the
 *      dropdown; click outside → close).
 *   2. Funnel chart toggle ("All Platforms" vs "By Platform"). The
 *      active toggle gets the sky-400 pill style; the inactive gets
 *      the ghost-hover style. Re-renders from the cached statsData
 *      (no re-fetch).
 *   3. Refresh-actions button — re-fetches /api/dashboard/stats and
 *      refreshes ONLY the daily-actions panel (not the whole page),
 *      toasts success/failure.
 *
 * Called from init() on DOMContentLoaded.
 *
 * Cross-file dependencies (call-time only): $ (state.js), statsData
 * (state.js — read-only), renderFunnelChart, renderFunnelByPlatform
 * (renderFunnel.js), renderActions (renderActions.js), fetchJSON,
 * showToast (state.js).
 */

// ── Event Binding ──
function bindEvents() {
  const activeToggleClass =
    "focus-ring rounded-full bg-sky-400 px-4 py-2 text-xs font-semibold text-slate-950 shadow-sm";
  const inactiveToggleClass =
    "focus-ring rounded-full px-4 py-2 text-xs font-semibold text-slate-200 transition-colors hover:bg-white/10";

  // Export dropdown
  const exportBtn = $("export-btn");
  const exportDropdown = $("export-dropdown");
  exportBtn.addEventListener("click", () =>
    exportDropdown.classList.toggle("hidden"),
  );
  document.addEventListener("click", (e) => {
    if (!exportBtn.contains(e.target) && !exportDropdown.contains(e.target)) {
      exportDropdown.classList.add("hidden");
    }
  });

  // Funnel toggle
  $("funnel-all-btn").addEventListener("click", () => {
    if (!statsData) return;
    $("funnel-all-btn").className = activeToggleClass;
    $("funnel-platform-btn").className = inactiveToggleClass;
    renderFunnelChart(statsData.funnel);
  });
  $("funnel-platform-btn").addEventListener("click", () => {
    if (!statsData) return;
    $("funnel-platform-btn").className = activeToggleClass;
    $("funnel-all-btn").className = inactiveToggleClass;
    renderFunnelByPlatform(statsData.funnelByPlatform);
  });

  // Refresh actions
  $("refresh-actions-btn").addEventListener("click", async () => {
    try {
      const data = await fetchJSON("/api/dashboard/stats");
      renderActions(data.dailyActions);
      showToast("Actions refreshed", "success");
    } catch (e) {
      showToast(e.message, "error");
    }
  });
}
