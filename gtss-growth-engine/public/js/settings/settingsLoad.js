/**
 * settings/settingsLoad.js — Load + render the basic Settings sections.
 *
 * Originally part of public/js/settings.js. Holds the loaders + renderers
 * for the page's "core" sections (the ones that don't fit cleanly into the
 * Pipeline, Brand Context, or Centralized Extensions buckets):
 *   - loadSettings()         — fetch /api/settings + /api/settings/templates,
 *                              populate the form fields (Gemini key, Gmail
 *                              creds, retry/reliability presets, IG warmup
 *                              settings, app version), and call the
 *                              template + limit renderers.
 *   - loadSessions()         — fetch /api/sessions/details and render the
 *                              session-grid cards (platform, status badge,
 *                              last-active timestamp, login/clear buttons).
 *   - renderLimits(data)     — render the per-platform limits table from
 *                              the given data shape.
 *   - collectLimits()        — read the limits table inputs back into a
 *                              { platform: { field: number } } object.
 *   - applyNotifications(s)  — check the notification checkboxes per the
 *                              persisted settings.
 *   - collectNotifications() — read the notification checkboxes back into
 *                              a { key: boolean } object.
 *   - renderTemplateTabs()   — render the template-tab buttons.
 *   - renderTemplateEditor() — populate the template editor textarea +
 *                              variable-badge buttons for the active
 *                              template; sets maxlength for instagram_dm.
 *   - updateCharCount()      — update the "X / 1000 chars" counter.
 *   - insertAtCursor(t, txt) — insert a variable badge into the template
 *                              textarea at the cursor position.
 *
 * Depends on the `variables`, `settingsState`, `platformLabel`,
 * `getLimitFieldOrder`, `getLimitValue`, `setLimitValue`,
 * `formatLimitField`, and `formatTemplateLabel` globals declared in
 * state.js / helpers.js.
 */

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
          `<th>${formatLimitField(field)}</th>`,
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
          const value = getLimitValue(data[platform], field);
          const hasField = value !== undefined;
          return hasField
            ? `<td><input data-limit-platform="${platform}" data-limit-field="${field}" type="number" min="1" value="${value}"></td>`
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
    setLimitValue(
      next[input.dataset.limitPlatform],
      input.dataset.limitField,
      Number(
      input.value,
      ),
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
