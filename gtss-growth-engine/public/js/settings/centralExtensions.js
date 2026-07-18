/**
 * settings/centralExtensions.js — Centralized behavior toggles (Message
 * Generation Source + Scheduler Pause).
 *
 * Originally part of public/js/settings.js. These were previously only
 * configurable on /messages and /scheduler pages; they were centralized
 * on the settings page so the user has one place to manage every global
 * behavior switch.
 *
 * Functions:
 *   - bindCentralizedExtensions()       — wire up the message-source save
 *                                         button + the msg-source radio
 *                                         change listener + the scheduler
 *                                         pause toggle; then load the
 *                                         initial state of each.
 *   - loadMessageSource()               — GET /api/settings, check the
 *                                         matching msg-source radio.
 *   - updateMsgSourceSegmentedVisual()  — toggle the .is-checked class on
 *                                         the segmented control's labels
 *                                         to match the checked radio.
 *   - saveMessageSource()               — PATCH the radio-selected value
 *                                         (ai / template) to /api/settings.
 *   - loadSchedulerPaused()             — GET /api/scheduler/pause, apply
 *                                         the visual state; silent on
 *                                         failure (the scheduler may not
 *                                         be reachable on every page load).
 *   - applySchedulerState(paused)       — pure UI: set the toggle, the
 *                                         status pill text + classes, and
 *                                         the toggle label.
 *   - saveSchedulerPaused(paused)       — apply visual optimistically, then
 *                                         PATCH /api/scheduler/pause; revert
 *                                         the visual state on failure.
 *
 * Depends on the `setInline` global declared in helpers.js.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Centralized extensions — Message Generation Source + Scheduler Pause toggle.
// These were previously only configurable on /messages and /scheduler pages;
// they are now centralized on the settings page so the user has one place to
// manage every global behavior switch.
// ─────────────────────────────────────────────────────────────────────────────

function bindCentralizedExtensions() {
  // Message Generation Source
  const msgSourceSave = document.getElementById("save-msg-source");
  if (msgSourceSave) {
    msgSourceSave.addEventListener("click", saveMessageSource);
  }

  // Storage cleanup — run the same jobs as the nightly crons, immediately.
  document
    .getElementById("run-cleanup-artifacts")
    ?.addEventListener("click", () => runMaintenanceCleanup(["artifacts"]));
  document
    .getElementById("run-cleanup-orphans")
    ?.addEventListener("click", () => runMaintenanceCleanup(["orphan_uploads"]));
  document
    .getElementById("run-cleanup-all")
    ?.addEventListener("click", () =>
      runMaintenanceCleanup(["artifacts", "orphan_uploads"]),
    );
  // Update segmented control visual state on change
  document.querySelectorAll('input[name="msg-source"]').forEach((radio) => {
    radio.addEventListener("change", () => updateMsgSourceSegmentedVisual());
  });

  // Scheduler pause toggle
  const schedulerToggle = document.getElementById("scheduler-paused-toggle");
  if (schedulerToggle) {
    schedulerToggle.addEventListener("change", () =>
      saveSchedulerPaused(schedulerToggle.checked),
    );
  }

  // Load initial states (non-blocking)
  loadMessageSource();
  loadSchedulerPaused();
}

async function loadMessageSource() {
  try {
    const settings = await window.gtss.fetchJSON("/api/settings");
    const value = settings.message_generation_source || "ai";
    const aiRadio = document.getElementById("msg-source-ai");
    const tplRadio = document.getElementById("msg-source-template");
    if (aiRadio && tplRadio) {
      if (value === "template") {
        tplRadio.checked = true;
      } else {
        aiRadio.checked = true;
      }
      updateMsgSourceSegmentedVisual();
    }
  } catch (err) {
    // silent — the section is non-critical
  }
}

function updateMsgSourceSegmentedVisual() {
  const aiRadio = document.getElementById("msg-source-ai");
  const aiLabel = document.getElementById("msg-source-ai-label");
  const tplLabel = document.getElementById("msg-source-template-label");
  if (!aiRadio || !aiLabel || !tplLabel) return;
  aiLabel.classList.toggle("is-checked", aiRadio.checked);
  tplLabel.classList.toggle("is-checked", !aiRadio.checked);
}

async function saveMessageSource() {
  const checked = document.querySelector('input[name="msg-source"]:checked');
  const value = checked ? checked.value : "ai";
  try {
    await window.gtss.fetchJSON("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message_generation_source: value }),
    });
    setInline(
      "msg-source-result",
      value === "template"
        ? "✓ Messages will use canonical templates"
        : "✓ Messages will be generated by Gemini AI",
      "success",
    );
    window.gtss.showToast("Message source saved", "success");
  } catch (err) {
    setInline("msg-source-result", `✗ ${err.message}`, "error");
  }
}

async function loadSchedulerPaused() {
  try {
    const data = await window.gtss.fetchJSON("/api/scheduler/pause");
    applySchedulerState(Boolean(data.paused));
  } catch (err) {
    // Scheduler API may not be reachable on every page load — silent.
    applySchedulerState(false);
  }
}

function applySchedulerState(paused) {
  const toggle = document.getElementById("scheduler-paused-toggle");
  const pill = document.getElementById("scheduler-status-pill");
  const toggleLabel = document.getElementById("scheduler-toggle-label");
  if (toggle) toggle.checked = paused;
  if (pill) {
    pill.textContent = paused ? "Paused" : "Active";
    pill.classList.toggle("is-active", !paused);
    pill.classList.toggle("is-paused", paused);
  }
  if (toggleLabel) {
    toggleLabel.textContent = paused ? "Paused" : "Active";
  }
}

async function saveSchedulerPaused(paused) {
  applySchedulerState(paused);
  try {
    await window.gtss.fetchJSON("/api/scheduler/pause", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused }),
    });
    setInline(
      "scheduler-status-result",
      paused ? "✓ Scheduler paused" : "✓ Scheduler resumed",
      "success",
    );
    window.gtss.showToast(
      paused ? "Scheduler paused" : "Scheduler resumed",
      "success",
    );
  } catch (err) {
    setInline("scheduler-status-result", `✗ ${err.message}`, "error");
    // Revert the visual state on failure
    applySchedulerState(!paused);
  }
}

/**
 * Trigger cleanup jobs immediately (same functions the nightly crons use).
 * @param {string[]} targets - 'artifacts' and/or 'orphan_uploads'
 */
async function runMaintenanceCleanup(targets) {
  const force = Boolean(document.getElementById("cleanup-force")?.checked);
  const buttons = [
    "run-cleanup-artifacts",
    "run-cleanup-orphans",
    "run-cleanup-all",
  ]
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  buttons.forEach((btn) => {
    btn.disabled = true;
  });
  setInline("cleanup-result", "Running cleanup…", "info");

  try {
    const data = await window.gtss.fetchJSON("/api/maintenance/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets, force }),
    });

    const parts = [];
    if (data.artifacts) {
      const a = data.artifacts;
      const mb = ((a.deletedBytes || 0) / (1024 * 1024)).toFixed(2);
      parts.push(
        `artifacts: deleted ${a.deletedFiles || 0} file(s) (${mb} MB)`,
      );
    }
    if (data.orphan_uploads) {
      const o = data.orphan_uploads;
      parts.push(
        `orphan uploads: deleted ${o.deleted || 0}, kept ${o.kept || 0}`,
      );
    }
    const summary =
      parts.length > 0
        ? `✓ Cleanup finished${force ? " (force)" : ""} — ${parts.join("; ")}`
        : "✓ Cleanup finished (nothing to remove)";

    setInline("cleanup-result", summary, "success");
    window.gtss.showToast("Cleanup finished", "success");
  } catch (err) {
    setInline("cleanup-result", `✗ ${err.message}`, "error");
    window.gtss.showToast(err.message, "error");
  } finally {
    buttons.forEach((btn) => {
      btn.disabled = false;
    });
  }
}
