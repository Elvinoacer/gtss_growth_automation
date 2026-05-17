document.addEventListener("DOMContentLoaded", () => {
  const { fetchJSON, showToast, getSocket } = window.gtss;

  // State
  let leads = [];
  let currentView = "kanban";
  let currentDrawerLeadId = null;
  let platformLabels = {};

  // DOM Elements
  const els = {
    viewKanbanBtn: document.getElementById("view-kanban-btn"),
    viewListBtn: document.getElementById("view-list-btn"),
    viewKanban: document.getElementById("view-kanban"),
    viewList: document.getElementById("view-list"),
    searchInput: document.getElementById("search-input"),
    platformFilter: document.getElementById("platform-filter"),
    detectRepliesBtn: document.getElementById("detect-replies-btn"),

    // Drawer
    drawer: document.getElementById("lead-drawer"),
    backdrop: document.getElementById("drawer-backdrop"),
    closeDrawerBtn: document.getElementById("close-drawer-btn"),
    drawerName: document.getElementById("drawer-name"),
    drawerRoleCompany: document.getElementById("drawer-role-company"),
    drawerPlatform: document.getElementById("drawer-platform"),
    drawerProfileUrl: document.getElementById("drawer-profile-url"),
    drawerNotes: document.getElementById("drawer-notes"),
    notesSavedIndicator: document.getElementById("notes-saved-indicator"),
    drawerTimeline: document.getElementById("drawer-timeline"),
    drawerActionSelect: document.getElementById("drawer-action-select"),
    actionMeetingFields: document.getElementById("action-meeting-fields"),
    meetingDate: document.getElementById("meeting-date"),
    meetingNotes: document.getElementById("meeting-notes"),
    saveActionBtn: document.getElementById("save-action-btn"),

    // Stats
    statTotal: document.getElementById("stat-total"),
    statReplyDays: document.getElementById("stat-reply-days"),
    statConvertDays: document.getElementById("stat-convert-days"),
    statConvRate: document.getElementById("stat-conv-rate"),

    listBody: document.getElementById("list-body"),
  };

  // Columns configuration
  const STATUSES = [
    "messaged",
    "replied",
    "meeting_booked",
    "converted",
    "lost",
  ];

  async function loadPlatformFilterOptions() {
    const catalog = await window.gtss.loadPlatformCatalog();
    platformLabels = Object.fromEntries(
      catalog.map((platform) => [platform.key, platform.label]),
    );
    const currentValue = els.platformFilter.value;
    els.platformFilter.innerHTML = [
      '<option value="">All Platforms</option>',
      ...catalog.map(
        (platform) =>
          `<option value="${platform.key}">${window.gtss.escapeHtml(platform.label || window.gtss.formatPlatformLabel(platform.key))}</option>`,
      ),
    ].join("");
    if (currentValue) els.platformFilter.value = currentValue;
  }

  // Initialize
  init();

  async function init() {
    bindEvents();
    await loadPlatformFilterOptions();
    await Promise.all([loadStats(), loadLeads()]);
    setupDragAndDrop();
  }

  // ==========================================
  // DATA FETCHING & RENDERING
  // ==========================================

  async function loadStats() {
    try {
      const stats = await fetchJSON("/api/crm/stats");
      els.statTotal.textContent = stats.total;
      els.statReplyDays.textContent = stats.avgDaysToReply;
      els.statConvertDays.textContent = stats.avgDaysToConvert;
      els.statConvRate.textContent = `${stats.conversionRate}%`;
    } catch (e) {
      console.error("Error loading stats:", e);
    }
  }

  async function loadLeads() {
    try {
      leads = await fetchJSON("/api/crm/leads");
      render();
    } catch (e) {
      showToast("Failed to load CRM data.", "error");
    }
  }

  function render() {
    const searchTerm = els.searchInput.value.toLowerCase();
    const platform = els.platformFilter.value;

    const filteredLeads = leads.filter((l) => {
      const matchSearch =
        l.name.toLowerCase().includes(searchTerm) ||
        (l.company && l.company.toLowerCase().includes(searchTerm));
      const matchPlatform = !platform || l.platform === platform;
      return matchSearch && matchPlatform;
    });

    if (currentView === "kanban") {
      renderKanban(filteredLeads);
    } else {
      renderList(filteredLeads);
    }
  }

  function renderKanban(filteredLeads) {
    // Clear columns and counts
    STATUSES.forEach((status) => {
      const col = document.getElementById(`col-${status}`);
      if (col) col.innerHTML = "";
      const countEl = document.getElementById(`count-${status}`);
      if (countEl) countEl.textContent = "0";
    });

    const counts = {};
    STATUSES.forEach((s) => (counts[s] = 0));

    filteredLeads.forEach((lead) => {
      if (counts[lead.status] !== undefined) {
        counts[lead.status]++;
        const col = document.getElementById(`col-${lead.status}`);
        if (col) {
          col.appendChild(createKanbanCard(lead));
        }
      }
    });

    STATUSES.forEach((status) => {
      const countEl = document.getElementById(`count-${status}`);
      if (countEl) countEl.textContent = counts[status];
    });
  }

  function createKanbanCard(lead) {
    const div = document.createElement("div");
    div.className =
      "kanban-card bg-white border border-outline-variant rounded p-3 shadow-sm hover:shadow transition-shadow select-none";
    div.draggable = true;
    div.dataset.id = lead.id;

    let daysColor = "text-green-600";
    if (lead.days_since_contact >= 3 && lead.days_since_contact <= 7)
      daysColor = "text-amber-600";
    else if (lead.days_since_contact > 7) daysColor = "text-error";

    div.innerHTML = `
            <div class="flex justify-between items-start mb-1">
                <span class="font-semibold text-sm text-on-surface truncate">${lead.name}</span>
                <span class="text-[10px] uppercase font-bold text-gray-400 shrink-0">${window.gtss.formatPlatformLabel(lead.platform)}</span>
            </div>
            <div class="text-xs text-on-surface-variant truncate mb-3">${lead.company || "Unknown Company"}</div>
            
            <div class="flex justify-between items-center mt-2 pt-2 border-t border-outline-variant/50">
                <div class="text-[10px] font-medium ${daysColor}">${lead.days_since_contact}d ago</div>
                <div class="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center cursor-pointer hover:bg-gray-200" title="View details">
                    <span class="material-symbols-outlined text-[14px] text-gray-500">open_in_new</span>
                </div>
            </div>
        `;

    div.addEventListener("click", (e) => {
      // Prevent drag from triggering click immediately
      openDrawer(lead.id);
    });

    // Drag events attached in setupDragAndDrop
    return div;
  }

  function renderList(filteredLeads) {
    els.listBody.innerHTML = "";

    if (filteredLeads.length === 0) {
      els.listBody.innerHTML = `<tr><td colspan="5" class="px-4 py-8 text-center text-gray-500">No leads found.</td></tr>`;
      return;
    }

    filteredLeads.forEach((lead) => {
      const tr = document.createElement("tr");
      tr.className = "hover:bg-gray-50 transition-colors cursor-pointer";
      tr.onclick = () => openDrawer(lead.id);

      tr.innerHTML = `
                <td class="px-4 py-3 font-medium text-on-surface">${lead.name}</td>
                <td class="px-4 py-3 text-on-surface-variant">${lead.company || "-"}</td>
                <td class="px-4 py-3"><span class="capitalize text-xs bg-gray-100 px-2 py-1 rounded">${window.gtss.formatPlatformLabel(lead.platform)}</span></td>
                <td class="px-4 py-3">
                    <span class="text-xs font-semibold px-2 py-1 rounded bg-blue-50 text-blue-700 capitalize">
                        ${lead.status.replace("_", " ")}
                    </span>
                </td>
                <td class="px-4 py-3 text-gray-500">${lead.days_since_contact}d ago</td>
            `;
      els.listBody.appendChild(tr);
    });
  }

  // ==========================================
  // DRAG AND DROP
  // ==========================================

  function setupDragAndDrop() {
    let draggedCard = null;

    // Container listens to card drag starts (Event delegation won't work well for native D&D start,
    // so we rely on mutation observer or attaching directly in createKanbanCard.
    // For simplicity, we'll attach on the document level and check target).

    document.addEventListener("dragstart", (e) => {
      if (e.target.classList && e.target.classList.contains("kanban-card")) {
        draggedCard = e.target;
        setTimeout(() => e.target.classList.add("dragging"), 0);
      }
    });

    document.addEventListener("dragend", (e) => {
      if (e.target.classList && e.target.classList.contains("kanban-card")) {
        e.target.classList.remove("dragging");
        draggedCard = null;

        document
          .querySelectorAll(".kanban-column")
          .forEach((col) => col.classList.remove("drag-over"));
      }
    });

    document.querySelectorAll(".kanban-column").forEach((col) => {
      col.addEventListener("dragover", (e) => {
        e.preventDefault(); // Necessary to allow drop
        col.classList.add("drag-over");
      });

      col.addEventListener("dragleave", (e) => {
        col.classList.remove("drag-over");
      });

      col.addEventListener("drop", async (e) => {
        e.preventDefault();
        col.classList.remove("drag-over");
        if (draggedCard) {
          const newStatus = col.dataset.status;
          const leadId = draggedCard.dataset.id;
          const lead = leads.find((l) => l.id == leadId);

          if (lead && lead.status !== newStatus) {
            // Move element optimistically
            col.appendChild(draggedCard);
            const oldStatus = lead.status;
            lead.status = newStatus;

            // Update counts
            renderKanban(
              leads.filter((l) => {
                const searchTerm = els.searchInput.value.toLowerCase();
                const p = els.platformFilter.value;
                return (
                  l.name.toLowerCase().includes(searchTerm) &&
                  (!p || l.platform === p)
                );
              }),
            );

            try {
              await fetchJSON(`/api/crm/leads/${leadId}/status`, {
                method: "PATCH",
                body: JSON.stringify({ status: newStatus }),
              });
              showToast(`Moved to ${newStatus.replace("_", " ")}`, "success");
              loadStats(); // Update header stats
            } catch (err) {
              // Revert
              lead.status = oldStatus;
              render();
              showToast("Failed to update status", "error");
            }
          }
        }
      });
    });
  }

  // ==========================================
  // DRAWER LOGIC
  // ==========================================

  async function openDrawer(leadId) {
    currentDrawerLeadId = leadId;
    const lead = leads.find((l) => l.id == leadId);
    if (!lead) return;

    els.drawerName.textContent = lead.name;
    els.drawerRoleCompany.textContent = `${lead.role || "Unknown Role"} at ${lead.company || "Unknown Company"}`;
    els.drawerPlatform.textContent = window.gtss.formatPlatformLabel(
      lead.platform,
    );
    els.drawerProfileUrl.href = lead.profile_url || "#";
    els.drawerNotes.value = lead.notes || "";
    els.notesSavedIndicator.classList.add("hidden");

    // Reset action dropdown
    els.drawerActionSelect.value = "";
    els.actionMeetingFields.classList.add("hidden");
    els.saveActionBtn.classList.add("hidden");

    els.drawerTimeline.innerHTML =
      '<div class="text-sm text-gray-500 py-4">Loading timeline...</div>';

    els.backdrop.classList.remove("closed");
    els.backdrop.classList.add("open");
    els.drawer.classList.remove("closed");
    els.drawer.classList.add("open");

    // Load touchpoints
    try {
      const touchpoints = await fetchJSON(
        `/api/crm/leads/${leadId}/touchpoints`,
      );
      renderTimeline(touchpoints);
    } catch (e) {
      els.drawerTimeline.innerHTML =
        '<div class="text-sm text-error py-4">Failed to load timeline.</div>';
    }
  }

  function closeDrawer() {
    els.drawer.classList.remove("open");
    els.drawer.classList.add("closed");
    els.backdrop.classList.remove("open");
    els.backdrop.classList.add("closed");
    currentDrawerLeadId = null;
  }

  function renderTimeline(touchpoints) {
    els.drawerTimeline.innerHTML = "";
    if (touchpoints.length === 0) {
      els.drawerTimeline.innerHTML =
        '<div class="text-sm text-gray-500 py-4">No touchpoints recorded yet.</div>';
      return;
    }

    touchpoints.forEach((tp) => {
      const div = document.createElement("div");
      div.className = "relative";

      let icon = "history";
      let color = "bg-gray-200 text-gray-600";

      if (tp.type === "dm" || tp.type === "connection") {
        icon = "send";
        color = "bg-blue-100 text-blue-600";
      }
      if (tp.type === "reply") {
        icon = "reply";
        color = "bg-green-100 text-green-600";
      }
      if (tp.type === "meeting_booked") {
        icon = "event";
        color = "bg-purple-100 text-purple-600";
      }
      if (tp.type === "status_change") {
        icon = "sync_alt";
        color = "bg-orange-100 text-orange-600";
      }

      const d = new Date(tp.sent_at);
      const timeStr =
        d.toLocaleDateString() +
        " " +
        d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

      div.innerHTML = `
                <div class="absolute -left-[23px] top-1 w-6 h-6 rounded-full flex items-center justify-center ${color} ring-4 ring-white">
                    <span class="material-symbols-outlined text-[14px]">${icon}</span>
                </div>
                <div>
                    <div class="text-xs text-gray-400 font-medium mb-1">${timeStr}</div>
                    <div class="text-sm text-on-surface font-medium capitalize">${tp.type.replace("_", " ")} ${tp.outcome === "received" ? "Received" : tp.outcome || ""}</div>
                    ${tp.notes ? `<div class="text-sm text-gray-600 mt-1 bg-gray-50 p-2 rounded border border-gray-100 italic">"${tp.notes}"</div>` : ""}
                    ${tp.message_body ? `<div class="text-sm text-gray-600 mt-1 bg-blue-50/50 p-2 rounded border border-blue-100">"${tp.message_body}"</div>` : ""}
                </div>
            `;
      els.drawerTimeline.appendChild(div);
    });
  }

  // ==========================================
  // EVENTS
  // ==========================================

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
});
