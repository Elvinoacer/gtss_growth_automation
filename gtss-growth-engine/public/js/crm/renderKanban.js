/**
 * crm/renderKanban.js — Kanban view renderer + per-card builder.
 *
 * renderKanban clears all five columns, distributes leads by status, and
 * updates the per-column counts. createKanbanCard builds a draggable card
 * with day-since-contact color coding; clicks open the lead drawer (drag is
 * wired separately in dragDrop.js).
 *
 * Original crm.js was 578 lines; this is one of its thematic splits.
 */

"use strict";

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
