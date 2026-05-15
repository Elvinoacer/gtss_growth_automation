/* ================================================================
   Qualification Page – Frontend Logic
   ================================================================ */

(function () {
  "use strict";

  const { fetchJSON, showToast, initSSE } = window.gtss;

  // ---- State ----
  let currentFilter = "all";
  let currentSort = "score_desc";
  let currentPage = 1;
  const pageLimit = 20;
  let totalLeads = 0;
  let selectedIds = new Set();
  let openDrawerLead = null;
  let activeSSE = null;
  let cachedLeads = [];

  // ---- DOM refs ----
  const statPending = document.getElementById("stat-pending");
  const statQualified = document.getElementById("stat-qualified");
  const statDeprioritized = document.getElementById("stat-deprioritized");
  const statOverridden = document.getElementById("stat-overridden");
  const tabPending = document.getElementById("tab-pending");
  const tabApproved = document.getElementById("tab-approved");
  const tabRejected = document.getElementById("tab-rejected");
  const tabOverridden = document.getElementById("tab-overridden");

  const runAllBtn = document.getElementById("run-all-btn");
  const progressPanel = document.getElementById("progress-panel");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  const progressLabelText = document.getElementById("progress-label-text");

  const filterTabs = document.getElementById("filter-tabs");
  const sortSelect = document.getElementById("sort-select");
  const totalBadge = document.getElementById("total-badge");
  const leadsBody = document.getElementById("leads-body");
  const emptyState = document.getElementById("empty-state");
  const bulkBar = document.getElementById("bulk-bar");
  const bulkCount = document.getElementById("bulk-count");
  const bulkApprove = document.getElementById("bulk-approve");
  const bulkReject = document.getElementById("bulk-reject");
  const selectAll = document.getElementById("select-all");
  const prevPage = document.getElementById("prev-page");
  const nextPage = document.getElementById("next-page");
  const pageLabel = document.getElementById("page-label");

  // Drawer refs
  const drawerOverlay = document.getElementById("drawer-overlay");
  const drawer = document.getElementById("drawer");
  const drawerClose = document.getElementById("drawer-close");
  const drawerName = document.getElementById("drawer-name");
  const drawerPlatformBadge = document.getElementById("drawer-platform-badge");
  const drawerScoreBadge = document.getElementById("drawer-score-badge");
  const drawerRole = document.getElementById("drawer-role");
  const drawerCompany = document.getElementById("drawer-company");
  const drawerLocation = document.getElementById("drawer-location");
  const drawerWebsite = document.getElementById("drawer-website");
  const drawerProfileUrl = document.getElementById("drawer-profile-url");
  const drawerReasoning = document.getElementById("drawer-reasoning");
  const drawerScoreInput = document.getElementById("drawer-score-input");
  const drawerSaveScore = document.getElementById("drawer-save-score");
  const drawerNotes = document.getElementById("drawer-notes");
  const drawerApprove = document.getElementById("drawer-approve");
  const drawerReject = document.getElementById("drawer-reject");
  const drawerSkip = document.getElementById("drawer-skip");

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

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

  // ----------------------------------------------------------------
  // Stats
  // ----------------------------------------------------------------

  async function loadStats() {
    try {
      const stats = await fetchJSON("/api/qualification/stats");
      statPending.textContent = stats.pending;
      statQualified.textContent = stats.qualified;
      statDeprioritized.textContent = stats.deprioritized;
      statOverridden.textContent = stats.overridden;
      tabPending.textContent = stats.pending;
      tabApproved.textContent = stats.qualified;
      tabRejected.textContent = stats.deprioritized;
      tabOverridden.textContent = stats.overridden;
    } catch (err) {
      console.error("Failed to load stats", err);
    }
  }

  // ----------------------------------------------------------------
  // Lead table
  // ----------------------------------------------------------------

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
            <button class="row-button approve" data-action="approve" data-id="${lead.id}" title="Approve">✓</button>
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
  }

  // ----------------------------------------------------------------
  // Run Qualification
  // ----------------------------------------------------------------

  async function runQualification() {
    runAllBtn.disabled = true;
    progressPanel.classList.add("visible");
    progressFill.style.width = "0%";
    progressText.textContent = "Starting...";
    progressLabelText.textContent = "Scoring leads with Gemini AI...";

    try {
      const { jobId } = await fetchJSON("/api/qualification/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!jobId) {
        showToast("No pending leads to qualify", "info");
        progressPanel.classList.remove("visible");
        runAllBtn.disabled = false;
        return;
      }

      activeSSE = initSSE(`/api/qualification/stream/${jobId}`, (event) => {
        if (!event) return;

        if (event.type === "progress") {
          const pct =
            event.total > 0
              ? Math.round((event.processed / event.total) * 100)
              : 0;
          progressFill.style.width = `${pct}%`;
          progressText.textContent = `${event.processed} / ${event.total} leads scored`;
        }

        if (event.type === "scored") {
          // Refresh table row if visible
          loadLeads();
        }

        if (event.type === "done") {
          progressFill.style.width = "100%";
          progressLabelText.textContent = "Qualification complete!";
          progressText.textContent = `${event.result.processed} processed — ${event.result.qualified} qualified, ${event.result.deprioritized} deprioritized`;
          showToast(
            `Qualification complete: ${event.result.qualified} qualified`,
            "success",
          );

          if (activeSSE) {
            activeSSE.close();
            activeSSE = null;
          }

          runAllBtn.disabled = false;
          loadStats();
          loadLeads();

          setTimeout(() => {
            progressPanel.classList.remove("visible");
          }, 5000);
        }

        if (event.type === "error") {
          showToast(`Error: ${event.message}`, "error");
        }
      });
    } catch (err) {
      showToast(err.message, "error");
      progressPanel.classList.remove("visible");
      runAllBtn.disabled = false;
    }
  }

  // ----------------------------------------------------------------
  // Actions: Approve / Reject / Override
  // ----------------------------------------------------------------

  async function updateLeadStatus(id, status) {
    try {
      await fetchJSON(`/api/qualification/leads/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      showToast(`Lead ${status}`, "success");
      loadStats();
      loadLeads();
      if (openDrawerLead && openDrawerLead.id === id) {
        openDrawerLead.status = status;
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  async function overrideScore(id, score) {
    try {
      const updated = await fetchJSON(`/api/qualification/leads/${id}/score`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ score }),
      });
      showToast(`Score overridden to ${score}`, "success");
      loadStats();
      loadLeads();
      if (openDrawerLead && openDrawerLead.id === id) {
        openDrawerLead = updated;
      }
      return updated;
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  async function bulkStatusUpdate(ids, status) {
    try {
      await fetchJSON("/api/qualification/leads/bulk/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadIds: [...ids], status }),
      });
      showToast(`${ids.size} leads ${status}`, "success");
      selectedIds.clear();
      updateBulkBar();
      loadStats();
      loadLeads();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  // ----------------------------------------------------------------
  // Drawer
  // ----------------------------------------------------------------

  function openDrawer(lead) {
    openDrawerLead = lead;
    drawerName.textContent = lead.name || "—";
    drawerPlatformBadge.textContent = platformLabel(lead.platform);
    drawerPlatformBadge.className = `platform-badge ${platformClass(lead.platform)}`;

    if (lead.lead_score != null) {
      drawerScoreBadge.textContent = lead.lead_score;
      drawerScoreBadge.className = `score-badge ${scoreColorClass(lead.lead_score)}`;
    } else {
      drawerScoreBadge.textContent = "—";
      drawerScoreBadge.className = "score-badge";
    }

    drawerRole.textContent = lead.role || "—";
    drawerCompany.textContent = lead.company || "—";
    drawerLocation.textContent = lead.location || "—";

    if (lead.website) {
      drawerWebsite.innerHTML = `<a href="${escapeHtml(lead.website)}" target="_blank" rel="noopener">${escapeHtml(lead.website)}</a>`;
    } else {
      drawerWebsite.textContent = "—";
    }

    if (lead.profile_url) {
      drawerProfileUrl.innerHTML = `<a href="${escapeHtml(lead.profile_url)}" target="_blank" rel="noopener">${escapeHtml(lead.profile_url)}</a>`;
    } else {
      drawerProfileUrl.textContent = "—";
    }

    drawerReasoning.textContent =
      lead.score_reason || "No AI reasoning available yet.";
    drawerScoreInput.value = lead.lead_score || 0;
    drawerNotes.value = lead.notes || "";

    drawerOverlay.classList.add("open");
    drawer.classList.add("open");
  }

  function closeDrawer() {
    drawerOverlay.classList.remove("open");
    drawer.classList.remove("open");
    openDrawerLead = null;
  }

  // ----------------------------------------------------------------
  // Inline score override
  // ----------------------------------------------------------------

  function startInlineOverride(id, cell) {
    const current = cell.querySelector(".score-badge");
    const currentScore = current ? parseInt(current.textContent) || 0 : 0;
    cell.innerHTML = `<input class="inline-score-input" type="number" min="0" max="100" value="${currentScore}" data-id="${id}" autofocus>`;
    const input = cell.querySelector(".inline-score-input");
    input.focus();
    input.select();

    const confirm = async () => {
      const newScore = Math.max(0, Math.min(100, parseInt(input.value) || 0));
      await overrideScore(id, newScore);
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") confirm();
      if (e.key === "Escape") loadLeads();
    });

    input.addEventListener("blur", confirm);
  }

  // ----------------------------------------------------------------
  // Event listeners
  // ----------------------------------------------------------------

  // Filter tabs
  filterTabs.addEventListener("click", (e) => {
    const tab = e.target.closest(".filter-tab");
    if (!tab) return;
    filterTabs
      .querySelectorAll(".filter-tab")
      .forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    currentFilter = tab.dataset.status;
    currentPage = 1;
    window.location.hash = currentFilter;
    loadLeads();
  });

  // Sort
  sortSelect.addEventListener("change", () => {
    currentSort = sortSelect.value;
    currentPage = 1;
    loadLeads();
  });

  // Run all
  runAllBtn.addEventListener("click", runQualification);

  // Select all
  selectAll.addEventListener("change", () => {
    const checkboxes = leadsBody.querySelectorAll(".lead-checkbox");
    checkboxes.forEach((cb) => {
      cb.checked = selectAll.checked;
      const id = Number(cb.dataset.id);
      if (selectAll.checked) selectedIds.add(id);
      else selectedIds.delete(id);
    });
    updateBulkBar();
  });

  // Row clicks (delegation)
  leadsBody.addEventListener("click", (e) => {
    // Checkbox
    const cb = e.target.closest(".lead-checkbox");
    if (cb) {
      const id = Number(cb.dataset.id);
      if (cb.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      updateBulkBar();
      return;
    }

    // Row actions
    const actionBtn = e.target.closest(".row-button");
    if (actionBtn) {
      e.stopPropagation();
      const id = Number(actionBtn.dataset.id);
      const action = actionBtn.dataset.action;
      if (action === "approve") updateLeadStatus(id, "qualified");
      else if (action === "reject") updateLeadStatus(id, "deprioritized");
      else if (action === "override") {
        const cell = leadsBody.querySelector(`.score-cell[data-id="${id}"]`);
        if (cell) startInlineOverride(id, cell);
      }
      return;
    }

    // Reason expand
    const reason = e.target.closest(".reason-text");
    if (reason) {
      if (reason.classList.contains("expanded")) {
        reason.classList.remove("expanded");
        reason.textContent = reason.dataset.short;
      } else {
        reason.classList.add("expanded");
        reason.textContent = reason.dataset.full;
      }
      return;
    }

    // Row click → open drawer
    const row = e.target.closest("tr[data-lead-id]");
    if (row) {
      const id = Number(row.dataset.leadId);
      const lead = cachedLeads.find((l) => l.id === id);
      if (lead) {
        openDrawer(lead);
      } else {
        // Fallback fetch if not in cache
        fetchJSON(`/api/qualification/leads?status=all&limit=100&page=1`)
          .then((data) => {
            const found = data.leads.find((l) => l.id === id);
            if (found) openDrawer(found);
          })
          .catch(() => {});
      }
    }
  });

  // Bulk actions
  bulkApprove.addEventListener("click", () => {
    if (selectedIds.size > 0) bulkStatusUpdate(selectedIds, "qualified");
  });

  bulkReject.addEventListener("click", () => {
    if (selectedIds.size > 0) bulkStatusUpdate(selectedIds, "deprioritized");
  });

  // Pagination
  prevPage.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      loadLeads();
    }
  });

  nextPage.addEventListener("click", () => {
    const totalPages = Math.ceil(totalLeads / pageLimit);
    if (currentPage < totalPages) {
      currentPage++;
      loadLeads();
    }
  });

  // Drawer events
  drawerClose.addEventListener("click", closeDrawer);
  drawerOverlay.addEventListener("click", closeDrawer);

  drawerSaveScore.addEventListener("click", async () => {
    if (!openDrawerLead) return;
    const score = parseInt(drawerScoreInput.value) || 0;
    const updated = await overrideScore(openDrawerLead.id, score);
    if (updated) {
      drawerScoreBadge.textContent = updated.lead_score;
      drawerScoreBadge.className = `score-badge ${scoreColorClass(updated.lead_score)}`;
    }
  });

  drawerApprove.addEventListener("click", () => {
    if (openDrawerLead) {
      updateLeadStatus(openDrawerLead.id, "qualified");
      closeDrawer();
    }
  });

  drawerReject.addEventListener("click", () => {
    if (openDrawerLead) {
      updateLeadStatus(openDrawerLead.id, "deprioritized");
      closeDrawer();
    }
  });

  drawerSkip.addEventListener("click", closeDrawer);

  // Notes auto-save
  drawerNotes.addEventListener("blur", async () => {
    if (!openDrawerLead) return;
    try {
      await fetchJSON(`/api/leads/${openDrawerLead.id}/notes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: drawerNotes.value }),
      });
    } catch (err) {
      showToast("Failed to save notes", "error");
    }
  });

  // ----------------------------------------------------------------
  // Hash-based filter restore
  // ----------------------------------------------------------------

  function restoreFilterFromHash() {
    const hash = window.location.hash.replace("#", "");
    const validFilters = [
      "all",
      "pending",
      "approved",
      "rejected",
      "overridden",
    ];
    if (validFilters.includes(hash)) {
      currentFilter = hash;
      filterTabs.querySelectorAll(".filter-tab").forEach((t) => {
        t.classList.toggle("active", t.dataset.status === currentFilter);
      });
    }
  }

  // ----------------------------------------------------------------
  // Init
  // ----------------------------------------------------------------

  restoreFilterFromHash();
  loadStats();
  loadLeads();
})();
