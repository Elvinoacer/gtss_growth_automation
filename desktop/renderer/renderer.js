/**
 * renderer.js — control-center UI logic.
 *
 * Talks to the main process entirely through window.gtss.* (the preload
 * bridge). No Node access, no filesystem access, no direct IPC.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Tabs ────────────────────────────────────────────────────────────────────

$$(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".tab").forEach((b) => b.classList.remove("active"));
    $$(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`#tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// ─── Status polling ──────────────────────────────────────────────────────────

const statusIcon = (el, state) => {
  el.classList.remove("stopped", "starting", "running", "crashed");
  el.classList.add(state);
};

const statusLabel = (state) => ({
  stopped: "Stopped",
  starting: "Starting...",
  running: "Running",
  stopping: "Stopping...",
  crashed: "Crashed",
}[state] || state);

const statusMeta = (s) => {
  if (!s) return "";
  if (s.state === "running") return `PID ${s.pid} · since ${new Date(s.startedAt).toLocaleTimeString()}`;
  if (s.state === "crashed") return s.lastError || "See logs for details";
  if (s.state === "starting") return "Starting...";
  if (s.state === "stopping") return "Stopping...";
  return "Not started";
};

let pollTimer = null;

async function refreshStatus() {
  try {
    const status = await window.gtss.lifecycle.status();
    const server = status.server;
    const cdp = status.cdp;

    statusIcon($("#server-status-icon"), server.state);
    $("#server-status-value").textContent = statusLabel(server.state);
    $("#server-status-meta").textContent = statusMeta(server);

    statusIcon($("#cdp-status-icon"), cdp.state);
    $("#cdp-status-value").textContent = statusLabel(cdp.state);
    $("#cdp-status-meta").textContent = cdp.state === "running"
      ? `Port ${cdp.port} · PID ${cdp.pid}`
      : statusMeta(cdp);

    const overallState = server.state === "running" && cdp.state === "running"
      ? "running"
      : (server.state === "crashed" || cdp.state === "crashed")
        ? "crashed"
        : (server.state === "starting" || cdp.state === "starting")
          ? "starting"
          : "stopped";

    statusIcon($("#overall-status-icon"), overallState);
    $("#overall-status-value").textContent = statusLabel(overallState);
    $("#overall-status-meta").textContent = overallState === "running"
      ? "All services healthy"
      : overallState === "starting"
        ? "Please wait..."
        : overallState === "crashed"
          ? "Something went wrong — check the Logs tab"
          : "Click Start to begin";

    // Update button enabled states.
    const isRunning = overallState === "running";
    const isStopped = overallState === "stopped";
    $("#start-btn").disabled = !isStopped;
    $("#stop-btn").disabled = isStopped;
    $("#restart-btn").disabled = isStopped;
    $("#open-browser-btn").disabled = !isRunning;
    $("#server-start-btn").disabled = server.state === "running";
    $("#server-stop-btn").disabled = server.state !== "running";
    $("#cdp-start-btn").disabled = cdp.state === "running";
    $("#cdp-stop-btn").disabled = cdp.state !== "running";
  } catch (err) {
    console.error("Status refresh failed:", err);
  }
}

pollTimer = setInterval(refreshStatus, 2000);
refreshStatus();

// ─── Lifecycle buttons ───────────────────────────────────────────────────────

$("#start-btn").addEventListener("click", async () => {
  toast("Starting GTSS Growth Engine...", "info");
  const res = await window.gtss.lifecycle.start();
  if (res.ok) {
    toast("All services started. Opening your browser...", "success");
  } else {
    toast(`Failed to start: ${res.error}`, "error");
  }
  refreshStatus();
});

$("#stop-btn").addEventListener("click", async () => {
  toast("Stopping services...", "info");
  const res = await window.gtss.lifecycle.stop();
  if (res.ok) {
    toast("Services stopped.", "success");
  } else {
    toast(`Failed to stop: ${res.error}`, "error");
  }
  refreshStatus();
});

$("#restart-btn").addEventListener("click", async () => {
  toast("Restarting services...", "info");
  const res = await window.gtss.lifecycle.restart();
  if (res.ok) {
    toast("Services restarted.", "success");
  } else {
    toast(`Failed to restart: ${res.error}`, "error");
  }
  refreshStatus();
});

$("#open-browser-btn").addEventListener("click", async () => {
  await window.gtss.openInBrowser();
});

// ─── Granular controls ───────────────────────────────────────────────────────

$("#server-start-btn").addEventListener("click", async () => {
  const res = await window.gtss.server.start();
  if (!res.ok) toast(res.error, "error");
  refreshStatus();
});
$("#server-stop-btn").addEventListener("click", async () => {
  const res = await window.gtss.server.stop();
  if (!res.ok) toast(res.error, "error");
  refreshStatus();
});
$("#cdp-start-btn").addEventListener("click", async () => {
  const res = await window.gtss.cdp.start();
  if (!res.ok) toast(res.error, "error");
  refreshStatus();
});
$("#cdp-stop-btn").addEventListener("click", async () => {
  const res = await window.gtss.cdp.stop();
  if (!res.ok) toast(res.error, "error");
  refreshStatus();
});
$("#open-data-btn").addEventListener("click", () => window.gtss.open.dataFolder());

// ─── Logs ────────────────────────────────────────────────────────────────────

const logsPane = $("#logs-pane");
const filters = {
  server: $("#log-filter-server"),
  cdp: $("#log-filter-cdp"),
  lifecycle: $("#log-filter-lifecycle"),
  updater: $("#log-filter-updater"),
};

let logEntries = [];

function sourceMatchesFilter(source) {
  if (source.startsWith("server")) return filters.server.checked;
  if (source.startsWith("cdp")) return filters.cdp.checked;
  if (source.startsWith("lifecycle")) return filters.lifecycle.checked;
  if (source.startsWith("updater")) return filters.updater.checked;
  return true;
}

function renderLogs() {
  const visible = logEntries.filter((e) => sourceMatchesFilter(e.source));
  if (visible.length === 0) {
    logsPane.innerHTML = '<div class="logs-empty">No logs match the current filters.</div>';
    return;
  }
  logsPane.innerHTML = visible
    .map((e) => {
      const cls = e.source.endsWith("stderr") ? " stderr" : "";
      const sourceCls = e.source.startsWith("lifecycle") ? " lifecycle" : "";
      const time = new Date(e.ts).toLocaleTimeString();
      return `<div class="log-line${cls}${sourceCls}">
        <span class="log-time">${time}</span>
        <span class="log-source">${e.source}</span>
        <span class="log-text">${escapeHtml(e.line)}</span>
      </div>`;
    })
    .join("");
  logsPane.scrollTop = logsPane.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function loadInitialLogs() {
  logEntries = await window.gtss.logs.snapshot();
  renderLogs();
}

window.gtss.logs.onLine((entry) => {
  logEntries.push(entry);
  if (logEntries.length > 5000) logEntries.shift();
  if (sourceMatchesFilter(entry.source)) {
    // Only re-render if the new entry is visible.
    if (logsPane.querySelector(".logs-empty")) renderLogs();
    else {
      const cls = entry.source.endsWith("stderr") ? " stderr" : "";
      const sourceCls = entry.source.startsWith("lifecycle") ? " lifecycle" : "";
      const time = new Date(entry.ts).toLocaleTimeString();
      const div = document.createElement("div");
      div.className = `log-line${cls}${sourceCls}`;
      div.innerHTML = `<span class="log-time">${time}</span>
        <span class="log-source">${escapeHtml(entry.source)}</span>
        <span class="log-text">${escapeHtml(entry.line)}</span>`;
      logsPane.appendChild(div);
      // Cap at 5000 DOM nodes.
      while (logsPane.children.length > 5000) {
        logsPane.removeChild(logsPane.firstChild);
      }
      logsPane.scrollTop = logsPane.scrollHeight;
    }
  }
});

Object.values(filters).forEach((f) => f.addEventListener("change", renderLogs));
$("#logs-clear-btn").addEventListener("click", async () => {
  await window.gtss.logs.clear();
  logEntries = [];
  renderLogs();
});
$("#logs-open-folder-btn").addEventListener("click", () => window.gtss.open.logsFolder());

// ─── Settings ────────────────────────────────────────────────────────────────

async function loadSettings() {
  const s = await window.gtss.settings.get();
  $("#settings-passphrase-status").textContent = s.hasPassphrase ? "Set ✓" : "Not set";
  $("#settings-gemini-key").value = "";
  $("#settings-gemini-key").placeholder = s.hasGeminiKey ? "•••••••• (set, leave blank to keep)" : "AIza...";
  $("#settings-gemini-model").value = s.geminiModel;
  $("#settings-linkedin-mode").value = s.linkedinOutreachMode;
  $("#settings-pipeline-mode").value = s.pipelineMode;
  $("#settings-pipeline-cron").value = s.pipelineCron;
  $("#settings-qualification-threshold").value = s.qualificationThreshold;
  $("#settings-port").value = s.port;
  $("#settings-data-folder").textContent = s.dataRoot;
}

$("#settings-save-passphrase").addEventListener("click", async () => {
  const newPass = $("#settings-new-passphrase").value;
  if (!newPass || newPass.length < 6) {
    toast("Passphrase must be at least 6 characters.", "error");
    return;
  }
  const res = await window.gtss.settings.resetPassphrase(newPass);
  if (res.ok) {
    toast("Passphrase updated.", "success");
    $("#settings-new-passphrase").value = "";
    loadSettings();
  } else {
    toast(res.error, "error");
  }
});

$("#settings-save-ai").addEventListener("click", async () => {
  const key = $("#settings-gemini-key").value;
  const model = $("#settings-gemini-model").value;
  const patch = { geminiModel: model };
  if (key) patch.geminiKey = key;
  const res = await window.gtss.settings.update(patch);
  if (res.ok) {
    toast("AI settings saved.", "success");
    loadSettings();
  } else {
    toast(res.error, "error");
  }
});

$("#settings-save-outreach").addEventListener("click", async () => {
  const res = await window.gtss.settings.update({
    linkedinOutreachMode: $("#settings-linkedin-mode").value,
    pipelineMode: $("#settings-pipeline-mode").value,
    pipelineCron: $("#settings-pipeline-cron").value,
    qualificationThreshold: $("#settings-qualification-threshold").value,
  });
  if (res.ok) toast("Outreach settings saved.", "success");
  else toast(res.error, "error");
});

$("#settings-port")?.addEventListener("change", async () => {
  const res = await window.gtss.settings.update({ port: $("#settings-port").value });
  if (res.ok) toast("Port saved. Restart the server to apply.", "success");
  else toast(res.error, "error");
});

$("#settings-open-data").addEventListener("click", () => window.gtss.open.dataFolder());

$("#gemini-keylink").addEventListener("click", (e) => {
  e.preventDefault();
  window.gtss.openInBrowser && (window.location.href = "https://aistudio.google.com/apikey");
});

// ─── Updater ─────────────────────────────────────────────────────────────────

function updateUpdateIndicator(state) {
  const ind = $("#update-indicator");
  const label = ind.querySelector(".update-label");
  const action = $("#update-action");
  if (state.status === "available") {
    ind.classList.remove("hidden");
    label.textContent = `Update to v${state.version}`;
    action.textContent = "Download";
    action.onclick = async () => {
      action.disabled = true;
      action.textContent = "Downloading...";
      await window.gtss.updater.download();
    };
  } else if (state.status === "downloaded") {
    ind.classList.remove("hidden");
    label.textContent = `v${state.version} ready`;
    action.textContent = "Install & restart";
    action.onclick = () => window.gtss.updater.install();
  } else if (state.status === "downloading") {
    ind.classList.remove("hidden");
    label.textContent = `Downloading... ${state.progress}%`;
    action.textContent = "Downloading...";
    action.disabled = true;
  } else {
    ind.classList.add("hidden");
  }

  // Also update settings tab.
  const settingsState = $("#settings-update-state");
  const installBtn = $("#settings-install-update");
  if (settingsState) {
    settingsState.textContent = state.status;
    if (state.status === "available" || state.status === "downloaded") {
      installBtn.classList.remove("hidden");
      installBtn.textContent = state.status === "downloaded" ? "Install & restart" : "Download & install";
    } else {
      installBtn.classList.add("hidden");
    }
  }
}

window.gtss.updater.onState(updateUpdateIndicator);

$("#settings-check-updates")?.addEventListener("click", async () => {
  toast("Checking for updates...", "info");
  await window.gtss.updater.check();
});
$("#settings-install-update")?.addEventListener("click", async () => {
  const state = await window.gtss.updater.status();
  if (state.status === "available") {
    await window.gtss.updater.download();
  } else if (state.status === "downloaded") {
    await window.gtss.updater.install();
  }
});

// ─── About ───────────────────────────────────────────────────────────────────

$("#about-version").textContent = window.gtss.app.version;
$("#app-version").textContent = `v${window.gtss.app.version}`;
$("#about-platform").textContent = `${window.gtss.app.platform} (${window.gtss.app.isMac ? "macOS" : window.gtss.app.isWindows ? "Windows" : "Linux"})`;
["about-docs", "about-support", "about-source"].forEach((id) => {
  $("#" + id).addEventListener("click", (e) => {
    e.preventDefault();
    // Main process intercepts external links — let the default happen.
  });
});

// ─── Toast helper ────────────────────────────────────────────────────────────

function toast(message, kind = "info") {
  const container = $("#toast-container");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 0.3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

// ─── Init ────────────────────────────────────────────────────────────────────

loadInitialLogs();
loadSettings();
refreshStatus();
