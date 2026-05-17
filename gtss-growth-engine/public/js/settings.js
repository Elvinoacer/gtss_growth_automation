const variables = [
  "{{lead_name}}",
  "{{role}}",
  "{{company}}",
  "{{location}}",
  "{{product}}",
  "{{pain_point}}",
];
let settingsState = {
  settings: {},
  templates: {},
  activeTemplate: "",
  loadedLimits: {},
};

function platformLabel(platform) {
  return (
    settingsState.settings.platformLabels?.[platform] ||
    window.gtss.formatPlatformLabel(platform) ||
    platform
  );
}

function formatTemplateLabel(key) {
  if (key === "follow_up") return "Follow-up";
  return String(key || "")
    .split("_")
    .filter(Boolean)
    .map((part) => {
      if (part === "linkedin") return "LinkedIn";
      if (part === "dm") return "DM";
      if (part === "x") return "X";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function getLimitFieldOrder(data) {
  const configured = settingsState.settings.limitFields;
  if (Array.isArray(configured) && configured.length > 0) {
    return configured;
  }

  const fields = [];
  const seen = new Set();
  Object.values(data || {}).forEach((platformLimits) => {
    Object.keys(platformLimits || {}).forEach((field) => {
      if (seen.has(field)) return;
      seen.add(field);
      fields.push(field);
    });
  });
  return fields;
}

function confirmModal(message) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById("confirm-backdrop");
    document.getElementById("confirm-message").textContent = message;
    backdrop.classList.add("visible");
    const cleanup = (value) => {
      backdrop.classList.remove("visible");
      ok.onclick = null;
      cancel.onclick = null;
      resolve(value);
    };
    const ok = document.getElementById("confirm-ok");
    const cancel = document.getElementById("confirm-cancel");
    ok.onclick = () => cleanup(true);
    cancel.onclick = () => cleanup(false);
  });
}

function setInline(id, message, type) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.className = `inline-result ${type || ""}`;
}

async function loadSettings() {
  settingsState.settings = await window.gtss.fetchJSON("/api/settings");
  settingsState.templates = await window.gtss.fetchJSON(
    "/api/settings/templates",
  );
  settingsState.loadedLimits = JSON.parse(
    JSON.stringify(settingsState.settings.limits || {}),
  );
  if (
    !settingsState.activeTemplate ||
    !settingsState.templates[settingsState.activeTemplate]
  ) {
    settingsState.activeTemplate =
      Object.keys(settingsState.templates)[0] || "";
  }
  document.getElementById("app-version").textContent =
    `App Version: ${settingsState.settings.appVersion}`;
  document.getElementById("gemini-key").value =
    settingsState.settings.gemini_api_key || "";
  document.getElementById("gmail-user").value =
    settingsState.settings.gmail_user || "";
  document.getElementById("gmail-password").value =
    settingsState.settings.gmail_app_password || "";
  applyNotifications(settingsState.settings.notification_settings || {});
  renderLimits(settingsState.settings.limits || {});
  renderTemplateTabs();
  renderTemplateEditor();
}

async function loadSessions() {
  const sessions = await window.gtss.fetchJSON("/api/sessions/details");
  const grid = document.getElementById("session-grid");
  grid.innerHTML = Object.entries(sessions)
    .map(([platform, session]) => {
      const status = session.status || "not_connected";
      const label =
        status === "active"
          ? "Active"
          : status === "expired"
            ? "Expired"
            : "Not Connected";
      return `
      <article class="settings-card session-card">
        <h3>${platformLabel(platform)}</h3>
        <span class="status-badge status-${status}">${label}</span>
        <span class="muted">Last active: ${session.last_active ? new Date(session.last_active).toLocaleString() : "Never"}</span>
        <button class="primary-button" data-auth-platform="${platform}" type="button">Login / Re-authenticate</button>
        <button class="secondary-button" data-clear-platform="${platform}" type="button">Clear Session</button>
      </article>
    `;
    })
    .join("");
}

function renderLimits(data) {
  const platforms =
    settingsState.settings.platformKeys || Object.keys(data || {});
  const fields = getLimitFieldOrder(data);
  const headerRow = document.querySelector(".limits-table thead tr");
  if (headerRow) {
    headerRow.innerHTML = [
      "<th>Platform</th>",
      ...fields.map(
        (field) =>
          `<th>${field === "connections" ? "Connections/Requests" : field.charAt(0).toUpperCase() + field.slice(1)}</th>`,
      ),
    ].join("");
  }

  document.getElementById("limits-body").innerHTML = platforms
    .map(
      (platform) => `
    <tr>
      <td>${platformLabel(platform)}</td>
      ${fields
        .map((field) => {
          const hasField =
            data[platform] &&
            Object.prototype.hasOwnProperty.call(data[platform], field);
          return hasField
            ? `<td><input data-limit-platform="${platform}" data-limit-field="${field}" type="number" min="1" value="${data[platform][field]}"></td>`
            : '<td class="muted">-</td>';
        })
        .join("")}
    </tr>
  `,
    )
    .join("");
}

function collectLimits() {
  const next = {};
  document.querySelectorAll("[data-limit-platform]").forEach((input) => {
    if (!next[input.dataset.limitPlatform]) {
      next[input.dataset.limitPlatform] = {};
    }
    next[input.dataset.limitPlatform][input.dataset.limitField] = Number(
      input.value,
    );
  });
  return next;
}

function applyNotifications(settings) {
  document.querySelectorAll(".notification-checkbox").forEach((checkbox) => {
    checkbox.checked = Boolean(settings[checkbox.dataset.key]);
  });
}

function collectNotifications() {
  const settings = {};
  document.querySelectorAll(".notification-checkbox").forEach((checkbox) => {
    settings[checkbox.dataset.key] = checkbox.checked;
  });
  return settings;
}

function renderTemplateTabs() {
  const templateKeys = Object.keys(settingsState.templates);
  if (!templateKeys.includes(settingsState.activeTemplate)) {
    settingsState.activeTemplate = templateKeys[0] || "";
  }

  document.getElementById("template-tabs").innerHTML = templateKeys
    .map(
      (key) =>
        `<button class="tab-button ${settingsState.activeTemplate === key ? "active" : ""}" data-template-key="${key}" type="button">${formatTemplateLabel(key)}</button>`,
    )
    .join("");
}

function renderTemplateEditor() {
  const editor = document.getElementById("template-editor");
  editor.value = settingsState.templates[settingsState.activeTemplate] || "";
  updateCharCount();
  document.getElementById("variable-badges").innerHTML = variables
    .map(
      (variable) =>
        `<button class="variable-badge" data-variable="${variable}" type="button">${variable}</button>`,
    )
    .join("");
}

function updateCharCount() {
  document.getElementById("char-count").textContent =
    `${document.getElementById("template-editor").value.length} chars`;
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.value = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
  updateCharCount();
}

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

async function saveTemplate() {
  const template = document.getElementById("template-editor").value;
  await window.gtss.fetchJSON(
    `/api/settings/templates/${settingsState.activeTemplate}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template }),
    },
  );
  settingsState.templates[settingsState.activeTemplate] = template;
  window.gtss.showToast("Template saved", "success");
}

async function resetTemplate() {
  const result = await window.gtss.fetchJSON(
    `/api/settings/templates/${settingsState.activeTemplate}/reset`,
    { method: "POST" },
  );
  settingsState.templates[settingsState.activeTemplate] = result.template;
  renderTemplateEditor();
  window.gtss.showToast("Template reset", "success");
}

async function applyTemplateToAll() {
  const btn = document.getElementById("apply-template-all");

  // First, save the current editor content for ALL platform templates
  const template = document.getElementById("template-editor").value;
  if (!template.trim()) {
    window.gtss.showToast("Template is empty — write your message first", "error");
    return;
  }

  if (!(await confirmModal(
    `This will save this template to ALL platforms and overwrite ALL ${settingsState.templates ? 'existing' : ''} message bodies in the system. Continue?`
  ))) return;

  btn.disabled = true;
  btn.textContent = "⏳ Applying...";
  setInline("template-apply-result", "Saving template to all platforms...", "");

  try {
    // Save the template to every platform key
    const platformKeys = Object.keys(settingsState.templates);
    for (const key of platformKeys) {
      await window.gtss.fetchJSON(`/api/settings/templates/${key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template }),
      });
      settingsState.templates[key] = template;
    }

    // Now apply to all existing messages
    setInline("template-apply-result", "Updating all existing messages...", "");
    const result = await window.gtss.fetchJSON("/api/settings/templates/apply-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    setInline(
      "template-apply-result",
      `✓ Updated ${result.updated}/${result.total} messages across all platforms`,
      "success",
    );
    window.gtss.showToast(`Applied template to ${result.updated} messages`, "success");
    renderTemplateTabs();
  } catch (error) {
    setInline("template-apply-result", `Failed: ${error.message}`, "error");
    window.gtss.showToast(error.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "⟳ Apply to All Messages";
  }
}

async function changePassphrase() {
  try {
    await window.gtss.fetchJSON("/api/settings/passphrase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassphrase: document.getElementById("current-passphrase").value,
        newPassphrase: document.getElementById("new-passphrase").value,
        confirmPassphrase: document.getElementById("confirm-passphrase").value,
      }),
    });
    setInline("passphrase-result", "Passphrase changed", "success");
  } catch (error) {
    setInline("passphrase-result", error.message, "error");
  }
}

async function clearData() {
  if (document.getElementById("delete-confirmation").value !== "DELETE") return;
  if (
    !(await confirmModal("Are you absolutely sure? This deletes everything."))
  )
    return;
  await window.gtss.fetchJSON("/api/settings/clear-data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation: "DELETE" }),
  });
  window.gtss.showToast("All data cleared", "success");
  document.getElementById("delete-confirmation").value = "";
  document.getElementById("clear-data").disabled = true;
}

async function authenticatePlatform(button) {
  const platform = button.dataset.authPlatform;
  button.disabled = true;
  button.textContent = "Opening browser...";
  try {
    await window.gtss.fetchJSON(`/api/sessions/authenticate/${platform}`, {
      method: "POST",
    });
    window.gtss.showToast(
      `${platformLabel(platform)} session saved`,
      "success",
    );
    await loadSessions();
    window.gtss.updateSessionDots();
  } catch (error) {
    window.gtss.showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Login / Re-authenticate";
  }
}

async function clearPlatform(platform) {
  if (!(await confirmModal(`Clear ${platformLabel(platform)} session?`)))
    return;
  await window.gtss.fetchJSON(`/api/sessions/clear/${platform}`, {
    method: "POST",
  });
  await loadSessions();
  window.gtss.updateSessionDots();
}

// ---------------------------------------------------------------------------
// Pipeline Settings
// ---------------------------------------------------------------------------

let pipelineState = {
  config: {},
  keywords: { keywords: [], platforms: [], maxLeadsPerKeyword: 10 },
  runs: [],
};

async function loadPipelineSettings() {
  try {
    const [config, keywords, runs] = await Promise.all([
      window.gtss.fetchJSON("/api/settings/pipeline"),
      window.gtss.fetchJSON("/api/discovery/keywords"),
      window.gtss.fetchJSON("/api/pipeline/runs?limit=5"),
    ]);
    pipelineState.config = config;
    pipelineState.keywords = keywords;
    pipelineState.runs = runs;
    applyPipelineConfig(config);
    renderKeywords(keywords);
    renderPipelineRuns(runs);
  } catch (error) {
    console.error("Failed to load pipeline settings:", error);
  }
}

function applyPipelineConfig(config) {
  document.getElementById("pipeline-mode").value = config.pipelineMode || "ai";
  document.getElementById("pipeline-auto-approve").value = config.autoApproveVariant || "B";
  document.getElementById("pipeline-cron").value = config.pipelineCron || "0 8 * * *";
  document.getElementById("discovery-mode").value = config.discoveryMode || "";
  document.getElementById("qualification-mode").value = config.qualificationMode || "";
  document.getElementById("message-mode").value = config.messageMode || "";
  document.getElementById("qualification-threshold").value = config.qualificationThreshold ?? 50;
  document.getElementById("qualification-manual-score").value = config.qualificationManualScore ?? 75;
}

function renderKeywords(data) {
  const list = document.getElementById("keywords-list");
  if (!data.keywords || data.keywords.length === 0) {
    list.innerHTML = '<span class="muted">No keywords configured.</span>';
    return;
  }
  list.innerHTML = data.keywords.map((kw, idx) => `
    <div style="display: flex; align-items: center; gap: 8px;">
      <span style="flex: 1; color: var(--gtss-text); font-size: 13px;">${idx + 1}. ${kw}</span>
      <button class="secondary-button" data-remove-keyword="${idx}" type="button" style="min-height: 30px; padding: 0 8px; font-size: 12px;">✕</button>
    </div>
  `).join("");
}

function renderPipelineRuns(runs) {
  const body = document.getElementById("pipeline-runs-body");
  if (!runs || runs.length === 0) {
    body.innerHTML = '<tr><td colspan="9" class="muted" style="text-align: center;">No pipeline runs yet</td></tr>';
    return;
  }
  body.innerHTML = runs.map(run => {
    const s = run.stages || {};
    const statusClass = run.status === "completed" ? "color: var(--gtss-success)" : run.status === "failed" ? "color: var(--gtss-danger)" : "color: var(--gtss-warning, #f59e0b)";
    return `<tr>
      <td>${run.id}</td>
      <td>${run.trigger}</td>
      <td>${run.mode}</td>
      <td style="${statusClass}; font-weight: 800;">${run.status}</td>
      <td>${run.started_at ? new Date(run.started_at).toLocaleString() : "-"}</td>
      <td>${s.discovery ? `${s.discovery.newLeads || 0} new` : "-"}</td>
      <td>${s.qualification ? `${s.qualification.qualified || 0}` : "-"}</td>
      <td>${s.messages ? `${s.messages.generated || 0}` : "-"}</td>
      <td>${s.send ? `${s.send.sent || 0}` : "-"}</td>
    </tr>`;
  }).join("");
}

async function savePipelineSettings() {
  try {
    await window.gtss.fetchJSON("/api/settings/pipeline", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pipelineMode: document.getElementById("pipeline-mode").value,
        autoApproveVariant: document.getElementById("pipeline-auto-approve").value,
        pipelineCron: document.getElementById("pipeline-cron").value,
        discoveryMode: document.getElementById("discovery-mode").value,
        qualificationMode: document.getElementById("qualification-mode").value,
        messageMode: document.getElementById("message-mode").value,
        qualificationThreshold: document.getElementById("qualification-threshold").value,
        qualificationManualScore: document.getElementById("qualification-manual-score").value,
      }),
    });
    window.gtss.showToast("Pipeline settings saved", "success");
  } catch (error) {
    window.gtss.showToast(error.message, "error");
  }
}

async function runPipeline() {
  const btn = document.getElementById("run-pipeline");
  btn.disabled = true;
  btn.textContent = "⏳ Running...";
  setInline("pipeline-result", "Pipeline running — this may take several minutes...", "");

  try {
    const mode = document.getElementById("pipeline-mode").value;
    const result = await window.gtss.fetchJSON("/api/pipeline/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    setInline("pipeline-result", `Pipeline run #${result.runId} started. Refresh to see results.`, "success");
    // Refresh runs after a short delay
    setTimeout(async () => {
      try {
        pipelineState.runs = await window.gtss.fetchJSON("/api/pipeline/runs?limit=5");
        renderPipelineRuns(pipelineState.runs);
      } catch (_) {}
    }, 3000);
  } catch (error) {
    setInline("pipeline-result", `Pipeline failed: ${error.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "▶ Run Pipeline Now";
  }
}

async function addKeyword() {
  const input = document.getElementById("new-keyword");
  const keyword = input.value.trim();
  if (!keyword) return;

  try {
    const result = await window.gtss.fetchJSON("/api/discovery/keywords/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword }),
    });
    pipelineState.keywords = result.config;
    renderKeywords(result.config);
    input.value = "";
    window.gtss.showToast("Keyword added", "success");
  } catch (error) {
    window.gtss.showToast(error.message, "error");
  }
}

async function removeKeyword(idx) {
  try {
    const result = await window.gtss.fetchJSON(`/api/discovery/keywords/${idx}`, {
      method: "DELETE",
    });
    pipelineState.keywords = result.config;
    renderKeywords(result.config);
    window.gtss.showToast(`Removed: ${result.removed}`, "success");
  } catch (error) {
    window.gtss.showToast(error.message, "error");
  }
}

function bindPipelineEvents() {
  document.getElementById("save-pipeline").addEventListener("click", savePipelineSettings);
  document.getElementById("run-pipeline").addEventListener("click", runPipeline);
  document.getElementById("add-keyword").addEventListener("click", addKeyword);
  document.getElementById("new-keyword").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addKeyword();
  });
  document.addEventListener("click", (event) => {
    const removeBtn = event.target.closest("[data-remove-keyword]");
    if (removeBtn) {
      removeKeyword(Number(removeBtn.dataset.removeKeyword));
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  bindPipelineEvents();
  await loadSettings();
  await loadSessions();
  await loadPipelineSettings();
});

