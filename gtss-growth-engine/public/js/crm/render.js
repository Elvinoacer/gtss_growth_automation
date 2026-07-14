/**
 * crm/render.js — Top-level render() dispatcher (kanban vs. list view), with
 * search + platform filtering applied to the leads array.
 *
 * Original crm.js was 578 lines; this is one of its thematic splits.
 */

"use strict";

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
