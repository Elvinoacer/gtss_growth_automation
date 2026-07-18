/**
 * settings/accountHandlers.js — Event binding + account/credential save
 * handlers.
 *
 * Originally part of public/js/settings.js. Holds:
 *   - bindEvents()                 — attach all top-level click/change
 *                                    listeners for the core Settings
 *                                    sections (Gemini, Gmail, browser-mode,
 *                                    limits, passphrase, templates,
 *                                    clear-data, notifications, IG
 *                                    settings, pipeline-reliability, plus
 *                                    the delegated click handler for
 *                                    template-tab / variable-badge /
 *                                    auth-platform / clear-platform
 *                                    buttons).
 *   - savePipelineReliability()    — PATCH the 4 reliability knobs
 *                                    (retry_max_attempts, retry_delay_preset,
 *                                    content_asset_source,
 *                                    content_library_media_type).
 *   - togglePassword(input, btn)   — toggle a password input between
 *                                    type="password" / "text" and flip
 *                                    the button label.
 *   - saveGemini() / testGemini()  — POST the Gemini API key / trigger
 *                                    a test call.
 *   - BRIDGE_PORTS / findBridgeBase() — probe the desktop launcher's
 *                                    bridge HTTP server on ports
 *                                    9224–9227 to find the one that
 *                                    answers /api/bridge/health.
 *   - loadBrowserMode()            — read CDP_VISIBLE_DEFAULT from the
 *                                    bridge and check the matching radio.
 *   - saveBrowserMode()            — POST the radio-selected mode to
 *                                    the bridge.
 *   - saveGmail() / testEmail()    — POST Gmail creds / trigger a test
 *                                    email.
 *   - saveLimits()                 — PATCH the collected limits table.
 *   - saveNotifications()          — PATCH the notification checkboxes.
 *
 * Depends on the globals declared in state.js + helpers.js +
 * settingsLoad.js (for setInline, renderLimits, collectLimits,
 * collectNotifications, settingsState, loadBrowserMode is also called
 * from bindEvents).
 */

function bindEvents() {
  document
    .getElementById("toggle-gemini")
    .addEventListener("click", () =>
      togglePassword("gemini-key", "toggle-gemini"),
    );
  document
    .getElementById("toggle-gmail")
    .addEventListener("click", () =>
      togglePassword("gmail-password", "toggle-gmail"),
    );
  document.getElementById("save-gemini").addEventListener("click", saveGemini);
  document.getElementById("test-gemini").addEventListener("click", testGemini);
  document.getElementById("save-gmail").addEventListener("click", saveGmail);
  document.getElementById("test-email").addEventListener("click", testEmail);

  // ─── Automation Browser visibility setting ───────────────────────────
  //
  // Reads/writes CDP_VISIBLE_DEFAULT via the bridge HTTP server
  // (desktop/main/bridge-server.js, port 9224). The setting controls
  // whether the CDP Chrome runs visibly or in the background on normal
  // Starts. Saving also restarts launcher-owned CDP Chrome immediately, so
  // the desktop app itself never needs to restart for the change to apply.
  const saveBrowserModeBtn = document.getElementById("save-browser-mode");
  if (saveBrowserModeBtn) {
    saveBrowserModeBtn.addEventListener("click", saveBrowserMode);
  }
  const reopenLink = document.getElementById("reopen-signin-modal-link");
  if (reopenLink) {
    reopenLink.addEventListener("click", (e) => {
      e.preventDefault();
      // Navigate to the dashboard — the sign-in modal auto-shows there
      // if sessions are missing, and window.gtss.openSigninModal() is
      // available once signin-modal.js has loaded.
      window.location.href = "/";
    });
  }
  // Load the current mode from the bridge (if reachable) so the radio
  // reflects the persisted state.
  loadBrowserMode();
  document
    .getElementById("reset-limits")
    .addEventListener("click", () => renderLimits(settingsState.loadedLimits));
  document.getElementById("save-limits").addEventListener("click", saveLimits);
  document
    .getElementById("change-passphrase")
    .addEventListener("click", changePassphrase);
  document
    .getElementById("template-editor")
    .addEventListener("input", updateCharCount);
  document
    .getElementById("save-template")
    .addEventListener("click", saveTemplate);
  document
    .getElementById("reset-template")
    .addEventListener("click", resetTemplate);
  document
    .getElementById("apply-template-all")
    .addEventListener("click", applyTemplateToAll);
  document
    .getElementById("delete-confirmation")
    .addEventListener("input", (event) => {
      document.getElementById("clear-data").disabled =
        event.target.value !== "DELETE";
    });
  document.getElementById("clear-data").addEventListener("click", clearData);
  document.querySelectorAll(".notification-checkbox").forEach((checkbox) => {
    checkbox.addEventListener("change", saveNotifications);
  });
  document
    .getElementById("save-instagram-settings")
    .addEventListener("click", saveInstagramSettings);
  const pipelineReliabilityButton = document.getElementById(
    "save-pipeline-reliability",
  );
  if (pipelineReliabilityButton) {
    pipelineReliabilityButton.addEventListener("click", savePipelineReliability);
  }
  document.addEventListener("click", async (event) => {
    const templateButton = event.target.closest("[data-template-key]");
    const variableButton = event.target.closest("[data-variable]");
    const authButton = event.target.closest("[data-auth-platform]");
    const clearButton = event.target.closest("[data-clear-platform]");
    if (templateButton) {
      settingsState.activeTemplate = templateButton.dataset.templateKey;
      renderTemplateTabs();
      renderTemplateEditor();
    }
    if (variableButton)
      insertAtCursor(
        document.getElementById("template-editor"),
        variableButton.dataset.variable,
      );
    if (authButton) authenticatePlatform(authButton);
    if (clearButton) clearPlatform(clearButton.dataset.clearPlatform);
  });
}

async function savePipelineReliability() {
  try {
    await window.gtss.fetchJSON("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({
        retry_max_attempts: document.getElementById("retry_max_attempts").value,
        retry_delay_preset: document.getElementById("retry_delay_preset").value,
        content_asset_source: document.getElementById("content_asset_source").value,
        content_library_media_type: document.getElementById(
          "content_library_media_type",
        ).value,
      }),
    });
    setInline("pipeline-reliability-result", "Pipeline settings saved", "success");
  } catch (error) {
    setInline("pipeline-reliability-result", error.message, "error");
  }
}

function togglePassword(inputId, buttonId) {
  const input = document.getElementById(inputId);
  const isPassword = input.type === "password";
  input.type = isPassword ? "text" : "password";
  document.getElementById(buttonId).textContent = isPassword ? "Hide" : "Show";
}

async function saveGemini() {
  await window.gtss.fetchJSON("/api/settings/gemini-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: document.getElementById("gemini-key").value,
    }),
  });
  window.gtss.showToast("Gemini key saved", "success");
}

async function testGemini() {
  const result = await window.gtss.fetchJSON("/api/settings/test-gemini", {
    method: "POST",
  });
  setInline(
    "gemini-result",
    result.valid ? "✓ Valid" : `✗ Invalid: ${result.error}`,
    result.valid ? "success" : "error",
  );
}

// ─── Automation Browser visibility (bridge) ──────────────────────────────
//
// The bridge HTTP server (desktop/main/bridge-server.js) lets the web app
// read/write the CDP_VISIBLE_DEFAULT setting that lives in .env. We probe
// ports 9224–9227 (the bridge auto-increments if 9224 is taken) and use
// the first one that answers /api/bridge/health.
const BRIDGE_PORTS = [9224, 9225, 9226, 9227];

async function findBridgeBase() {
  for (const port of BRIDGE_PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/bridge/health`);
      if (res.ok) return `http://127.0.0.1:${port}`;
    } catch (_) {
      // try next
    }
  }
  return null;
}

async function loadBrowserMode() {
  const bgRadio = document.getElementById("browser-mode-background");
  const visRadio = document.getElementById("browser-mode-visible");
  const resultEl = document.getElementById("browser-mode-result");
  if (!bgRadio || !visRadio) return;
  try {
    const base = await findBridgeBase();
    if (!base) {
      // Bridge not running (standalone server). Disable the controls and
      // explain — the user needs the GTSS launcher for this setting.
      bgRadio.disabled = true;
      visRadio.disabled = true;
      const saveBtn = document.getElementById("save-browser-mode");
      if (saveBtn) saveBtn.disabled = true;
      if (resultEl) {
        setInline(
          "browser-mode-result",
          "Launcher not running — start the GTSS app to configure this.",
          "warning",
        );
      }
      return;
    }
    const res = await fetch(`${base}/api/bridge/settings/browser-mode`);
    const data = await res.json();
    if (data && data.mode === "visible") {
      visRadio.checked = true;
    } else {
      bgRadio.checked = true;
    }
  } catch (_) {
    // Leave default (background) checked.
  }
}

async function saveBrowserMode() {
  const visRadio = document.getElementById("browser-mode-visible");
  const mode = visRadio && visRadio.checked ? "visible" : "background";
  try {
    const base = await findBridgeBase();
    if (!base) {
      window.gtss.showToast(
        "Launcher not running — start the GTSS app to change this setting.",
        "error",
      );
      return;
    }
    const res = await fetch(`${base}/api/bridge/settings/browser-mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    const data = await res.json();
    if (data && data.ok) {
      const applied = data.applied === true;
      const resultMessage = applied
        ? mode === "visible"
          ? "✓ Chrome restarted visibly — GTSS stays running"
          : "✓ Chrome restarted in the background — GTSS stays running"
        : data.message || "✓ Saved — this mode will be used when Chrome next starts";
      setInline(
        "browser-mode-result",
        resultMessage,
        "success",
      );
      window.gtss.showToast(
        applied
          ? `Browser mode changed to ${mode}. Automation Chrome restarted; the app stayed running.`
          : `Browser mode saved as ${mode}. ${data.message || "It will apply when Chrome next starts."}`,
        "success",
      );
    } else {
      setInline(
        "browser-mode-result",
        `✗ ${data.error || "Could not save"}`,
        "error",
      );
    }
  } catch (err) {
    setInline("browser-mode-result", `✗ ${err.message}`, "error");
  }
}

async function saveGmail() {
  await window.gtss.fetchJSON("/api/settings/gmail", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: document.getElementById("gmail-user").value,
      appPassword: document.getElementById("gmail-password").value,
    }),
  });
  window.gtss.showToast("Gmail settings saved", "success");
}

async function testEmail() {
  try {
    await window.gtss.fetchJSON("/api/settings/test-email", { method: "POST" });
    setInline("email-result", "✓ Test email sent", "success");
  } catch (error) {
    setInline("email-result", `✗ ${error.message}`, "error");
  }
}

async function saveLimits() {
  await window.gtss.fetchJSON("/api/settings/limits", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(collectLimits()),
  });
  window.gtss.showToast("Limits saved", "success");
}

async function saveNotifications() {
  await window.gtss.fetchJSON("/api/settings/notifications", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(collectNotifications()),
  });
  window.gtss.showToast("Notification setting saved", "success");
}
