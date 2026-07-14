/**
 * campaign-detail/renderTables.js — Connection & DM job table renderers plus
 * the shared pagination renderer.
 *
 * Original campaign-detail.js was 684 lines; this is one of its thematic
 * splits.
 */

"use strict";

// Connection Tables Rows Renderer
function renderConnectionJobs(jobs) {
  connectionsTableBody.innerHTML = "";
  if (jobs.length === 0) {
    connEmpty.classList.remove("hidden");
    connEmpty.classList.add("flex");
    return;
  }
  connEmpty.classList.add("hidden");
  connEmpty.classList.remove("flex");

  jobs.forEach((job) => {
    const leadName = escapeHtml(job.lead_name || "Unknown");
    const platformHandle = escapeHtml(job.profile_url || job.x_handle || "-");
    const statusClass = getJobStatusBadgeClass(job.status);
    const updatedStr = new Date(job.updated_at).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });

    const errorText = job.error_message
      ? `<div class="text-[10px] text-error font-medium mt-0.5 line-clamp-1 max-w-[200px]" title="${escapeHtml(job.error_message)}">${escapeHtml(job.error_message)}</div>`
      : "";

    const row = `
      <tr class="border-b border-outline-variant/40 hover:bg-surface-variant/10 transition-colors">
        <td class="py-3 px-3 font-semibold text-on-surface align-middle">${leadName}</td>
        <td class="py-3 px-3 text-on-surface-variant font-mono-code text-xs max-w-[200px] truncate align-middle" title="${platformHandle}">${platformHandle}</td>
        <td class="py-3 px-3 align-middle">
          <span class="rounded-full px-2 py-0.5 text-[11px] font-bold inline-block capitalize ${statusClass}">
            ${escapeHtml(job.status)}
          </span>
          ${errorText}
        </td>
        <td class="py-3 px-3 text-on-surface-variant font-bold align-middle">${job.retry_count} / 3</td>
        <td class="py-3 px-3 text-on-surface-variant text-right align-middle">${updatedStr}</td>
      </tr>
    `;

    connectionsTableBody.insertAdjacentHTML("beforeend", row);
  });
}

// DM Tables Rows Renderer
function renderDmJobs(jobs) {
  dmsTableBody.innerHTML = "";
  if (jobs.length === 0) {
    dmsEmpty.classList.remove("hidden");
    dmsEmpty.classList.add("flex");
    return;
  }
  dmsEmpty.classList.add("hidden");
  dmsEmpty.classList.remove("flex");

  jobs.forEach((job) => {
    const leadName = escapeHtml(job.lead_name || "Unknown");
    const platformHandle = escapeHtml(job.profile_url || job.x_handle || "-");
    const statusClass = getJobStatusBadgeClass(job.status);

    const timeVal = job.sent_at || job.scheduled_at;
    const timeStr = timeVal
      ? new Date(timeVal).toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        })
      : "-";

    const errorText = job.error_message
      ? `<div class="text-[10px] text-error font-medium mt-0.5 line-clamp-1 max-w-[200px]" title="${escapeHtml(job.error_message)}">${escapeHtml(job.error_message)}</div>`
      : "";

    const row = `
      <tr class="border-b border-outline-variant/40 hover:bg-surface-variant/10 transition-colors">
        <td class="py-3 px-3 font-semibold text-on-surface align-middle">${leadName}</td>
        <td class="py-3 px-3 text-on-surface-variant font-mono-code text-xs max-w-[200px] truncate align-middle" title="${platformHandle}">${platformHandle}</td>
        <td class="py-3 px-3 align-middle">
          <span class="rounded-full px-2 py-0.5 text-[11px] font-bold inline-block capitalize ${statusClass}">
            ${escapeHtml(job.status)}
          </span>
          ${errorText}
        </td>
        <td class="py-3 px-3 text-on-surface-variant font-bold align-middle">${job.retry_count} / 3</td>
        <td class="py-3 px-3 text-on-surface-variant text-right align-middle">${timeStr}</td>
      </tr>
    `;

    dmsTableBody.insertAdjacentHTML("beforeend", row);
  });
}

// Tab Table Pagination controllers Renderer
function renderTablePagination(pag, type) {
  const info = document.getElementById(`${type}-pag-info`);
  const prev = document.getElementById(`${type}-prev-btn`);
  const next = document.getElementById(`${type}-next-btn`);

  info.textContent = `Page ${pag.page} of ${pag.pages || 1} (Total ${pag.total} jobs)`;
  prev.disabled = pag.page <= 1;
  next.disabled = pag.page >= pag.pages;
}
