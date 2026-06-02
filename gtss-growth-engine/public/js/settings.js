const variables = [
  "{{lead_name}}",
  "{{company}}",
  "{{role}}",
  "{{location}}",
  "{{product}}",
  "{{product_tagline}}",
  "{{pain_point}}",
  "{{value_prop}}",
  "{{sender_name}}",
  "{{sign_off}}",
  "{{cta}}",
  "{{biz_name}}",
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
  [
    "retry_max_attempts",
    "retry_delay_preset",
    "content_asset_source",
    "content_library_media_type",
  ].forEach((key) => {
    const el = document.getElementById(key);
    if (el) el.value = settingsState.settings[key] || "";
  });

  // Populate Instagram Settings
  const igKeys = [
    "warmup_min_follow_to_story_hours",
    "warmup_max_follow_to_story_hours",
    "warmup_min_story_to_like_hours",
    "warmup_max_story_to_like_hours",
    "warmup_min_like_to_dm_hours",
    "warmup_max_like_to_dm_hours",
    "fast_warmup_enabled",
    "auto_warmup_on_qualify",
    "unfollow_after_days",
    "unfollow_pending_after_days",
    "max_following_ratio",
    "discovery_max_per_hashtag",
    "discovery_min_followers",
    "discovery_max_followers",
    "ig_selector_version",
    "ig_blocked_until",
  ];
  igKeys.forEach((key) => {
    const el = document.getElementById(key);
    if (el) {
      el.value =
        settingsState.settings[key] !== undefined &&
        settingsState.settings[key] !== null
          ? settingsState.settings[key]
          : "";
    }
  });
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

  let currentVariables = variables;
  if (settingsState.activeTemplate === "instagram_dm") {
    editor.setAttribute("maxlength", "1000");
  } else {
    editor.removeAttribute("maxlength");
  }

  document.getElementById("variable-badges").innerHTML = currentVariables
    .map(
      (variable) =>
        `<button class="variable-badge" data-variable="${variable}" type="button">${variable}</button>`,
    )
    .join("");
}

function updateCharCount() {
  const editor = document.getElementById("template-editor");
  const max = settingsState.activeTemplate === "instagram_dm" ? " / 1000" : "";
  document.getElementById("char-count").textContent =
    `${editor.value.length}${max} chars`;
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

async function saveInstagramSettings() {
  const btn = document.getElementById("save-instagram-settings");
  btn.disabled = true;
  btn.innerText = "Saving...";
  try {
    const igKeys = [
      "warmup_min_follow_to_story_hours",
      "warmup_max_follow_to_story_hours",
      "warmup_min_story_to_like_hours",
      "warmup_max_story_to_like_hours",
      "warmup_min_like_to_dm_hours",
      "warmup_max_like_to_dm_hours",
      "fast_warmup_enabled",
      "auto_warmup_on_qualify",
      "unfollow_after_days",
      "unfollow_pending_after_days",
      "max_following_ratio",
      "discovery_max_per_hashtag",
      "discovery_min_followers",
      "discovery_max_followers",
      "ig_selector_version",
      "ig_blocked_until",
    ];
    const formData = {};
    igKeys.forEach((key) => {
      const el = document.getElementById(key);
      if (el) {
        if (key === "ig_selector_version" || key === "ig_blocked_until") {
          formData[key] = el.value.trim() || null;
        } else {
          formData[key] = Number(el.value);
        }
      }
    });

    const res = await window.gtss.fetchJSON("/api/settings/instagram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formData),
    });

    if (res.success) {
      window.gtss.showToast(
        "Instagram settings saved successfully!",
        "success",
      );
      setInline("instagram-settings-result", "✓ Settings saved", "success");
    } else {
      window.gtss.showToast(res.error || "Failed to save settings.", "error");
      setInline("instagram-settings-result", `✗ ${res.error}`, "error");
    }
  } catch (err) {
    window.gtss.showToast("Network error: " + err.message, "error");
    setInline("instagram-settings-result", `✗ ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerText = "Save Instagram Settings";
  }
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
    window.gtss.showToast(
      "Template is empty — write your message first",
      "error",
    );
    return;
  }

  if (
    !(await confirmModal(
      `This will save this template to ALL platforms and overwrite ALL ${settingsState.templates ? "existing" : ""} message bodies in the system. Continue?`,
    ))
  )
    return;

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
    const result = await window.gtss.fetchJSON(
      "/api/settings/templates/apply-all",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
    );

    setInline(
      "template-apply-result",
      `✓ Updated ${result.updated}/${result.total} messages across all platforms`,
      "success",
    );
    window.gtss.showToast(
      `Applied template to ${result.updated} messages`,
      "success",
    );
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
let activePipelineRunId = null;
let pipelineSocketSubscribed = false;

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
  document.getElementById("pipeline-auto-approve").value =
    config.autoApproveVariant || "B";
  document.getElementById("pipeline-cron").value =
    config.pipelineCron || "0 8 * * *";
  document.getElementById("discovery-mode").value = config.discoveryMode || "";
  document.getElementById("qualification-mode").value =
    config.qualificationMode || "";
  document.getElementById("message-mode").value = config.messageMode || "";
  document.getElementById("send-mode").value = config.sendMode || "";
  document.getElementById("qualification-threshold").value =
    config.qualificationThreshold ?? 50;
  document.getElementById("qualification-manual-score").value =
    config.qualificationManualScore ?? 75;
  const maxDmsInput = document.getElementById("pipeline-max-dms-per-run");
  if (maxDmsInput) maxDmsInput.value = config.maxDmsPerRun ?? 20;
  const maxConnectionsInput = document.getElementById(
    "pipeline-max-connections-per-run",
  );
  if (maxConnectionsInput) {
    maxConnectionsInput.value = config.maxConnectionsPerRun ?? 15;
  }
  document.getElementById("linkedin-outreach-mode").value =
    config.linkedinOutreachMode || "connect_first";
  document.getElementById("x-outreach-mode").value =
    config.xOutreachMode || "follow_first";
  renderOutreachPlatforms(config.outreachPlatforms || []);
}

function renderOutreachPlatforms(selectedPlatforms) {
  const container = document.getElementById("outreach-platforms-list");
  if (!container) return;
  const selected = new Set(
    (Array.isArray(selectedPlatforms) ? selectedPlatforms : [])
      .map((platform) => String(platform).toLowerCase())
      .filter(Boolean),
  );
  const platforms = settingsState.settings.platforms || [];
  container.innerHTML = platforms
    .map(
      (platform) => `
      <label>
        <input
          type="checkbox"
          data-outreach-platform="${platform.key}"
          ${selected.has(platform.key) ? "checked" : ""}
        />
        ${platform.label || platformLabel(platform.key)}
      </label>
    `,
    )
    .join("");
}

function collectOutreachPlatforms() {
  return [
    ...document.querySelectorAll("[data-outreach-platform]:checked"),
  ].map((checkbox) => checkbox.dataset.outreachPlatform);
}

function renderKeywords(data) {
  const list = document.getElementById("keywords-list");
  if (!data.keywords || data.keywords.length === 0) {
    list.innerHTML = '<span class="muted">No keywords configured.</span>';
    return;
  }
  list.innerHTML = data.keywords
    .map(
      (kw, idx) => `
    <div style="display: flex; align-items: center; gap: 8px;">
      <span style="flex: 1; color: var(--gtss-text); font-size: 13px;">${idx + 1}. ${kw}</span>
      <button class="secondary-button" data-remove-keyword="${idx}" type="button" style="min-height: 30px; padding: 0 8px; font-size: 12px;">✕</button>
    </div>
  `,
    )
    .join("");
}

function renderPipelineRuns(runs) {
  const body = document.getElementById("pipeline-runs-body");
  if (!runs || runs.length === 0) {
    body.innerHTML =
      '<tr><td colspan="9" class="muted" style="text-align: center;">No pipeline runs yet</td></tr>';
    return;
  }
  body.innerHTML = runs
    .map((run) => {
      const s = run.stages || {};
      const statusClass =
        run.status === "completed"
          ? "color: var(--gtss-success)"
          : run.status === "failed"
            ? "color: var(--gtss-danger)"
            : "color: var(--gtss-warning, #f59e0b)";
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
    })
    .join("");
}

async function savePipelineSettings() {
  try {
    await window.gtss.fetchJSON("/api/settings/pipeline", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pipelineMode: document.getElementById("pipeline-mode").value,
        autoApproveVariant: document.getElementById("pipeline-auto-approve")
          .value,
        pipelineCron: document.getElementById("pipeline-cron").value,
        discoveryMode: document.getElementById("discovery-mode").value,
        qualificationMode: document.getElementById("qualification-mode").value,
        messageMode: document.getElementById("message-mode").value,
        sendMode: document.getElementById("send-mode").value,
        qualificationThreshold: document.getElementById(
          "qualification-threshold",
        ).value,
        qualificationManualScore: document.getElementById(
          "qualification-manual-score",
        ).value,
        maxDmsPerRun: document.getElementById("pipeline-max-dms-per-run")
          ?.value,
        maxConnectionsPerRun: document.getElementById(
          "pipeline-max-connections-per-run",
        )?.value,
        outreachPlatforms: collectOutreachPlatforms(),
        linkedinOutreachMode: document.getElementById("linkedin-outreach-mode")
          .value,
        xOutreachMode: document.getElementById("x-outreach-mode").value,
      }),
    });
    window.gtss.showToast("Pipeline settings saved", "success");
  } catch (error) {
    window.gtss.showToast(error.message, "error");
  }
}

async function runPipeline() {
  const btn = document.getElementById("run-pipeline");
  const abortBtn = document.getElementById("abort-pipeline");
  const pauseBtn = document.getElementById("pause-pipeline");
  const resumeBtn = document.getElementById("resume-pipeline");
  btn.disabled = true;
  btn.textContent = "⏳ Running...";
  setInline(
    "pipeline-result",
    "Pipeline running — this may take several minutes...",
    "",
  );

  try {
    const mode = document.getElementById("pipeline-mode").value;
    const result = await window.gtss.fetchJSON("/api/pipeline/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    activePipelineRunId = result.runId;
    if (abortBtn) abortBtn.style.display = "inline-flex";
    if (pauseBtn) pauseBtn.style.display = "inline-flex";
    if (resumeBtn) resumeBtn.style.display = "none";
    setInline(
      "pipeline-result",
      `Pipeline run #${result.runId} started. Watching for updates…`,
      "success",
    );
    subscribeToPipelineStream(result.runId);
  } catch (error) {
    btn.disabled = false;
    btn.textContent = "▶ Run Pipeline Now";
    setInline("pipeline-result", `Pipeline failed: ${error.message}`, "error");
  }
}

async function abortPipeline() {
  if (!activePipelineRunId) return;
  await window.gtss.fetchJSON(`/api/pipeline/abort/${activePipelineRunId}`, {
    method: "POST",
  });
  setInline(
    "pipeline-result",
    "Abort signal sent — pipeline will stop after the current stage.",
    "warn",
  );
}

async function pausePipeline() {
  if (!activePipelineRunId) return;
  await window.gtss.fetchJSON(`/api/pipeline/pause/${activePipelineRunId}`, {
    method: "POST",
  });
  document.getElementById("pause-pipeline").style.display = "none";
  document.getElementById("resume-pipeline").style.display = "inline-flex";
  setInline("pipeline-result", "Pause signal sent — pipeline will pause at the next boundary.", "warn");
}

async function resumePipeline() {
  if (!activePipelineRunId) return;
  await window.gtss.fetchJSON(`/api/pipeline/resume/${activePipelineRunId}`, {
    method: "POST",
  });
  document.getElementById("pause-pipeline").style.display = "inline-flex";
  document.getElementById("resume-pipeline").style.display = "none";
  setInline("pipeline-result", "Pipeline resumed.", "success");
}

function finishPipelineControls(runId, message, tone = "success") {
  setInline("pipeline-result", message, tone);
  const runBtn = document.getElementById("run-pipeline");
  runBtn.disabled = false;
  runBtn.textContent = "▶ Run Pipeline Now";
  ["abort-pipeline", "pause-pipeline", "resume-pipeline"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  activePipelineRunId = null;
  loadPipelineSettings();
}

function subscribeToPipelineStream(runId) {
  const socket = window.gtss.getSocket?.();
  if (!socket || pipelineSocketSubscribed) return;
  pipelineSocketSubscribed = true;

  socket.on("pipeline:event", (event) => {
    if (String(event.runId) !== String(activePipelineRunId || runId)) return;

    if (event.type === "stage" || event.type === "stage_done" || event.type === "info") {
      setInline("pipeline-result", event.message, "");
    } else if (event.type === "complete") {
      finishPipelineControls(event.runId, `✓ Pipeline #${event.runId} complete.`, "success");
    } else if (event.type === "warn" && /aborted/i.test(event.message || "")) {
      finishPipelineControls(event.runId, `Pipeline #${event.runId} aborted.`, "warn");
    } else if (event.type === "error") {
      setInline("pipeline-result", `Error: ${event.message}`, "error");
    }
  });
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
    const result = await window.gtss.fetchJSON(
      `/api/discovery/keywords/${idx}`,
      {
        method: "DELETE",
      },
    );
    pipelineState.keywords = result.config;
    renderKeywords(result.config);
    window.gtss.showToast(`Removed: ${result.removed}`, "success");
  } catch (error) {
    window.gtss.showToast(error.message, "error");
  }
}

function bindPipelineEvents() {
  document
    .getElementById("save-pipeline")
    .addEventListener("click", savePipelineSettings);
  document
    .getElementById("run-pipeline")
    .addEventListener("click", runPipeline);
  document
    .getElementById("abort-pipeline")
    ?.addEventListener("click", abortPipeline);
  document
    .getElementById("pause-pipeline")
    ?.addEventListener("click", pausePipeline);
  document
    .getElementById("resume-pipeline")
    ?.addEventListener("click", resumePipeline);
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

// ─────────────────────────────────────────────────────────────────────────────
// BRAND CONTEXT - Phase 1
// ─────────────────────────────────────────────────────────────────────────────

// Fields that are stored as arrays in the DB but edited as multiline text in the UI
const CTX_ARRAY_FIELDS = [
  "ctx_product_key_features",
  "ctx_product_pain_points",
  "ctx_audience_industries",
  "ctx_audience_geographies",
  "ctx_audience_exclude_industries",
  "ctx_content_post_themes",
];

// Fields that stay as plain strings
const CTX_TEXT_FIELDS = [
  "ctx_biz_name",
  "ctx_biz_description",
  "ctx_biz_industry",
  "ctx_biz_location",
  "ctx_biz_website",
  "ctx_product_name",
  "ctx_product_tagline",
  "ctx_product_description",
  "ctx_product_value_prop",
  "ctx_audience_ideal_profile",
  "ctx_audience_exclude_industries",
  "ctx_sender_name",
  "ctx_sender_full_name",
  "ctx_sender_role",
  "ctx_sender_sign_off",
  "ctx_content_tone",
  "ctx_content_language",
  "ctx_content_cta",
  "ctx_content_image_style",
];

async function loadContext() {
  try {
    const ctx = await window.gtss.fetchJSON("/api/context");
    populateContextForm(ctx);
  } catch (err) {
    console.error("Failed to load context:", err);
  }
}

function populateContextForm(ctx) {
  // Plain text fields
  CTX_TEXT_FIELDS.forEach((key) => {
    const el = document.getElementById(key);
    if (el && ctx[key] !== undefined) el.value = ctx[key];
  });

  // Array fields - join as one-per-line
  CTX_ARRAY_FIELDS.forEach((key) => {
    const el = document.getElementById(key);
    if (!el) return;
    const val = ctx[key];
    el.value = Array.isArray(val) ? val.join("\n") : val || "";
  });

  // Scoring weights - render mini input fields
  renderScoringWeights(ctx.ctx_audience_scoring_weights || {});
}

function renderScoringWeights(weights) {
  const container = document.getElementById("scoring-weights-row");
  if (!container) return;
  container.innerHTML = "";
  const labels = {
    business_type: "Business Type",
    location: "Location",
    business_size: "Business Size",
    completeness: "Profile Completeness",
    recency: "Activity Recency",
  };
  Object.entries(weights).forEach(([key, value]) => {
    const label = labels[key] || key;
    container.insertAdjacentHTML(
      "beforeend",
      `
      <label class="field" style="flex:0 0 auto;min-width:140px;">
        ${label} <span class="muted">/ 100</span>
        <input type="number" min="0" max="100" id="weight_${key}" value="${value}" style="width:80px;">
      </label>
    `,
    );
  });
}

function collectContextPayload() {
  const payload = {};

  // Plain text fields
  CTX_TEXT_FIELDS.forEach((key) => {
    const el = document.getElementById(key);
    if (el) payload[key] = el.value.trim();
  });

  // Array fields - split by newline, trim, filter empties
  CTX_ARRAY_FIELDS.forEach((key) => {
    const el = document.getElementById(key);
    if (el) {
      payload[key] = el.value
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  });

  // Scoring weights
  const weightKeys = [
    "business_type",
    "location",
    "business_size",
    "completeness",
    "recency",
  ];
  const weights = {};
  weightKeys.forEach((k) => {
    const el = document.getElementById(`weight_${k}`);
    if (el) weights[k] = Number(el.value) || 0;
  });
  payload.ctx_audience_scoring_weights = weights;

  return payload;
}

async function saveContext() {
  const resultEl = document.getElementById("context-result");
  const btn = document.getElementById("save-context-btn");
  try {
    btn.disabled = true;
    const payload = collectContextPayload();

    // Client-side weight validation
    const weightSum = Object.values(
      payload.ctx_audience_scoring_weights,
    ).reduce((s, v) => s + v, 0);
    if (weightSum !== 100) {
      resultEl.textContent = `Scoring weights must sum to 100 (currently ${weightSum})`;
      resultEl.className = "inline-result error";
      return;
    }

    const res = await window.gtss.fetchJSON("/api/context", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    resultEl.textContent = `Saved ${res.updated.length} fields ✓`;
    resultEl.className = "inline-result success";
    setTimeout(() => {
      resultEl.textContent = "";
      resultEl.className = "inline-result";
    }, 3000);
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.className = "inline-result error";
  } finally {
    btn.disabled = false;
  }
}

async function resetContextToDefaults() {
  if (
    !confirm(
      "Reset all context fields to built-in defaults? This cannot be undone.",
    )
  )
    return;
  const resultEl = document.getElementById("context-result");
  try {
    const res = await window.gtss.fetchJSON("/api/context/reset", {
      method: "POST",
    });
    populateContextForm(res.context);
    resultEl.textContent = "Reset to defaults ✓";
    resultEl.className = "inline-result success";
    setTimeout(() => {
      resultEl.textContent = "";
      resultEl.className = "inline-result";
    }, 3000);
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.className = "inline-result error";
  }
}

// Preview modal
let previewData = null;
async function openContextPreview() {
  const backdrop = document.getElementById("context-preview-backdrop");
  const tabsEl = document.getElementById("preview-tabs");
  const contentEl = document.getElementById("preview-content");
  backdrop.classList.add("visible");
  contentEl.textContent = "Loading preview...";
  tabsEl.innerHTML = "";

  try {
    const previews = await window.gtss.fetchJSON("/api/context/preview");
    const labelMap = {
      qualification: "Lead Qualification",
      messages: "Message Variables",
      caption: "Post Caption",
      image: "Image Generation",
    };

    Object.entries(previews).forEach(([key, text], i) => {
      const label = labelMap[key] || key;
      const btn = document.createElement("button");
      btn.className = "tab-button" + (i === 0 ? " active" : "");
      btn.textContent = label;
      btn.addEventListener("click", () => {
        tabsEl
          .querySelectorAll(".tab-button")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        contentEl.textContent = text;
      });
      tabsEl.appendChild(btn);
      if (i === 0) contentEl.textContent = text;
    });
  } catch (err) {
    contentEl.textContent = "Preview error: " + err.message;
  }
}

function buildQualificationPreview(ctx) {
  const industries = (ctx.ctx_audience_industries || []).join(", ");
  const geos = (ctx.ctx_audience_geographies || []).join(", ");
  const w = ctx.ctx_audience_scoring_weights || {};
  return `You are a lead qualification specialist for ${ctx.ctx_biz_name}, ${ctx.ctx_biz_description}

Ideal customer: ${ctx.ctx_audience_ideal_profile}

Score this lead from 0 to 100.

Scoring factors:
- Business type match (${industries}): ${w.business_type || 30} points
- Location (${geos}): ${w.location || 20} points
- Business size signals: ${w.business_size || 20} points
- Profile completeness: ${w.completeness || 15} points
- Activity recency: ${w.recency || 15} points`;
}

function buildMessagePreview(ctx) {
  return `Template variables resolved from context:
{{product}}       → ${ctx.ctx_product_name}
{{product_tagline}} → ${ctx.ctx_product_tagline}
{{pain_point}}    → ${(ctx.ctx_product_pain_points || [])[0] || ""}
{{value_prop}}    → ${ctx.ctx_product_value_prop}
{{sender_name}}   → ${ctx.ctx_sender_name}
{{sign_off}}      → ${ctx.ctx_sender_sign_off}
{{cta}}           → ${ctx.ctx_content_cta}
{{biz_name}}      → ${ctx.ctx_biz_name}`;
}

function buildCaptionPreview(ctx) {
  return `Write a social media caption for [platform] about: [topic]
Company: ${ctx.ctx_biz_name} — ${ctx.ctx_biz_description}
Product: ${ctx.ctx_product_name}
Tone: ${ctx.ctx_content_tone}
Target audience: ${ctx.ctx_audience_ideal_profile}
End with this call to action: ${ctx.ctx_content_cta}`;
}

function buildImagePreview(ctx) {
  return `You are a creative director for ${ctx.ctx_biz_name}, ${ctx.ctx_biz_description}
Write a detailed image-generation prompt for a [platform] post.

Topic: [topic]
Brand themes: ${(ctx.ctx_content_post_themes || []).join(", ")}
Visual style: ${ctx.ctx_content_image_style}
Target audience: ${ctx.ctx_audience_ideal_profile}
Location context: ${(ctx.ctx_audience_geographies || [])[0] || ""}`;
}

// ── Wire up events ────────────────────────────────────────────────────────────
document
  .getElementById("save-context-btn")
  ?.addEventListener("click", saveContext);
document
  .getElementById("reset-context-btn")
  ?.addEventListener("click", resetContextToDefaults);
document
  .getElementById("preview-context-btn")
  ?.addEventListener("click", openContextPreview);
document.getElementById("close-preview-btn")?.addEventListener("click", () => {
  document
    .getElementById("context-preview-backdrop")
    ?.classList.remove("visible");
});
document
  .getElementById("context-preview-backdrop")
  ?.addEventListener("click", (e) => {
    if (e.target.id === "context-preview-backdrop")
      e.target.classList.remove("visible");
  });

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  bindPipelineEvents();
  await loadSettings();
  await loadContext();
  await loadSessions();
  await loadPipelineSettings();
});
