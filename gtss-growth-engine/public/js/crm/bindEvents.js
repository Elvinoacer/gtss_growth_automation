/**
 * crm/bindEvents.js — Wire up all DOM event listeners for the CRM page.
 *
 * Covers: view toggle (kanban/list), search input, platform filter, drawer
 * close (button + backdrop), notes auto-save (1-second debounce), action
 * dropdown (meeting_booked vs. generic status), save-action button (POST
 * book-meeting OR PATCH status), and Detect Replies (POST detect-replies +
 * Socket.IO crm:event listener for done/error/info).
 *
 * Original crm.js was 578 lines; this is one of its thematic splits.
 */

"use strict";

function bindEvents() {
  // Views
  els.viewKanbanBtn.addEventListener("click", () => {
    currentView = "kanban";
    els.viewKanbanBtn.classList.replace(
      "text-on-surface-variant",
      "text-on-surface",
    );
    els.viewKanbanBtn.classList.add("bg-white", "shadow-sm");
    els.viewListBtn.classList.remove(
      "bg-white",
      "shadow-sm",
      "text-on-surface",
    );
    els.viewListBtn.classList.add("text-on-surface-variant");
    els.viewKanban.classList.remove("hidden");
    els.viewList.classList.add("hidden");
    render();
  });

  els.viewListBtn.addEventListener("click", () => {
    currentView = "list";
    els.viewListBtn.classList.replace(
      "text-on-surface-variant",
      "text-on-surface",
    );
    els.viewListBtn.classList.add("bg-white", "shadow-sm");
    els.viewKanbanBtn.classList.remove(
      "bg-white",
      "shadow-sm",
      "text-on-surface",
    );
    els.viewKanbanBtn.classList.add("text-on-surface-variant");
    els.viewList.classList.remove("hidden");
    els.viewKanban.classList.add("hidden");
    render();
  });

  // Search & Filter
  els.searchInput.addEventListener("input", () => render());
  els.platformFilter.addEventListener("change", () => render());

  // Drawer Close
  els.closeDrawerBtn.addEventListener("click", closeDrawer);
  els.backdrop.addEventListener("click", closeDrawer);

  // Notes Auto-save
  let notesTimeout;
  els.drawerNotes.addEventListener("input", () => {
    els.notesSavedIndicator.classList.add("hidden");
    clearTimeout(notesTimeout);
    notesTimeout = setTimeout(async () => {
      if (!currentDrawerLeadId) return;
      try {
        await fetchJSON(`/api/crm/leads/${currentDrawerLeadId}/notes`, {
          method: "PATCH",
          body: JSON.stringify({ notes: els.drawerNotes.value }),
        });

        // Update local state
        const l = leads.find((ld) => ld.id == currentDrawerLeadId);
        if (l) l.notes = els.drawerNotes.value;

        els.notesSavedIndicator.classList.remove("hidden");
      } catch (e) {
        showToast("Failed to save notes", "error");
      }
    }, 1000);
  });

  // Action Dropdown
  els.drawerActionSelect.addEventListener("change", (e) => {
    const val = e.target.value;
    if (val) {
      els.saveActionBtn.classList.remove("hidden");
      if (val === "meeting_booked") {
        els.actionMeetingFields.classList.remove("hidden");
      } else {
        els.actionMeetingFields.classList.add("hidden");
      }
    } else {
      els.saveActionBtn.classList.add("hidden");
      els.actionMeetingFields.classList.add("hidden");
    }
  });

  els.saveActionBtn.addEventListener("click", async () => {
    if (!currentDrawerLeadId) return;
    const action = els.drawerActionSelect.value;

    try {
      if (action === "meeting_booked") {
        await fetchJSON(
          `/api/crm/leads/${currentDrawerLeadId}/book-meeting`,
          {
            method: "POST",
            body: JSON.stringify({
              date: els.meetingDate.value,
              notes: els.meetingNotes.value,
            }),
          },
        );
      } else {
        await fetchJSON(`/api/crm/leads/${currentDrawerLeadId}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status: action }),
        });
      }

      showToast("Action saved successfully", "success");
      // Reload everything to get new touchpoints and status updates
      await loadLeads();
      await loadStats();
      openDrawer(currentDrawerLeadId); // Refresh drawer
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Detect Replies SSE
  els.detectRepliesBtn.addEventListener("click", async () => {
    const btn = els.detectRepliesBtn;
    if (btn.disabled) return;

    btn.disabled = true;
    btn.innerHTML = `<span class="material-symbols-outlined text-sm animate-spin">sync</span> Detecting...`;

    try {
      const { jobId } = await fetchJSON("/api/crm/detect-replies", {
        method: "POST",
      });

      // Legacy SSE to trigger backend
      const legacySSE = window.gtss.initSSE(`/api/crm/reply-stream/${jobId}`, () => {});

      const socket = getSocket();
      if (!socket) return;

      function onCrmEvent(data) {
        if (!data) return;
        if (data.type === "done") {
          showToast(data.message, "success");
          cleanup();
          btn.disabled = false;
          btn.innerHTML = `<span class="material-symbols-outlined text-sm">sync</span> Detect Replies Now`;
          loadLeads();
        } else if (data.type === "error") {
          showToast(data.message, "error");
          cleanup();
          btn.disabled = false;
          btn.innerHTML = `<span class="material-symbols-outlined text-sm">sync</span> Detect Replies Now`;
        } else {
          showToast(data.message, "info");
        }
      }

      function cleanup() {
        socket.off('crm:event', onCrmEvent);
        if (legacySSE) legacySSE.close();
      }

      socket.on('crm:event', onCrmEvent);
    } catch (err) {
      showToast(err.message, "error");
      btn.disabled = false;
      btn.innerHTML = `<span class="material-symbols-outlined text-sm">sync</span> Detect Replies Now`;
    }
  });
}
