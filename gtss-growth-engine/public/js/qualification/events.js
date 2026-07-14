/**
 * qualification/events.js — All top-level event listeners for the Lead
 * Qualification page. Runs at script-load time (the original IIFE body did
 * the same — these `addEventListener` calls happened during the initial
 * parse-and-execute pass).
 *
 * Wires:
 *   - Filter tabs (all / pending / approved / rejected / scoring_failed /
 *     overridden) — also syncs to window.location.hash so a refresh
 *     restores the active tab
 *   - Sort <select>
 *   - Run All button (→ runQualification)
 *   - Manual-actions trigger (open/close dropdown) + document click-outside
 *     (close dropdown)
 *   - Manual Qualify All / Manual Qualify Selected / Retry Failed buttons
 *   - Select-all checkbox (toggles every row checkbox + selectedIds)
 *   - Row-click delegation: checkbox toggle / row-action buttons
 *     (approve / reject / override-score) / reason-text expand /
 *     row-click → openDrawer
 *   - Bulk approve / bulk reject buttons (→ bulkStatusUpdate)
 *   - Pagination prev/next buttons
 *   - Drawer close (X / backdrop), Save Score, Approve / Manual Qualify /
 *     Reject / Skip buttons
 *   - Notes textarea blur → auto-save to /api/leads/:id/notes
 *
 * Depends on (from qualification/state.js, loaded earlier):
 *   - filterTabs, sortSelect, runAllBtn, manualActionsTrigger,
 *     manualActionsDropdown, manualActionsMenu, manualQualifyAllBtn,
 *     manualQualifySelectedBtn, retryFailedBtn, selectAll, leadsBody,
 *     bulkApprove, bulkReject, prevPage, nextPage, drawerClose,
 *     drawerOverlay, drawerSaveScore, drawerScoreInput, drawerScoreBadge,
 *     drawerApprove, drawerManualQualify, drawerReject, drawerSkip,
 *     drawerNotes, openDrawerLead, selectedIds, currentPage, totalLeads,
 *     pageLimit, currentFilter, currentSort, cachedLeads, fetchJSON,
 *     showToast
 * Depends on (from qualification/helpers.js, loaded earlier):
 *   - scoreColorClass
 * Depends on (from qualification/table.js, loaded earlier):
 *   - loadLeads, updateBulkBar
 * Depends on (from qualification/manualActions.js, loaded earlier):
 *   - closeManualActionsMenu, toggleManualActionsMenu
 * Depends on (from qualification/actions.js, loaded earlier):
 *   - updateLeadStatus, overrideScore, bulkStatusUpdate,
 *     manualQualifyLeads, retryFailedLeads
 * Depends on (from qualification/runQualification.js, loaded earlier):
 *   - runQualification
 * Depends on (from qualification/drawer.js, loaded earlier):
 *   - openDrawer, closeDrawer, startInlineOverride
 */

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

if (manualActionsTrigger && manualActionsDropdown) {
  manualActionsTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleManualActionsMenu();
  });

  document.addEventListener("click", (e) => {
    if (manualActionsMenu && !manualActionsMenu.contains(e.target)) {
      closeManualActionsMenu();
    }
  });
}

manualQualifyAllBtn.addEventListener("click", async () => {
  closeManualActionsMenu();
  const confirmed = confirm(
    "Mark all discovered and AI-failed leads as qualified without using AI?",
  );
  if (!confirmed) return;

  await manualQualifyLeads(
    { all_pending: true },
    (updated) => `${updated} leads marked as qualified`,
  );
});

manualQualifySelectedBtn.addEventListener("click", async () => {
  closeManualActionsMenu();
  if (selectedIds.size === 0) return;
  const ids = [...selectedIds];

  await manualQualifyLeads(
    { leadIds: ids },
    (updated) => `${updated} selected leads marked as qualified`,
  );
});

retryFailedBtn.addEventListener("click", async () => {
  closeManualActionsMenu();
  await retryFailedLeads();
});

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

if (drawerManualQualify) {
  drawerManualQualify.addEventListener("click", () => {
    if (openDrawerLead) {
      updateLeadStatus(openDrawerLead.id, "qualified");
      closeDrawer();
    }
  });
}

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
