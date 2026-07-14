/**
 * crm/dragDrop.js — Native HTML5 drag-and-drop for Kanban cards.
 *
 * setupDragAndDrop wires document-level dragstart/dragend listeners (so the
 * dragged card is tracked) and per-column dragover/dragleave/drop listeners
 * (so the drop target is highlighted and the lead's status is PATCHed
 * optimistically). On failure the lead's status is reverted and render()
 * re-runs.
 *
 * Original crm.js was 578 lines; this is one of its thematic splits.
 */

"use strict";

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
