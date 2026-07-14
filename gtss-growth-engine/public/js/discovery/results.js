/**
 * discovery/results.js — Discovered-leads results table: query builder,
 * loader, renderer, pagination, and bulk-selection bar.
 *
 * Exposes (via global scope):
 *   - buildResultQuery()   — compose URLSearchParams from the current
 *                            page/limit + filter inputs (platform-filter,
 *                            keyword-filter, date-from-filter, date-to-
 *                            filter)
 *   - loadResults()        — async; GET /api/discovery/results?<query>,
 *                            refresh discoveryState.total, clear
 *                            selectedIds, and re-render the table +
 *                            pagination + bulk bar
 *   - renderResults(leads) — build the <tr> rows for a list of discovered
 *                            leads (checkbox + name + role + company +
 *                            location + platform badge + profile URL +
 *                            discovered date + Add-to-Queue/Dismiss
 *                            buttons)
 *   - renderPagination()   — update the page-label + prev/next disabled
 *                            state from discoveryState.total / .page /
 *                            .limit
 *   - updateBulkBar()      — toggle the bulk-action bar visibility based
 *                            on the size of discoveryState.selectedIds
 *
 * Depends on (from discovery/state.js, loaded earlier):
 *   - discoveryState
 * Depends on (from discovery/helpers.js, loaded earlier):
 *   - escapeHtml, platformBadge, formatDate
 */

function buildResultQuery() {
  const params = new URLSearchParams({
    page: String(discoveryState.page),
    limit: String(discoveryState.limit),
  });
  const platform = document.getElementById("platform-filter").value;
  const keyword = document.getElementById("keyword-filter").value.trim();
  const dateFrom = document.getElementById("date-from-filter").value;
  const dateTo = document.getElementById("date-to-filter").value;

  if (platform) params.set("platform", platform);
  if (keyword) params.set("keyword", keyword);
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);

  return params.toString();
}

async function loadResults() {
  const data = await window.gtss.fetchJSON(
    `/api/discovery/results?${buildResultQuery()}`,
  );
  discoveryState.total = data.total;
  discoveryState.selectedIds.clear();
  renderResults(data.leads || []);
  renderPagination();
  updateBulkBar();
}

function renderResults(leads) {
  const tbody = document.getElementById("results-body");
  const empty = document.getElementById("empty-state");
  document.getElementById("total-count").textContent = String(
    discoveryState.total,
  );
  document.getElementById("select-all").checked = false;

  if (leads.length === 0) {
    tbody.innerHTML = "";
    empty.classList.add("visible");
    return;
  }

  empty.classList.remove("visible");
  tbody.innerHTML = leads
    .map((lead) => {
      const profileUrl = escapeHtml(lead.profile_url);
      return `
      <tr data-lead-row="${lead.id}">
        <td><input class="lead-select" type="checkbox" value="${lead.id}" aria-label="Select ${escapeHtml(lead.name || "lead")}"></td>
        <td>${escapeHtml(lead.name || "Unknown")}</td>
        <td>${escapeHtml(lead.role || "")}</td>
        <td>${escapeHtml(lead.company || "")}</td>
        <td>${escapeHtml(lead.location || "")}</td>
        <td>${platformBadge(lead.platform)}</td>
        <td><a class="url-link" href="${profileUrl}" target="_blank" rel="noreferrer">${profileUrl}</a> Open ↗</td>
        <td>${formatDate(lead.created_at)}</td>
        <td>
          <div class="row-actions">
            <button class="row-button" data-action="queue" data-id="${lead.id}" type="button">Add to Queue</button>
            <button class="row-button danger" data-action="dismiss" data-id="${lead.id}" type="button">Dismiss</button>
          </div>
        </td>
      </tr>
    `;
    })
    .join("");
}

function renderPagination() {
  const totalPages = Math.max(
    Math.ceil(discoveryState.total / discoveryState.limit),
    1,
  );
  document.getElementById("page-label").textContent =
    `Page ${discoveryState.page} of ${totalPages}`;
  document.getElementById("prev-page").disabled = discoveryState.page <= 1;
  document.getElementById("next-page").disabled =
    discoveryState.page >= totalPages;
}

function updateBulkBar() {
  const count = discoveryState.selectedIds.size;
  document.getElementById("bulk-bar").classList.toggle("visible", count > 0);
  document.getElementById("bulk-count").textContent = `${count} selected`;
  document.getElementById("bulk-qualify").textContent =
    `Qualify Selected (${count})`;
}
