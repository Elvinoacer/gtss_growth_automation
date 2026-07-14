/**
 * dashboard/renderActions.js — Daily-actions-per-platform progress bars.
 *
 * renderActions(da) — renders one progress-bar card per platform showing
 * today's used/limit ratio (emerald under 70%, amber 70-90%, rose 90%+),
 * plus a per-type breakdown line (connections / DMs / likes). Replaces
 * the panel's previous contents on every call.
 *
 * Cross-file dependencies: $ (state.js).
 */

// ── Daily Actions ──
function renderActions(da) {
  const panel = $("actions-panel");
  panel.innerHTML = "";
  Object.entries(da).forEach(([platform, data]) => {
    const pct =
      data.limit > 0 ? Math.round((data.used / data.limit) * 100) : 0;
    const barColor =
      pct >= 90
        ? "bg-rose-400"
        : pct >= 70
          ? "bg-amber-400"
          : "bg-emerald-400";
    const div = document.createElement("div");
    div.className =
      "flex flex-col gap-2 rounded-2xl border border-white/10 bg-slate-950/50 p-4";
    div.innerHTML = `
        <div class="flex items-center justify-between gap-3">
          <span class="text-sm font-semibold text-slate-100 capitalize">${platform}</span>
          <span class="text-xs text-slate-300">${data.used}/${data.limit}</span>
        </div>
        <div class="h-2 overflow-hidden rounded-full bg-slate-800" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(pct, 100)}" aria-label="${platform} daily action usage ${pct}%">
          <div class="${barColor} h-full rounded-full transition-all" style="width:${Math.min(pct, 100)}%"></div>
        </div>
        <div class="text-xs text-slate-300">${data.byType.connections} conn · ${data.byType.dms} DMs · ${data.byType.likes} likes</div>`;
    panel.appendChild(div);
  });
}
