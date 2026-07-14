/**
 * qualification/actions.js — Per-lead + bulk action calls for the Lead
 * Qualification page (status updates, score override, manual qualify,
 * retry failed).
 *
 * Exposes (via global scope):
 *   - updateLeadStatus(id, status)         — PATCH
 *       /api/qualification/leads/:id/status with {status}, then reload
 *       stats + table; also updates openDrawerLead if the drawer is open
 *       for the same lead
 *   - overrideScore(id, score)             — PATCH
 *       /api/qualification/leads/:id/score; returns the updated lead
 *       (used by the drawer's Save-Score button and by the inline-score
 *       override input)
 *   - bulkStatusUpdate(ids, status)        — PATCH
 *       /api/qualification/leads/bulk/status with {leadIds, status}; clears
 *       the selection and reloads stats + table
 *   - manualQualifyLeads(payload, successMessage)
 *       — POST /api/qualification/leads/bulk/manual-qualify; the payload
 *       may be {all_pending: true} for the "Qualify All Manually" button
 *       or {leadIds: [...]} for the "Qualify Selected" button
 *   - retryFailedLeads()                   — POST
 *       /api/qualification/retry-failed; kicks off a fresh AI-scoring job
 *       for previously-failed leads and attaches the qualification stream
 *
 * Depends on (from qualification/state.js, loaded earlier):
 *   - fetchJSON, showToast, selectedIds, openDrawerLead, runAllBtn,
 *     progressPanel, progressFill, progressText, progressLabelText
 * Depends on (from qualification/qualificationStream.js, loaded earlier):
 *   - attachQualificationStream
 * Depends on (from qualification/table.js, loaded earlier):
 *   - loadLeads, updateBulkBar
 * Depends on (from qualification/stats.js, loaded earlier):
 *   - loadStats
 */

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

async function manualQualifyLeads(payload, successMessage) {
  try {
    const result = await fetchJSON(
      "/api/qualification/leads/bulk/manual-qualify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );

    if (!result.updated) {
      showToast(result.message || "No leads matched", "info");
      return;
    }

    showToast(successMessage(result.updated), "success");
    selectedIds.clear();
    updateBulkBar();
    await loadStats();
    await loadLeads();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function retryFailedLeads() {
  try {
    const res = await fetchJSON("/api/qualification/retry-failed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!res.jobId) {
      showToast(res.message || "No failed leads to retry", "info");
      return;
    }

    runAllBtn.disabled = true;
    progressPanel.classList.add("visible");
    progressFill.style.width = "0%";
    progressText.textContent = "Starting...";
    progressLabelText.textContent = "Retrying AI on failed leads...";
    attachQualificationStream(res.jobId, "Retry complete!");
  } catch (err) {
    showToast(err.message, "error");
    progressPanel.classList.remove("visible");
    runAllBtn.disabled = false;
  }
}
