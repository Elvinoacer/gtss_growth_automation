/**
 * crm/renderList.js — List view renderer (table rows of filtered leads).
 * Clicking a row opens the lead drawer.
 *
 * Original crm.js was 578 lines; this is one of its thematic splits.
 */

"use strict";

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
