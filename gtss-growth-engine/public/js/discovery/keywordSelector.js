/**
 * discovery/keywordSelector.js — Pipeline keyword-filter panel for the
 * Discovery page.
 *
 * Renders a secondary panel below the discovery form that lets the user
 * pick pipeline keywords (loaded from /api/discovery/keywords/available),
 * group them into named saved groups (POST /api/discovery/keywords/groups),
 * select an existing group from a <select>, and trigger the outreach
 * pipeline with the current keyword selection (POST
 * /api/pipelines/outreach/run).
 *
 * Exposes (via global scope):
 *   - loadKeywordSelector()        — async; idempotent — builds the panel
 *                                     once into #discovery-form, then
 *                                     binds the group-select / save / run
 *                                     buttons
 *   - selectedPipelineKeywords()   — array of currently-checked
 *                                     `[data-pipeline-keyword]:checked`
 *                                     values
 *   - saveKeywordGroup()           — async; POST a new named group with
 *                                     the current keyword + platform
 *                                     selection
 *   - runOutreachWithKeywords()    — async; POST the current keyword
 *                                     selection to the outreach pipeline
 *
 * Depends on (from discovery/state.js, loaded earlier):
 *   - keywordGroups
 * Depends on (from discovery/helpers.js, loaded earlier):
 *   - escapeHtml, selectedPlatforms
 * Depends on (from window.gtss, available via app.js):
 *   - fetchJSON, showToast
 */

async function loadKeywordSelector() {
  const form = document.getElementById("discovery-form");
  if (!form || document.getElementById("keyword-selector-panel")) return;

  const [available, groups] = await Promise.all([
    window.gtss.fetchJSON("/api/discovery/keywords/available"),
    window.gtss.fetchJSON("/api/discovery/keywords/groups"),
  ]);
  keywordGroups = groups.groups || [];
  const keywords = available.keywords || [];
  if (!keywords.length) return;

  const panel = document.createElement("div");
  panel.id = "keyword-selector-panel";
  panel.className = "rounded border border-outline-variant bg-surface-container-low p-3";
  panel.innerHTML = `
    <label class="block font-label-caps text-label-caps text-tertiary-container mb-2">Pipeline Keyword Filter</label>
    <select id="keyword-group-select" class="w-full mb-2 bg-surface border border-outline-variant rounded px-2 py-2 font-body-sm text-body-sm text-on-surface">
      <option value="">No saved group</option>
      ${keywordGroups.map((group) => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join("")}
    </select>
    <div id="keyword-checklist" class="max-h-36 overflow-auto flex flex-col gap-1">
      ${keywords.map((keyword) => `
        <label class="flex items-center gap-2 text-body-sm text-on-surface">
          <input type="checkbox" data-pipeline-keyword value="${escapeHtml(keyword)}" />
          <span>${escapeHtml(keyword)}</span>
        </label>
      `).join("")}
    </div>
    <div class="flex gap-2 mt-2">
      <input id="keyword-group-name" class="flex-1 bg-surface border border-outline-variant rounded px-2 py-2 font-body-sm text-body-sm text-on-surface" placeholder="Group name" />
      <button id="save-keyword-group" type="button" class="bg-primary text-on-primary rounded px-3 py-2 font-label-caps text-label-caps">Save</button>
    </div>
    <button id="run-outreach-keywords" type="button" class="w-full mt-2 bg-primary text-on-primary rounded px-3 py-2 font-label-caps text-label-caps">
      Run Outreach With Selection
    </button>
  `;
  form.appendChild(panel);

  document.getElementById("keyword-group-select").addEventListener("change", (event) => {
    const group = keywordGroups.find((item) => String(item.id) === String(event.target.value));
    const selected = new Set(group ? group.keywords : []);
    document.querySelectorAll("[data-pipeline-keyword]").forEach((input) => {
      input.checked = selected.has(input.value);
    });
  });
  document.getElementById("save-keyword-group").addEventListener("click", saveKeywordGroup);
  document.getElementById("run-outreach-keywords").addEventListener("click", runOutreachWithKeywords);
}

function selectedPipelineKeywords() {
  return [...document.querySelectorAll("[data-pipeline-keyword]:checked")].map(
    (input) => input.value,
  );
}

async function saveKeywordGroup() {
  const name = document.getElementById("keyword-group-name").value.trim();
  const keywords = selectedPipelineKeywords();
  if (!name || keywords.length === 0) {
    window.gtss.showToast("Name the group and select at least one keyword", "warning");
    return;
  }
  await window.gtss.fetchJSON("/api/discovery/keywords/groups", {
    method: "POST",
    body: JSON.stringify({ name, keywords, platforms: selectedPlatforms() }),
  });
  window.gtss.showToast("Keyword group saved", "success");
  document.getElementById("keyword-selector-panel").remove();
  await loadKeywordSelector();
}

async function runOutreachWithKeywords() {
  const keywords = selectedPipelineKeywords();
  if (keywords.length === 0) {
    window.gtss.showToast("Select at least one keyword", "warning");
    return;
  }
  const result = await window.gtss.fetchJSON("/api/pipelines/outreach/run", {
    method: "POST",
    body: JSON.stringify({ keywords }),
  });
  window.gtss.showToast(result.message || "Outreach pipeline triggered", "success");
}
