/**
 * qualification/table.js — Lead table loader + renderer + pagination + bulk
 * selection bar for the Lead Qualification page.
 *
 * Exposes (via global scope):
 *   - sortQueryParam()    — maps the current sort dropdown value to the
 *                           API's sort query parameter
 *   - loadLeads()         — async; queries /api/qualification/leads with
 *                           the current filter / sort / pagination state,
 *                           caches the result in `cachedLeads`, and
 *                           re-renders the table + pagination + total
 *                           badge
 *   - renderTable(leads)  — builds the <tr> rows for a list of leads
 *                           (checkbox + name + platform + company +
 *                           location + score + reason + status + action
 *                           buttons)
 *   - renderPagination()  — updates the page-label + prev/next disabled
 *                           state from `totalLeads` / `currentPage`
 *   - updateBulkBar()     — toggles the bulk-action bar visibility based
 *                           on the size of `selectedIds`, and shows/hides
 *                           the manual-qualify-selected button
 *
 * Depends on (from qualification/state.js, loaded earlier):
 *   - fetchJSON, showToast, currentFilter, currentSort, currentPage,
 *     pageLimit, totalLeads, selectedIds, cachedLeads, leadsBody,
 *     emptyState, totalBadge, prevPage, nextPage, pageLabel, bulkBar,
 *     bulkCount, manualQualifySelectedBtn
 * Depends on (from qualification/helpers.js, loaded earlier):
 *   - escapeHtml, truncate, platformClass, platformLabel, scoreColorClass,
 *     statusClass
 */

function sortQueryParam() {
  const map = {
    score_desc: "score_desc",
    score_asc: "score_asc",
    name_asc: "name_asc",
    platform: "platform",
    date: "date",
  };
  return map[currentSort] || "score_desc";
}

async function loadLeads() {
  try {
    const params = new URLSearchParams({
      status: currentFilter,
      sort: sortQueryParam(),
      page: currentPage,
      limit: pageLimit,
    });

    const data = await fetchJSON(`/api/qualification/leads?${params}`);
    totalLeads = data.total;
    cachedLeads = data.leads;
    renderTable(data.leads);
    renderPagination();
    totalBadge.textContent = `${data.total} leads`;
  } catch (err) {
    showToast(err.message, "error");
  }
}

function renderTable(leads) {
  if (!leads || leads.length === 0) {
    leadsBody.innerHTML = "";
    emptyState.classList.add("visible");
    return;
  }

  emptyState.classList.remove("visible");

  leadsBody.innerHTML = leads
    .map((lead) => {
      const checked = selectedIds.has(lead.id) ? "checked" : "";
      const scoreVal = lead.lead_score != null ? lead.lead_score : "—";
      const scoreClass =
        lead.lead_score != null ? scoreColorClass(lead.lead_score) : "";
      const reasonFull = escapeHtml(lead.score_reason || "");
      const reasonShort = escapeHtml(truncate(lead.score_reason, 60));
      const approveLabel =
        lead.status === "scoring_failed" ? "Qualify" : "Approve";
      const approveTitle =
        lead.status === "scoring_failed" ? "Qualify manually" : "Approve";

      return `<tr data-lead-id="${lead.id}">
        <td><input type="checkbox" class="lead-checkbox" data-id="${lead.id}" ${checked} aria-label="Select lead"></td>
        <td>${escapeHtml(lead.name || "—")}</td>
        <td><span class="platform-badge ${platformClass(lead.platform)}">${platformLabel(lead.platform)}</span></td>
        <td>${escapeHtml(lead.company || "—")}</td>
        <td>${escapeHtml(lead.location || "—")}</td>
        <td class="score-cell" data-id="${lead.id}">
          <span class="score-badge ${scoreClass}">${scoreVal}</span>
        </td>
        <td>
          <span class="reason-text" data-full="${reasonFull}" data-short="${reasonShort}" title="${reasonFull}">${reasonShort}</span>
        </td>
        <td><span class="status-pill ${statusClass(lead.status)}">${lead.status || "discovered"}</span></td>
        <td>
          <div class="row-actions">
            <button class="row-button approve" data-action="approve" data-id="${lead.id}" title="${approveTitle}">${approveLabel}</button>
            <button class="row-button reject" data-action="reject" data-id="${lead.id}" title="Reject">✕</button>
            <button class="row-button override" data-action="override" data-id="${lead.id}" title="Override Score">✎</button>
          </div>
        </td>
      </tr>`;
    })
    .join("");
}

function renderPagination() {
  const totalPages = Math.max(1, Math.ceil(totalLeads / pageLimit));
  pageLabel.textContent = `Page ${currentPage} of ${totalPages}`;
  prevPage.disabled = currentPage <= 1;
  nextPage.disabled = currentPage >= totalPages;
}

function updateBulkBar() {
  const count = selectedIds.size;
  if (count > 0) {
    bulkBar.classList.add("visible");
    bulkCount.textContent = `${count} selected`;
  } else {
    bulkBar.classList.remove("visible");
  }

  if (manualQualifySelectedBtn) {
    const countLabel =
      manualQualifySelectedBtn.querySelector(".selected-count");
    if (count > 0) {
      manualQualifySelectedBtn.hidden = false;
      if (countLabel) countLabel.textContent = count;
    } else {
      manualQualifySelectedBtn.hidden = true;
      if (countLabel) countLabel.textContent = "0";
    }
  }
}
