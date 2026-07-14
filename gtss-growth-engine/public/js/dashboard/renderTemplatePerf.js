/**
 * dashboard/renderTemplatePerf.js — Template A/B performance table.
 *
 * renderTemplatePerf(rows) — renders one row per (platform, template
 * variant) showing sent / replied / acceptance-rate. Sorted by the
 * backend. Empty-state row spanning all 5 columns when there's no
 * template data yet.
 *
 * Cross-file dependencies: $ (state.js).
 */

// ── Template Performance ──
function renderTemplatePerf(rows) {
  const body = $("template-perf-body");
  body.innerHTML = "";
  if (!rows || rows.length === 0) {
    body.innerHTML =
      '<tr><td colspan="5" class="px-4 py-6 text-center text-sm text-slate-300">No template data yet</td></tr>';
    return;
  }
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.className = "transition-colors hover:bg-white/5";
    tr.innerHTML = `
        <td class="px-4 py-3 text-sm capitalize text-slate-200">${r.platform}</td>
        <td class="px-4 py-3 text-sm text-slate-200">Variant ${r.templateName}</td>
        <td class="px-4 py-3 text-sm text-slate-200">${r.sent}</td>
        <td class="px-4 py-3 text-sm text-slate-200">${r.replied}</td>
        <td class="px-4 py-3 text-sm font-semibold text-emerald-300">${r.acceptanceRate}%</td>`;
    body.appendChild(tr);
  });
}
