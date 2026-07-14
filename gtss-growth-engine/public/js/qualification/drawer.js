/**
 * qualification/drawer.js — Lead detail drawer + inline score-override
 * input for the Lead Qualification page.
 *
 * Exposes (via global scope):
 *   - openDrawer(lead)        — populate and open the slide-in drawer for
 *                                a single lead (name / platform badge /
 *                                score badge / role / company / location
 *                                / website + profile URL links / AI
 *                                reasoning / score input / notes). Toggles
 *                                the manual-qualify vs approve buttons
 *                                based on lead status
 *   - closeDrawer()           — hide the drawer and clear openDrawerLead
 *   - startInlineOverride(id, cell)
 *                              — swap a score-cell's badge for an inline
 *                                <input type="number">; commit on Enter or
 *                                blur, cancel on Escape
 *
 * Depends on (from qualification/state.js, loaded earlier):
 *   - drawerOverlay, drawer, drawerName, drawerPlatformBadge,
 *     drawerScoreBadge, drawerRole, drawerCompany, drawerLocation,
 *     drawerWebsite, drawerProfileUrl, drawerReasoning, drawerScoreInput,
 *     drawerNotes, drawerManualQualify, drawerApprove, openDrawerLead
 * Depends on (from qualification/helpers.js, loaded earlier):
 *   - platformLabel, platformClass, scoreColorClass, escapeHtml
 * Depends on (from qualification/actions.js, loaded earlier):
 *   - overrideScore
 * Depends on (from qualification/table.js, loaded earlier):
 *   - loadLeads
 */

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

  const showManualQualify = ["discovered", "scoring_failed"].includes(
    lead.status,
  );
  if (drawerManualQualify) {
    drawerManualQualify.style.display = showManualQualify ? "" : "none";
  }
  drawerApprove.style.display = showManualQualify ? "none" : "";

  drawerOverlay.classList.add("open");
  drawer.classList.add("open");
}

function closeDrawer() {
  drawerOverlay.classList.remove("open");
  drawer.classList.remove("open");
  openDrawerLead = null;
}

// Inline score override: swap a score cell's badge for an inline number
// input. Commit on Enter or blur, cancel on Escape (reloads the table to
// restore the original badge).
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
