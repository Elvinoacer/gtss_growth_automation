/**
 * renderer/updater.js — auto-updater indicator + modal state machine.
 *
 * Driven entirely by window.gtss.updater.onState(). The topbar indicator
 * is a compact summary; clicking it opens the full update modal which
 * shows release notes, progress bar, and the restart prompt.
 *
 * Status transitions we care about:
 *   idle        → indicator hidden
 *   checking    → indicator hidden (too brief to show)
 *   available   → green indicator "Update to vX"
 *   downloading → blue indicator "Downloading X%"
 *   downloaded  → amber indicator "Ready to install"
 *   installing  → modal shows "Restarting…" (app quits in ~800ms)
 *   error       → red indicator "Update failed" — clicking opens modal with retry
 *
 * The modal mirrors the same state via renderUpdateModal(state). The modal
 * action button (Download / Install & restart / Retry check / Check again)
 * is rebound on every state transition.
 *
 * Extracted from the original renderer.js for maintainability.
 */

/* global window */

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
