const discoveryState = {
  page: 1,
  limit: 20,
  total: 0,
  selectedIds: new Set(),
  currentJobId: null,
  currentPlatforms: [],
  eventSource: null,
};

let platformLabels = {};
let keywordGroups = [];
const DISCOVERY_PLATFORM_KEYS = new Set(["linkedin", "x", "facebook", "instagram"]);

function platformBadge(platform) {
  const label =
    platformLabels[platform] ||
    window.gtss.formatPlatformLabel(platform) ||
    platform;
  return `<span class="platform-badge platform-${platform}">${label}</span>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function selectedPlatforms() {
  return [...document.querySelectorAll('input[name="platforms"]:checked')].map(
    (input) => input.value,
  );
}

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

async function loadPlatformControls() {
  const catalog = (await window.gtss.loadPlatformCatalog()).filter((platform) =>
    DISCOVERY_PLATFORM_KEYS.has(platform.key),
  );
  platformLabels = Object.fromEntries(
    catalog.map((platform) => [platform.key, platform.label]),
  );

  const platformRow = document.getElementById("platform-row");
  if (platformRow) {
    platformRow.innerHTML = catalog
      .map(
        (platform) => `
      <label class="platform-option"><input type="checkbox" name="platforms" value="${platform.key}"> ${escapeHtml(platform.label || window.gtss.formatPlatformLabel(platform.key))}</label>
    `,
      )
      .join("");

    const checkboxes = platformRow.querySelectorAll('input[name="platforms"]');
    checkboxes.forEach(cb => {
      cb.addEventListener("change", () => {
        const igChecked = [...platformRow.querySelectorAll('input[name="platforms"]:checked')].some(i => i.value === "instagram");
        const igContainer = document.getElementById("ig-discovery-container");
        if (igContainer) {
          if (igChecked) {
            igContainer.classList.add("visible");
            loadInstagramDiscoveryKeywords();
          } else {
            igContainer.classList.remove("visible");
          }
        }
      });
    });
  }

  const filterSelect = document.getElementById("platform-filter");
  if (filterSelect) {
    filterSelect.innerHTML = [
      '<option value="">All</option>',
      ...catalog.map(
        (platform) =>
          `<option value="${platform.key}">${escapeHtml(platform.label || window.gtss.formatPlatformLabel(platform.key))}</option>`,
      ),
    ].join("");
  }
}

let selectedHashtags = [];
let defaultHashtags = [];
let igKeywordsLoaded = false;
// True while we are hydrating hashtag chips from the saved config so that the
// chip add/remove handlers don't fire a save back to the server for every
// default tag we restore.
let igHashtagsHydrating = false;
let saveHashtagsTimer = null;

async function loadInstagramDiscoveryKeywords() {
  if (igKeywordsLoaded) return;
  try {
    const data = await window.gtss.fetchJSON("/api/discovery/keywords");

    igHashtagsHydrating = true;
    // 1. Populate Hashtags
    if (data.instagram && Array.isArray(data.instagram.hashtags)) {
      defaultHashtags = data.instagram.hashtags;
      // Populate starting chips from defaults
      defaultHashtags.forEach(tag => {
        addHashtagChip(tag);
      });
    }
    igHashtagsHydrating = false;

    // 2. Populate Geolocation Select Dropdown
    const select = document.getElementById("ig-location-select");
    if (select && data.instagram && Array.isArray(data.instagram.geolocations)) {
      select.innerHTML = data.instagram.geolocations
        .map(loc => `<option value="${loc.id}">${escapeHtml(loc.name)}</option>`)
        .join("");
    }

    // Bind hashtag input
    const hashtagInput = document.getElementById("hashtag-chip-input");
    if (hashtagInput) {
      hashtagInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addHashtagChip(hashtagInput.value);
          hashtagInput.value = "";
        }
      });
    }

    // Bind strategy radios
    const strategyRadios = document.querySelectorAll('input[name="ig-strategy"]');
    strategyRadios.forEach(radio => {
      radio.addEventListener("change", (e) => {
        const activeStrategy = e.target.value;
        
        document.getElementById("ig-hashtag-panel").classList.toggle("active", activeStrategy === "hashtag");
        document.getElementById("ig-geolocation-panel").classList.toggle("active", activeStrategy === "geolocation");
        document.getElementById("ig-competitor-panel").classList.toggle("active", activeStrategy === "competitor");
        document.getElementById("ig-suggested-panel").classList.toggle("active", activeStrategy === "suggested");
      });
    });
    
    igKeywordsLoaded = true;
  } catch (error) {
    igHashtagsHydrating = false;
    console.error("Failed to load Instagram discovery keywords", error);
  }
}

// Debounced (500ms) persistence of the current Instagram hashtag selection.
// POSTs only the instagram.hashtags slice to /api/discovery/keywords — the
// backend route now accepts a partial instagram update without requiring the
// `keywords` array.
function scheduleHashtagSave() {
  if (igHashtagsHydrating) return;
  if (saveHashtagsTimer) clearTimeout(saveHashtagsTimer);
  saveHashtagsTimer = setTimeout(() => {
    saveHashtagsTimer = null;
    saveInstagramHashtags().catch((err) =>
      console.error("saveInstagramHashtags failed", err),
    );
  }, 500);
}

async function saveInstagramHashtags() {
  // Snapshot the array so a rapid add/remove race doesn't POST stale data.
  const snapshot = [...selectedHashtags];
  try {
    await window.gtss.fetchJSON("/api/discovery/keywords", {
      method: "POST",
      body: JSON.stringify({ instagram: { hashtags: snapshot } }),
    });
    // Only show the "saved" toast if the chips still reflect the snapshot we
    // just persisted (otherwise another save is already in flight).
    if (
      saveHashtagsTimer === null &&
      snapshot.length === selectedHashtags.length &&
      snapshot.every((t, i) => selectedHashtags[i] === t)
    ) {
      window.gtss.showToast("✓ Hashtags saved", "success");
    }
  } catch (error) {
    console.error("Failed to save Instagram hashtags", error);
    window.gtss.showToast("Failed to save hashtags", "error");
  }
}

function addHashtagChip(tag) {
  tag = tag.trim().replace(/^#/, "");
  if (!tag || selectedHashtags.includes(tag)) return;
  selectedHashtags.push(tag);
  renderHashtagChips();
  scheduleHashtagSave();
}

function removeHashtagChip(tag) {
  selectedHashtags = selectedHashtags.filter(t => t !== tag);
  renderHashtagChips();
  scheduleHashtagSave();
}

function renderHashtagChips() {
  const container = document.getElementById("hashtag-chip-container");
  const input = document.getElementById("hashtag-chip-input");
  if (!container) return;
  
  const chipEls = container.querySelectorAll(".chip");
  chipEls.forEach(el => el.remove());
  
  selectedHashtags.forEach(tag => {
    const span = document.createElement("span");
    span.className = "chip";
    span.innerHTML = `#${escapeHtml(tag)} <span class="chip-remove" data-tag="${escapeHtml(tag)}">✕</span>`;
    
    span.querySelector(".chip-remove").addEventListener("click", () => {
      removeHashtagChip(tag);
    });
    
    container.insertBefore(span, input);
  });
}

function appendLog(event) {
  const log = document.getElementById("live-log");
  const type = event.type || "info";
  const classType = type === "done" ? "success" : type;
  const line = document.createElement("div");
  line.className = `log-${classType}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${event.message || formatEventMessage(event)}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function formatEventMessage(event) {
  if (event.type === "connected") return "Connected to discovery stream";
  if (event.type === "done") {
    const result = event.result || {};
    return `Discovery complete: ${result.new || 0} new, ${result.duplicates || 0} duplicates`;
  }
  return JSON.stringify(event);
}

async function startDiscovery(event) {
  event.preventDefault();

  let keyword = document.getElementById("keyword-input").value.trim();
  const platforms = selectedPlatforms();
  const maxLeads = Number(
    document.getElementById("max-leads-input").value || 20,
  );

  if (platforms.length === 0) {
    window.gtss.showToast("Select at least one platform", "warning");
    return;
  }

  const hasInstagram = platforms.includes("instagram");
  let ig_auto_warmup = false;

  if (hasInstagram) {
    const activeStrategy = document.querySelector('input[name="ig-strategy"]:checked')?.value || "hashtag";
    ig_auto_warmup = document.getElementById("ig-auto-warmup").checked;

    if (activeStrategy === "hashtag") {
      if (selectedHashtags.length === 0) {
        window.gtss.showToast("Please add at least one Instagram Hashtag chip.", "warning");
        return;
      }
      keyword = `#${selectedHashtags[0]}`;
    } else if (activeStrategy === "geolocation") {
      const select = document.getElementById("ig-location-select");
      if (!select || !select.value) {
        window.gtss.showToast("Please select a location.", "warning");
        return;
      }
      const option = select.options[select.selectedIndex];
      keyword = `geolocation:${select.value}:${option.text}`;
    } else if (activeStrategy === "competitor") {
      const usernameInput = document.getElementById("ig-competitor-username");
      const cleaned = usernameInput ? usernameInput.value.trim().replace(/^@/, "") : "";
      if (!cleaned) {
        window.gtss.showToast("Please enter a competitor username.", "warning");
        return;
      }
      const maxScrape = Number(document.getElementById("ig-competitor-max").value || 25);
      keyword = `competitor:${cleaned}`;
    } else if (activeStrategy === "suggested") {
      keyword = "competitor:suggested";
    }
  } else {
    if (!keyword) {
      window.gtss.showToast("Keyword is required", "warning");
      return;
    }
  }

  try {
    const response = await window.gtss.fetchJSON("/api/discovery/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword, platforms, maxLeads, ig_auto_warmup }),
    });

    discoveryState.currentJobId = response.jobId;
    // Track which platforms were scanned so the completion summary can list
    // them after the SSE done event arrives.
    discoveryState.currentPlatforms = [...platforms];
    document.getElementById("discovery-form").style.display = "none";
    document.getElementById("result-summary").classList.remove("visible");
    document.getElementById("running-panel").classList.add("visible");
    document.getElementById("running-text").textContent =
      `Discovering leads on ${platforms.map((platform) => platformLabels[platform]).join(", ")}...`;
    document.getElementById("live-log").innerHTML = "";
    appendLog({
      type: "info",
      message: `Discovery job ${response.jobId} started`,
    });
    openDiscoveryStream(response.jobId);
  } catch (error) {
    window.gtss.showToast(error.message, "error");
  }
}

function openDiscoveryStream(jobId) {
  if (discoveryState.eventSource) {
    discoveryState.eventSource.close();
  }

  // Legacy SSE to trigger backend stream
  discoveryState.eventSource = window.gtss.initSSE(
    `/api/discovery/stream/${jobId}`,
    () => {},
  );

  // Socket.IO listener for real-time events
  const socket = window.gtss.getSocket();
  if (!socket) return;

  function onDiscoveryEvent(event) {
    if (event.jobId && String(event.jobId) !== String(jobId)) return;
    appendLog(event);

    if (event.type === "captcha") {
      appendLog({
        type: "captcha",
        message: event.message || "CAPTCHA detected, automation paused",
      });
    }

    if (event.type === "done") {
      const result = event.result || {};
      document.getElementById("running-panel").classList.remove("visible");
      document.getElementById("discovery-form").style.display = "";
      document.getElementById("result-summary").classList.add("visible");
      // Compose the richer completion summary: success badge + new/duplicate
      // counts + platforms scanned, plus a "Proceed to Qualification" CTA
      // (the CTA markup lives in discovery.html).
      const scannedKeys =
        discoveryState.currentPlatforms && discoveryState.currentPlatforms.length
          ? discoveryState.currentPlatforms
          : selectedPlatforms();
      const platformsScanned = scannedKeys.map(
        (key) =>
          platformLabels[key] ||
          window.gtss.formatPlatformLabel(key) ||
          key,
      );
      document.getElementById("result-summary-text").textContent =
        `Discovery Complete: ${result.new || 0} new leads found`;
      document.getElementById("result-summary-detail").textContent =
        `Scanned: ${platformsScanned.length ? platformsScanned.join(", ") : "—"} · ${result.duplicates || 0} duplicates skipped`;
      window.gtss.showToast(
        `Discovery complete: ${result.new || 0} new leads found`,
        "success",
      );
      cleanup();
      loadResults();
      loadHistory();
    }

    if (event.type === "stopped") {
      discoveryState.running = false;
      document.getElementById("running-panel").classList.remove("visible");
      document.getElementById("discovery-form").style.display = "";
      window.gtss.showToast("Discovery stopped.", "warn");
      cleanup();
      loadHistory();
    }

    if (event.type === "error") {
      window.gtss.showToast(event.message || "Discovery failed", "error");
      document.getElementById("running-panel").classList.remove("visible");
      document.getElementById("discovery-form").style.display = "";
      cleanup();
    }
  }

  function cleanup() {
    socket.off('discovery:event', onDiscoveryEvent);
    if (discoveryState.eventSource) {
      discoveryState.eventSource.close();
      discoveryState.eventSource = null;
    }
  }

  socket.on('discovery:event', onDiscoveryEvent);
}

async function stopDiscovery() {
  if (!discoveryState.currentJobId) {
    window.gtss.showToast("No active discovery to stop.", "warn");
    return;
  }

  try {
    await window.gtss.fetchJSON(
      `/api/discovery/stop/${discoveryState.currentJobId}`,
      { method: "POST" },
    );
    appendLog({
      type: "warning",
      message: "Stop requested. Current browser action may finish first.",
    });
  } catch (error) {
    window.gtss.showToast(error.message, "error");
  }
}

function buildResultQuery() {
  const params = new URLSearchParams({
    page: String(discoveryState.page),
    limit: String(discoveryState.limit),
  });
  const platform = document.getElementById("platform-filter").value;
  const keyword = document.getElementById("keyword-filter").value.trim();
  const dateFrom = document.getElementById("date-from-filter").value;
  const dateTo = document.getElementById("date-to-filter").value;

  if (platform) params.set("platform", platform);
  if (keyword) params.set("keyword", keyword);
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);

  return params.toString();
}

async function loadResults() {
  const data = await window.gtss.fetchJSON(
    `/api/discovery/results?${buildResultQuery()}`,
  );
  discoveryState.total = data.total;
  discoveryState.selectedIds.clear();
  renderResults(data.leads || []);
  renderPagination();
  updateBulkBar();
}

function renderResults(leads) {
  const tbody = document.getElementById("results-body");
  const empty = document.getElementById("empty-state");
  document.getElementById("total-count").textContent = String(
    discoveryState.total,
  );
  document.getElementById("select-all").checked = false;

  if (leads.length === 0) {
    tbody.innerHTML = "";
    empty.classList.add("visible");
    return;
  }

  empty.classList.remove("visible");
  tbody.innerHTML = leads
    .map((lead) => {
      const profileUrl = escapeHtml(lead.profile_url);
      return `
      <tr data-lead-row="${lead.id}">
        <td><input class="lead-select" type="checkbox" value="${lead.id}" aria-label="Select ${escapeHtml(lead.name || "lead")}"></td>
        <td>${escapeHtml(lead.name || "Unknown")}</td>
        <td>${escapeHtml(lead.role || "")}</td>
        <td>${escapeHtml(lead.company || "")}</td>
        <td>${escapeHtml(lead.location || "")}</td>
        <td>${platformBadge(lead.platform)}</td>
        <td><a class="url-link" href="${profileUrl}" target="_blank" rel="noreferrer">${profileUrl}</a> Open ↗</td>
        <td>${formatDate(lead.created_at)}</td>
        <td>
          <div class="row-actions">
            <button class="row-button" data-action="queue" data-id="${lead.id}" type="button">Add to Queue</button>
            <button class="row-button danger" data-action="dismiss" data-id="${lead.id}" type="button">Dismiss</button>
          </div>
        </td>
      </tr>
    `;
    })
    .join("");
}

function renderPagination() {
  const totalPages = Math.max(
    Math.ceil(discoveryState.total / discoveryState.limit),
    1,
  );
  document.getElementById("page-label").textContent =
    `Page ${discoveryState.page} of ${totalPages}`;
  document.getElementById("prev-page").disabled = discoveryState.page <= 1;
  document.getElementById("next-page").disabled =
    discoveryState.page >= totalPages;
}

function updateBulkBar() {
  const count = discoveryState.selectedIds.size;
  document.getElementById("bulk-bar").classList.toggle("visible", count > 0);
  document.getElementById("bulk-count").textContent = `${count} selected`;
  document.getElementById("bulk-qualify").textContent =
    `Qualify Selected (${count})`;
}

async function addToQueue(ids) {
  const data = await window.gtss.fetchJSON("/api/discovery/add-to-queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leadIds: ids }),
  });
  window.gtss.showToast(
    `${data.updated} leads added to qualification queue`,
    "success",
  );
  removeRows(ids);
  await loadResults();
}

async function dismiss(ids) {
  const data = await window.gtss.fetchJSON("/api/discovery/dismiss", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leadIds: ids }),
  });
  window.gtss.showToast(`${data.updated} leads dismissed`, "success");
  removeRows(ids);
  await loadResults();
}

function removeRows(ids) {
  ids.forEach((id) => {
    const row = document.querySelector(`[data-lead-row="${id}"]`);
    if (row) row.classList.add("fading");
  });
}

async function loadHistory() {
  const data = await window.gtss.fetchJSON("/api/discovery/history");
  const tbody = document.getElementById("history-table-body");
  const runs = data.runs || [];

  tbody.innerHTML = runs
    .map(
      (run) => `
    <tr>
      <td>${escapeHtml(run.keyword)}</td>
      <td>${(run.platforms || []).map(platformBadge).join(" ")}</td>
      <td>${run.leads_found || 0}</td>
      <td>${formatDate(run.run_at)}</td>
      <td><button class="row-button" data-rerun="${run.id}" type="button">Re-run</button></td>
    </tr>
  `,
    )
    .join("");
}

async function rerun(id) {
  try {
    const data = await window.gtss.fetchJSON(
      `/api/discovery/history/${id}/rerun`,
      { method: "POST" },
    );
    window.gtss.showToast(
      `Discovery rerun started: job ${data.jobId}`,
      "success",
    );
    discoveryState.currentJobId = data.jobId;
    // The rerun endpoint returns the platforms that will actually be scanned
    // (taken from the original run record) so the completion summary lists
    // the correct platforms instead of whatever is currently checked.
    if (Array.isArray(data.platforms) && data.platforms.length) {
      discoveryState.currentPlatforms = [...data.platforms];
    } else {
      discoveryState.currentPlatforms = selectedPlatforms();
    }
    document.getElementById("discovery-form").style.display = "none";
    document.getElementById("running-panel").classList.add("visible");
    document.getElementById("live-log").innerHTML = "";
    document.getElementById("running-text").textContent =
      "Re-running discovery...";
    openDiscoveryStream(data.jobId);
  } catch (error) {
    window.gtss.showToast(error.message, "error");
  }
}

async function loadDiscoveryConfig() {
  try {
    const config = await window.gtss.fetchJSON("/api/discovery/config");
    const input = document.getElementById("max-leads-input");
    if (input && config.maxLeads) {
      input.value = config.maxLeads;
    }
  } catch (error) {
    console.error("Failed to load discovery config", error);
  }
}

async function saveDiscoveryConfig() {
  const maxLeads = Number(document.getElementById("max-leads-input").value);
  if (isNaN(maxLeads) || maxLeads < 1) return;
  
  try {
    await window.gtss.fetchJSON("/api/discovery/config", {
      method: "POST",
      body: JSON.stringify({ maxLeads }),
    });
  } catch (error) {
    console.error("Failed to save discovery config", error);
  }
}

function bindEvents() {
  document
    .getElementById("discovery-form")
    .addEventListener("submit", startDiscovery);
  
  const maxLeadsInput = document.getElementById("max-leads-input");
  if (maxLeadsInput) {
    maxLeadsInput.addEventListener("change", saveDiscoveryConfig);
  }

  document
    .getElementById("stop-button")
    .addEventListener("click", stopDiscovery);
  document.getElementById("apply-filters").addEventListener("click", () => {
    discoveryState.page = 1;
    loadResults().catch((error) =>
      window.gtss.showToast(error.message, "error"),
    );
  });
  [
    "platform-filter",
    "keyword-filter",
    "date-from-filter",
    "date-to-filter",
  ].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => {
      discoveryState.page = 1;
      loadResults().catch((error) =>
        window.gtss.showToast(error.message, "error"),
      );
    });
  });
  document.getElementById("prev-page").addEventListener("click", () => {
    discoveryState.page = Math.max(discoveryState.page - 1, 1);
    loadResults().catch((error) =>
      window.gtss.showToast(error.message, "error"),
    );
  });
  document.getElementById("next-page").addEventListener("click", () => {
    discoveryState.page += 1;
    loadResults().catch((error) =>
      window.gtss.showToast(error.message, "error"),
    );
  });
  document.getElementById("select-all").addEventListener("change", (event) => {
    document.querySelectorAll(".lead-select").forEach((checkbox) => {
      checkbox.checked = event.target.checked;
      const id = Number(checkbox.value);
      if (checkbox.checked) discoveryState.selectedIds.add(id);
      else discoveryState.selectedIds.delete(id);
    });
    updateBulkBar();
  });
  document
    .getElementById("results-body")
    .addEventListener("change", (event) => {
      if (!event.target.classList.contains("lead-select")) return;
      const id = Number(event.target.value);
      if (event.target.checked) discoveryState.selectedIds.add(id);
      else discoveryState.selectedIds.delete(id);
      updateBulkBar();
    });
  document
    .getElementById("results-body")
    .addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const id = Number(button.dataset.id);
      try {
        if (button.dataset.action === "queue") await addToQueue([id]);
        if (button.dataset.action === "dismiss") await dismiss([id]);
      } catch (error) {
        window.gtss.showToast(error.message, "error");
      }
    });
  document.getElementById("bulk-qualify").addEventListener("click", () => {
    addToQueue([...discoveryState.selectedIds]).catch((error) =>
      window.gtss.showToast(error.message, "error"),
    );
  });
  document.getElementById("bulk-dismiss").addEventListener("click", () => {
    dismiss([...discoveryState.selectedIds]).catch((error) =>
      window.gtss.showToast(error.message, "error"),
    );
  });
  document.getElementById("history-toggle").addEventListener("click", () => {
    const body = document.getElementById("history-body");
    const open = !body.classList.contains("visible");
    body.classList.toggle("visible", open);
    document.getElementById("history-title").textContent =
      `${open ? "▲" : "▼"} Discovery History`;
  });
  document
    .getElementById("history-table-body")
    .addEventListener("click", (event) => {
      const button = event.target.closest("button[data-rerun]");
      if (button) rerun(button.dataset.rerun);
    });
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadPlatformControls();
  await loadDiscoveryConfig();
  await loadKeywordSelector().catch(() => {});
  bindEvents();
  loadResults().catch((error) => window.gtss.showToast(error.message, "error"));
  loadHistory().catch((error) => window.gtss.showToast(error.message, "error"));
});
