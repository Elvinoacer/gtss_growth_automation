/**
 * renderer.js — control-center UI logic.
 *
 * The launcher is intentionally minimal. The web app at localhost:3000 is
 * the real application — this window just starts/stops it, shows status,
 * shows logs, and surfaces friendly error cards when something goes wrong.
 *
 * Talks to the main process entirely through window.gtss.* (the preload
 * bridge). No Node access, no filesystem access, no direct IPC.
 *
 * ─── Where sign-in happens now ─────────────────────────────────────────────
 *
 * The sign-in modal used to live HERE (inside the launcher). It has moved
 * to the web app's root page ("/"). Reasons:
 *
 *   1. The web app is where the user spends their time — surfacing the
 *      sign-in prompt there (instead of in a separate Electron window)
 *      is the right UX.
 *
 *   2. Sign-in now happens INSIDE the CDP Chrome (the automation
 *      browser), not the user's default browser. When the user clicks a
 *      platform on the web app's sign-in modal, the web app calls the
 *      bridge server (desktop/main/bridge-server.js) which opens the
 *      login page in a new tab of the CDP Chrome. Cookies land in the
 *      right profile immediately — no profile-clone round-trip needed.
 *
 * The launcher still polls CDP sessions so it can show a lightweight
 * "X/N connected" badge in the topbar + a "Sign in…" hint in the Control
 * tab when sessions are missing. Clicking either opens the web app
 * (where the full modal lives).
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Sessions health (lightweight badge + hint card) ──────────────────────
//
// We poll the CDP Chrome's cookies to see which platforms (LinkedIn, X,
// Instagram, Facebook, Google/Gemini) the automation browser is signed
// into. The result drives:
//
//   - A topbar badge ("X/N connected") — green/yellow/red at a glance.
//   - A small hint card in the Control tab that appears when sessions
//     are missing, with a "Sign in…" button that opens the web app
//     (where the full sign-in modal lives and can drive logins inside
//     the CDP Chrome via the bridge server).
//
// The launcher does NOT render the full sign-in modal anymore. That
// moved to the web app so logins happen in the right browser.

const SESSION_PLATFORMS = [
  { key: "google",    label: "Google / Gemini", required: true },
  { key: "linkedin",  label: "LinkedIn",        required: true },
  { key: "facebook",  label: "Facebook",        required: false },
  { key: "x",         label: "X (Twitter)",     required: false },
  { key: "instagram", label: "Instagram",       required: false },
];

let sessionState = {};
let sessionPollTimer = null;

function updateSessionsHealthBadge() {
  const badge = $("#sessions-health-badge");
  if (!badge) return;
  const total = SESSION_PLATFORMS.length;
  const connected = SESSION_PLATFORMS.filter(
    (p) => sessionState[p.key] && sessionState[p.key].loggedIn,
  ).length;
  const required = SESSION_PLATFORMS.filter((p) => p.required);
  const requiredConnected = required.filter(
    (p) => sessionState[p.key] && sessionState[p.key].loggedIn,
  ).length;

  badge.classList.remove("ok", "warn", "error");
  let label;
  if (connected === total) {
    badge.classList.add("ok");
    label = `${connected}/${total} connected`;
    badge.title = "All platforms are connected.";
  } else if (requiredConnected === required.length) {
    badge.classList.add("ok");
    label = `${connected}/${total} connected`;
    badge.title = "All required platforms connected. Optional ones can be signed in later from the web app.";
  } else if (connected === 0) {
    badge.classList.add("error");
    label = `0/${total} connected`;
    badge.title = "No platforms connected. Click to open the web app and sign in.";
  } else {
    badge.classList.add("warn");
    label = `${connected}/${total} connected`;
    badge.title = `${total - connected} platform${total - connected === 1 ? "" : "s"} still need sign-in. Click to open the web app.`;
  }
  const labelEl = badge.querySelector(".sessions-badge-label");
  if (labelEl) labelEl.textContent = label;
  badge.classList.remove("hidden");
}

function updateSessionsHealthCard() {
  const card = $("#sessions-health");
  if (!card) return;
  const missing = SESSION_PLATFORMS.filter(
    (p) => !(sessionState[p.key] && sessionState[p.key].loggedIn),
  );
  if (missing.length === 0) {
    card.classList.add("ok");
    card.classList.remove("hidden");
    $("#sessions-health-icon").textContent = "✓";
    $("#sessions-health-title").textContent = "All sessions detected";
    $("#sessions-health-meta").textContent = "LinkedIn, Facebook, Instagram, and Google Gemini are signed in.";
    $("#sessions-health-open").textContent = "View";
  } else {
    card.classList.remove("ok");
    card.classList.remove("hidden");
    $("#sessions-health-icon").textContent = "!";
    $("#sessions-health-title").textContent = "Missing browser sessions";
    const requiredMissing = missing.filter((p) => p.required);
    const label = requiredMissing.length > 0 ? requiredMissing : missing;
    $("#sessions-health-meta").textContent =
      `Sign in to: ${label.map((p) => p.label).join(", ")}. Click to open the web app — the sign-in modal there opens each login inside the automation Chrome.`;
    $("#sessions-health-open").textContent = "Sign in…";
  }
}

async function pollSessionsOnce() {
  try {
    const res = await window.gtss.cdp.checkSessions();
    if (!res || !res.ok || !res.sessions) return;
    // Preserve previously-detected logins (avoid flicker on transient failures).
    const next = {};
    for (const p of SESSION_PLATFORMS) {
      const fresh = res.sessions[p.key];
      const prev = sessionState[p.key];
      if (fresh && fresh.loggedIn) {
        next[p.key] = fresh;
      } else if (prev && prev.loggedIn) {
        next[p.key] = prev;
      } else if (fresh) {
        next[p.key] = fresh;
      }
    }
    sessionState = next;
    updateSessionsHealthCard();
    updateSessionsHealthBadge();
  } catch (_) {
    // Silent — polling failures are expected.
  }
}

function startSessionPolling() {
  if (sessionPollTimer) clearInterval(sessionPollTimer);
  pollSessionsOnce();
  sessionPollTimer = setInterval(pollSessionsOnce, 10000);
}

function stopSessionPolling() {
  if (sessionPollTimer) {
    clearInterval(sessionPollTimer);
    sessionPollTimer = null;
  }
}

// The Control-tab hint card + the topbar badge both open the web app
// when clicked. The full sign-in modal lives there (on the root page)
// and can drive logins inside the CDP Chrome via the bridge server.
$("#sessions-health-open")?.addEventListener("click", async () => {
  // If the server is running, open the web app in the user's default
  // browser (or inside the CDP Chrome if that's where they already are).
  // The sign-in modal will auto-show on the root page if sessions are
  // missing.
  await window.gtss.openInBrowser();
});
$("#sessions-health-badge")?.addEventListener("click", async () => {
  await window.gtss.openInBrowser();
});

// After Start, give the server + CDP a moment to come up, then poll
// sessions and start the slow background poll so the badge stays fresh.
let _postStartPoll = null;
$("#start-btn").addEventListener("click", () => {
  updateSessionsHealthBadge();
  if (_postStartPoll) clearTimeout(_postStartPoll);
  _postStartPoll = setTimeout(async () => {
    _postStartPoll = null;
    await pollSessionsOnce();
    startSessionPolling();
  }, 6000);
});

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

const heroIcon = (state) => {
  const el = $("#hero-icon");
  el.classList.remove("stopped", "starting", "running", "crashed");
  el.classList.add(state);
};

function updateHero(server, cdp) {
  const state = server.state;
  heroIcon(state);

  const labels = {
    stopped: "Stopped",
    starting: "Starting...",
    running: "Running",
    stopping: "Stopping...",
    crashed: "Crashed",
  };
  $("#hero-label").textContent = labels[state] || state;

  if (state === "running") {
    const since = server.startedAt ? new Date(server.startedAt).toLocaleTimeString() : "";
    const cdpInfo = cdp.state === "running"
      ? ` · Chrome CDP on port ${cdp.port} (automation browser, background)`
      : " · CDP inactive (isolated browser mode)";
    $("#hero-meta").textContent = `Server up since ${since} · PID ${server.pid} · http://localhost:${server.port}${cdpInfo}`;
  } else if (state === "starting") {
    $("#hero-meta").textContent =
      "Booting the server... check the Logs tab for live progress. The web app opens in your default browser once the port is ready.";
  } else if (state === "stopping") {
    $("#hero-meta").textContent = "Shutting down...";
  } else if (state === "crashed") {
    $("#hero-meta").textContent = "The server crashed. See the error above.";
  } else {
    $("#hero-meta").textContent = "Click Start to launch the app in your default browser.";
  }

  // Show/hide error card.
  const errorCard = $("#error-card");
  const statusHero = $("#status-hero");
  if (state === "crashed" && server.lastDiagnostic) {
    errorCard.classList.remove("hidden");
    statusHero.classList.add("hidden");
    $("#error-title").textContent = server.lastDiagnostic.title;
    $("#error-message").textContent = server.lastDiagnostic.message;
    $("#error-remedy").textContent = server.lastDiagnostic.remedy || "";
  } else {
    errorCard.classList.add("hidden");
    statusHero.classList.remove("hidden");
  }

  // Button states.
  const isRunning = state === "running";
  const isStarting = state === "starting";
  const isStopped = state === "stopped";
  const isCrashed = state === "crashed";
  // Start is allowed when stopped OR crashed (retry from error). Disabled
  // while starting/running/stopping so the user can't kick off a second
  // boot while the first is in flight.
  $("#start-btn").disabled = !isStopped && !isCrashed;
  // Stop is allowed whenever there's something to stop — including a
  // "starting" state, so the user can cancel a slow boot instead of being
  // forced to wait for the 30s port timeout.
  $("#stop-btn").disabled = !isRunning && !isStarting;
  $("#open-browser-btn").disabled = !isRunning;
  $("#server-restart-btn").disabled = !isRunning;

  // CDP controls.
  $("#cdp-start-btn").disabled = cdp.state === "running";
  $("#cdp-stop-btn").disabled = cdp.state !== "running";

  // If CDP is running, show a small banner so the user knows.
  if (cdp.state === "running") {
    $("#hero-meta").textContent += " · CDP automation browser active (background)";
  }

  // About tab — runtime info.
  $("#about-runtime").textContent = server.nodeRuntime || "—";
}

async function refreshStatus() {
  try {
    const status = await window.gtss.lifecycle.status();
    updateHero(status.server, status.cdp);
  } catch (err) {
    console.error("Status refresh failed:", err);
  }
}

setInterval(refreshStatus, 1500);
refreshStatus();

// ─── Lifecycle buttons ───────────────────────────────────────────────────────

$("#start-btn").addEventListener("click", async () => {
  // Clear any previous error.
  $("#error-card").classList.add("hidden");
  $("#status-hero").classList.remove("hidden");
  toast("Starting the server — the web app opens in your default browser once it's ready.", "info");
  const res = await window.gtss.lifecycle.start();
  if (res.ok) {
    toast("Ready! The web app is open in your default browser.", "success");
  } else {
    toast(`Failed to start: ${res.error}`, "error");
  }
  refreshStatus();
});

$("#stop-btn").addEventListener("click", async () => {
  toast("Stopping server...", "info");
  const res = await window.gtss.lifecycle.stop();
  if (res.ok) {
    toast("Server stopped.", "success");
  } else {
    toast(`Failed to stop: ${res.error}`, "error");
  }
  refreshStatus();
});

$("#open-browser-btn").addEventListener("click", async () => {
  await window.gtss.openInBrowser();
});

// ─── Advanced controls ───────────────────────────────────────────────────────

$("#server-restart-btn").addEventListener("click", async () => {
  toast("Restarting server...", "info");
  const res = await window.gtss.lifecycle.restart();
  if (!res.ok) toast(res.error, "error");
  refreshStatus();
});

$("#cdp-start-btn").addEventListener("click", async () => {
  toast("Starting the CDP automation browser in the background...", "info");
  const res = await window.gtss.cdp.start();
  if (res.ok) {
    toast("CDP started. Automation will use this Chrome (running in the background).", "success");
  } else {
    toast(res.error, "error");
  }
  refreshStatus();
});

$("#cdp-stop-btn").addEventListener("click", async () => {
  const res = await window.gtss.cdp.stop();
  if (!res.ok) toast(res.error, "error");
  refreshStatus();
});

$("#open-data-btn").addEventListener("click", () => window.gtss.open.dataFolder());

$("#open-devtools-btn").addEventListener("click", async () => {
  const res = await window.gtss.lifecycle.openDevtools();
  if (!res.ok) toast(`Couldn't open DevTools: ${res.error}`, "error");
});

// ─── Error card actions ──────────────────────────────────────────────────────

$("#error-retry").addEventListener("click", async () => {
  $("#error-card").classList.add("hidden");
  $("#status-hero").classList.remove("hidden");
  await $("#start-btn").click();
});

$("#error-copy-logs").addEventListener("click", async () => {
  const logs = await window.gtss.logs.snapshot(200);
  const text = logs
    .map((e) => `[${e.ts}] ${e.source}: ${e.line}`)
    .join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast("Last 200 log lines copied to clipboard.", "success");
  } catch (_) {
    toast("Couldn't copy to clipboard. Open the Logs tab instead.", "error");
  }
});

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

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderLogEntry(entry) {
  const cls = entry.source.endsWith("stderr") ? " stderr" : "";
  const sourceCls = entry.source.startsWith("lifecycle") ? " lifecycle" : "";
  const time = new Date(entry.ts).toLocaleTimeString();
  const div = document.createElement("div");
  div.className = `log-line${cls}${sourceCls}`;
  div.innerHTML = `<span class="log-time">${time}</span>
    <span class="log-source">${escapeHtml(entry.source)}</span>
    <span class="log-text">${escapeHtml(entry.line)}</span>`;
  return div;
}

function renderLogs() {
  const visible = logEntries.filter((e) => sourceMatchesFilter(e.source));
  if (visible.length === 0) {
    logsPane.innerHTML = '<div class="logs-empty">No logs match the current filters.</div>';
    return;
  }
  logsPane.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const e of visible) frag.appendChild(renderLogEntry(e));
  logsPane.appendChild(frag);
  logsPane.scrollTop = logsPane.scrollHeight;
}

async function loadInitialLogs() {
  logEntries = await window.gtss.logs.snapshot();
  renderLogs();
}

window.gtss.logs.onLine((entry) => {
  logEntries.push(entry);
  if (logEntries.length > 5000) logEntries.shift();
  if (sourceMatchesFilter(entry.source)) {
    const empty = logsPane.querySelector(".logs-empty");
    if (empty) logsPane.innerHTML = "";
    logsPane.appendChild(renderLogEntry(entry));
    while (logsPane.children.length > 5000) {
      logsPane.removeChild(logsPane.firstChild);
    }
    logsPane.scrollTop = logsPane.scrollHeight;
  }
});

Object.values(filters).forEach((f) => f.addEventListener("change", renderLogs));
$("#logs-clear-btn").addEventListener("click", async () => {
  await window.gtss.logs.clear();
  logEntries = [];
  renderLogs();
});

// ─── About tab ───────────────────────────────────────────────────────────────

$("#about-version").textContent = window.gtss.app.version;
$("#app-version").textContent = `v${window.gtss.app.version}`;
$("#about-platform").textContent = `${window.gtss.app.platform} (${window.gtss.app.isMac ? "macOS" : window.gtss.app.isWindows ? "Windows" : "Linux"})`;

async function loadAboutData() {
  try {
    const status = await window.gtss.lifecycle.status();
    $("#about-runtime").textContent = status.server.nodeRuntime || "—";
  } catch (_) {}
  try {
    const dataFolder = await window.gtss.open.dataFolderInfo();
    if (dataFolder) $("#about-data-folder").textContent = dataFolder;
  } catch (_) {}
}

$("#about-check-updates").addEventListener("click", async () => {
  toast("Checking for updates...", "info");
  try {
    const res = await window.gtss.updater.check();
    if (res && res.ok) {
      const s = res.state || (await window.gtss.updater.status());
      if (s.status === "available") {
        toast(`Update v${s.version} is available.`, "success");
        openUpdateModal();
      } else if (s.status === "idle") {
        toast("You're on the latest version.", "success");
      } else if (s.status === "downloaded") {
        toast(`Update v${s.version} is ready to install.`, "info");
        openUpdateModal();
      }
    } else if (res && !res.ok) {
      toast(`Couldn't check for updates: ${res.error}`, "error");
    }
  } catch (err) {
    toast(`Couldn't check for updates: ${err.message || err}`, "error");
  }
});
$("#about-open-data").addEventListener("click", () => window.gtss.open.dataFolder());

// ─── Updater ─────────────────────────────────────────────────────────────────
//
// State machine driven by window.gtss.updater.onState(). The topbar
// indicator is a compact summary; clicking it opens the full update modal
// which shows release notes, progress bar, and the restart prompt.
//
// Status transitions we care about:
//   idle        → indicator hidden
//   checking    → indicator hidden (too brief to show)
//   available   → green indicator "Update to vX"
//   downloading → blue indicator "Downloading X%"
//   downloaded  → amber indicator "Ready to install"
//   installing  → modal shows "Restarting…" (app quits in ~800ms)
//   error       → red indicator "Update failed" — clicking opens modal with retry

let updaterState = { status: "idle" };
let updateModalOpen = false;

function updateUpdateIndicator(state) {
  updaterState = state;
  const ind = $("#update-indicator");
  if (!ind) return;
  const label = ind.querySelector(".update-label");
  const progressChip = ind.querySelector(".update-progress");
  const dot = ind.querySelector(".update-dot");

  ind.classList.remove("ok", "warn", "error", "busy");
  let visible = true;
  if (state.status === "available") {
    label.textContent = `Update to v${state.version}`;
    ind.classList.add("ok");
    progressChip.classList.add("hidden");
  } else if (state.status === "downloading") {
    label.textContent = "Updating…";
    ind.classList.add("busy");
    progressChip.textContent = `${state.progress || 0}%`;
    progressChip.classList.remove("hidden");
  } else if (state.status === "downloaded") {
    label.textContent = `v${state.version} ready`;
    ind.classList.add("warn");
    progressChip.classList.add("hidden");
  } else if (state.status === "error") {
    label.textContent = "Update failed";
    ind.classList.add("error");
    progressChip.classList.add("hidden");
  } else if (state.status === "installing") {
    label.textContent = "Restarting…";
    ind.classList.add("busy");
    progressChip.classList.add("hidden");
  } else {
    // idle / checking / unknown
    visible = false;
  }

  if (visible) {
    ind.classList.remove("hidden");
  } else {
    ind.classList.add("hidden");
  }

  // If the modal is open, sync its content too.
  if (updateModalOpen) renderUpdateModal(state);

  // Also reflect status in the About tab.
  const aboutStatus = $("#about-update-status");
  if (aboutStatus) aboutStatus.textContent = formatAboutStatus(state);
  const aboutChecked = $("#about-update-checked");
  if (aboutChecked) aboutChecked.textContent = state.lastCheckedAt
    ? new Date(state.lastCheckedAt).toLocaleString()
    : "—";
}

function formatAboutStatus(state) {
  switch (state.status) {
    case "idle":       return "Up to date";
    case "checking":   return "Checking…";
    case "available":  return `v${state.version} available`;
    case "downloading":return `Downloading (${state.progress || 0}%)`;
    case "downloaded": return `v${state.version} ready to install`;
    case "installing": return "Installing…";
    case "error":      return "Update failed";
    default:           return state.status;
  }
}

function formatBytes(n) {
  if (!n || n <= 0) return "0 MB";
  const units = ["B", "KB", "MB", "GB"];
  let v = n, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0) return "—";
  if (seconds < 60) return `${seconds}s left`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s left`;
}

function escapeHtmlForUpdater(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderReleaseNotes(notes) {
  if (!notes) return "";
  // Notes are markdown-ish plain text. Render as preformatted text with
  // light formatting (preserve line breaks, escape HTML to avoid XSS from
  // release-note content).
  return `<div class="release-notes-content">${escapeHtmlForUpdater(notes)}</div>`;
}

function renderUpdateModal(state) {
  const title = $("#update-modal-title");
  const icon = $("#update-status-icon");
  const statusLabel = $("#update-status-label");
  const statusMeta = $("#update-status-meta");
  const currentVer = $("#update-current-version");
  const notesWrap = $("#update-release-notes-wrap");
  const notesEl = $("#update-release-notes");
  const progressWrap = $("#update-progress-wrap");
  const progressFill = $("#update-progress-fill");
  const progressPct = $("#update-progress-pct");
  const progressBytes = $("#update-progress-bytes");
  const progressRate = $("#update-progress-rate");
  const progressEta = $("#update-progress-eta");
  const errorWrap = $("#update-error-wrap");
  const errorMsg = $("#update-error-message");
  const restartWrap = $("#update-restart-wrap");
  const actionBtn = $("#update-modal-action");

  currentVer.textContent = window.gtss.app.version;

  // Reset visibility
  notesWrap.classList.add("hidden");
  progressWrap.classList.add("hidden");
  errorWrap.classList.add("hidden");
  restartWrap.classList.add("hidden");
  actionBtn.disabled = false;

  if (state.status === "available") {
    title.textContent = "Update available";
    icon.textContent = "↓";
    icon.className = "update-status-icon";
    statusLabel.textContent = `Version ${state.version} is available`;
    statusMeta.innerHTML = `Currently on <strong>v${window.gtss.app.version}</strong>${state.releaseDate ? ` · released ${new Date(state.releaseDate).toLocaleDateString()}` : ""}`;
    if (state.releaseNotes) {
      notesEl.innerHTML = renderReleaseNotes(state.releaseNotes);
      notesWrap.classList.remove("hidden");
    }
    actionBtn.textContent = "Download";
    actionBtn.onclick = async () => {
      actionBtn.disabled = true;
      actionBtn.textContent = "Starting…";
      try {
        await window.gtss.updater.download();
      } catch (err) {
        toast(`Download failed: ${err.message || err}`, "error");
        actionBtn.disabled = false;
        actionBtn.textContent = "Retry download";
      }
    };
  } else if (state.status === "downloading") {
    title.textContent = "Downloading update";
    icon.textContent = "↻";
    icon.className = "update-status-icon spinning";
    statusLabel.textContent = "Downloading…";
    statusMeta.textContent = `v${state.version || ""}`;
    progressWrap.classList.remove("hidden");
    progressFill.style.width = `${state.progress || 0}%`;
    progressPct.textContent = `${state.progress || 0}%`;
    progressBytes.textContent = `${formatBytes(state.transferredBytes)} / ${formatBytes(state.totalBytes)}`;
    progressRate.textContent = `${formatBytes(state.bytesPerSecond)}/s`;
    progressEta.textContent = formatEta(state.etaSeconds);
    actionBtn.textContent = "Downloading…";
    actionBtn.disabled = true;
    actionBtn.onclick = null;
  } else if (state.status === "downloaded") {
    title.textContent = "Ready to install";
    icon.textContent = "✓";
    icon.className = "update-status-icon done";
    statusLabel.textContent = `Version ${state.version} is ready`;
    statusMeta.innerHTML = `Click <strong>Install &amp; restart</strong> to apply the update.`;
    restartWrap.classList.remove("hidden");
    if (state.releaseNotes) {
      notesEl.innerHTML = renderReleaseNotes(state.releaseNotes);
      notesWrap.classList.remove("hidden");
    }
    actionBtn.textContent = "Install & restart";
    actionBtn.onclick = async () => {
      actionBtn.disabled = true;
      actionBtn.textContent = "Restarting…";
      try {
        await window.gtss.updater.install();
      } catch (err) {
        toast(`Install failed: ${err.message || err}`, "error");
        actionBtn.disabled = false;
        actionBtn.textContent = "Install & restart";
      }
    };
  } else if (state.status === "installing") {
    title.textContent = "Restarting";
    icon.textContent = "↻";
    icon.className = "update-status-icon spinning";
    statusLabel.textContent = "Installing and restarting…";
    statusMeta.textContent = "The app will relaunch in a moment.";
    actionBtn.textContent = "Restarting…";
    actionBtn.disabled = true;
    actionBtn.onclick = null;
  } else if (state.status === "error") {
    title.textContent = "Update failed";
    icon.textContent = "!";
    icon.className = "update-status-icon error";
    statusLabel.textContent = "The update couldn't be completed";
    statusMeta.textContent = "Check your network connection and try again.";
    errorWrap.classList.remove("hidden");
    errorMsg.textContent = state.error || "Unknown error.";
    actionBtn.textContent = "Retry check";
    actionBtn.onclick = async () => {
      actionBtn.disabled = true;
      actionBtn.textContent = "Checking…";
      try {
        await window.gtss.updater.check();
      } catch (err) {
        toast(`Check failed: ${err.message || err}`, "error");
        actionBtn.disabled = false;
        actionBtn.textContent = "Retry check";
      }
    };
  } else if (state.status === "checking") {
    title.textContent = "Checking for updates";
    icon.textContent = "↻";
    icon.className = "update-status-icon spinning";
    statusLabel.textContent = "Contacting the release server…";
    statusMeta.textContent = "This usually takes a few seconds.";
    actionBtn.textContent = "Checking…";
    actionBtn.disabled = true;
    actionBtn.onclick = null;
  } else {
    // idle / not-available
    title.textContent = "You're up to date";
    icon.textContent = "✓";
    icon.className = "update-status-icon done";
    statusLabel.textContent = "You're on the latest version.";
    statusMeta.innerHTML = `Version <strong>v${window.gtss.app.version}</strong>`;
    actionBtn.textContent = "Check again";
    actionBtn.onclick = async () => {
      actionBtn.disabled = true;
      actionBtn.textContent = "Checking…";
      try { await window.gtss.updater.check(); } catch (_) {}
      actionBtn.disabled = false;
      actionBtn.textContent = "Check again";
    };
  }
}

function openUpdateModal() {
  const backdrop = $("#update-modal-backdrop");
  if (!backdrop) return;
  updateModalOpen = true;
  backdrop.classList.remove("hidden");
  renderUpdateModal(updaterState);
}

function closeUpdateModal() {
  const backdrop = $("#update-modal-backdrop");
  if (!backdrop) return;
  updateModalOpen = false;
  backdrop.classList.add("hidden");
}

$("#update-indicator")?.addEventListener("click", () => {
  openUpdateModal();
});
$("#update-modal-close")?.addEventListener("click", closeUpdateModal);
$("#update-modal-cancel")?.addEventListener("click", closeUpdateModal);
$("#update-modal-backdrop")?.addEventListener("click", (e) => {
  // Click on the backdrop (not the modal itself) closes the modal.
  if (e.target === e.currentTarget) closeUpdateModal();
});

// Initial state poll — populates the About tab + indicator on launch.
(async () => {
  try {
    const s = await window.gtss.updater.status();
    if (s) updateUpdateIndicator(s);
  } catch (_) {}
})();

window.gtss.updater.onState(updateUpdateIndicator);

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
refreshStatus();
loadAboutData();
// Kick off an initial sessions poll so the topbar badge populates as
// soon as the launcher window opens (in case CDP is already running
// from a previous session and the sessions are already detectable).
// The poll is async and silent on failure — no UI disruption if CDP
// isn't up yet.
pollSessionsOnce().catch(() => {});
// Render the badge in its initial "—" state immediately so it doesn't
// flash empty before the first poll resolves. updateSessionsHealthBadge()
// will replace it as soon as pollSessionsOnce returns.
updateSessionsHealthBadge();
