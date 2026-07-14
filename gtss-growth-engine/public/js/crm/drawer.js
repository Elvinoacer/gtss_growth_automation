/**
 * crm/drawer.js — Lead detail drawer (open/close) and the touchpoint timeline
 * renderer.
 *
 * openDrawer populates the drawer fields from the lead, shows the drawer +
 * backdrop, and fetches + renders the touchpoint timeline. closeDrawer hides
 * the drawer. renderTimeline builds the colored timeline items (icon +
 * color chosen by touchpoint type).
 *
 * Original crm.js was 578 lines; this is one of its thematic splits.
 */

"use strict";

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
