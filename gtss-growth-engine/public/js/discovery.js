const discoveryState = {
  page: 1,
  limit: 20,
  total: 0,
  selectedIds: new Set(),
  currentJobId: null,
  eventSource: null,
};

let platformLabels = {};

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

async function loadPlatformControls() {
  const catalog = await window.gtss.loadPlatformCatalog();
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

  const keyword = document.getElementById("keyword-input").value.trim();
  const platforms = selectedPlatforms();
  const maxLeads = Number(
    document.getElementById("max-leads-input").value || 20,
  );

  if (!keyword) {
    window.gtss.showToast("Keyword is required", "warning");
    return;
  }

  if (platforms.length === 0) {
    window.gtss.showToast("Select at least one platform", "warning");
    return;
  }

  try {
    const response = await window.gtss.fetchJSON("/api/discovery/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword, platforms, maxLeads }),
    });

    discoveryState.currentJobId = response.jobId;
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

  discoveryState.eventSource = window.gtss.initSSE(
    `/api/discovery/stream/${jobId}`,
    async (event) => {
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
        document.getElementById("result-summary-text").textContent =
          `Discovery complete: ${result.new || 0} new leads, ${result.duplicates || 0} duplicates.`;
        window.gtss.showToast(
          `Discovery complete: ${result.new || 0} new leads found`,
          "success",
        );
        discoveryState.eventSource.close();
        discoveryState.eventSource = null;
        await loadResults();
        await loadHistory();
      }

      if (event.type === "error") {
        window.gtss.showToast(event.message || "Discovery failed", "error");
        document.getElementById("running-panel").classList.remove("visible");
        document.getElementById("discovery-form").style.display = "";
      }
    },
  );
}

async function stopDiscovery() {
  if (!discoveryState.currentJobId) return;

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
  bindEvents();
  loadResults().catch((error) => window.gtss.showToast(error.message, "error"));
  loadHistory().catch((error) => window.gtss.showToast(error.message, "error"));
});
