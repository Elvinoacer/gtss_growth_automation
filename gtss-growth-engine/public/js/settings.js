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

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  await loadSettings();
  await loadSessions();
});
