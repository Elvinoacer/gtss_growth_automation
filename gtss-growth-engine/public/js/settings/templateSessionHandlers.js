/**
 * settings/templateSessionHandlers.js — Instagram / template / passphrase /
 * data-wipe / session-button handlers.
 *
 * Originally part of public/js/settings.js. Holds:
 *   - saveInstagramSettings()    — POST the 16 IG warmup/discovery knobs
 *                                  (with type-coercion: ig_selector_version
 *                                  + ig_blocked_until are nullable strings,
 *                                  everything else is Number(el.value)).
 *   - saveTemplate()             — PATCH the active template body to
 *                                  /api/settings/templates/<key>.
 *   - resetTemplate()            — POST reset, then re-render the editor
 *                                  with the server's canonical template.
 *   - applyTemplateToAll()       — confirmModal-gated; PATCH the current
 *                                  editor body to EVERY platform key, then
 *                                  POST /api/settings/templates/apply-all
 *                                  to overwrite existing message rows.
 *   - changePassphrase()         — POST the current/new/confirm passphrase
 *                                  triple to /api/settings/passphrase.
 *   - clearData()                — confirmModal-gated; POST the
 *                                  "DELETE" confirmation to
 *                                  /api/settings/clear-data.
 *   - authenticatePlatform(btn)  — POST /api/sessions/authenticate/<key>,
 *                                  then reload sessions + update dots.
 *   - clearPlatform(key)         — confirmModal-gated; POST
 *                                  /api/sessions/clear/<key>, then reload.
 *
 * Depends on the globals declared in state.js + helpers.js +
 * settingsLoad.js (for settingsState, setInline, confirmModal,
 * platformLabel, renderTemplateEditor, renderTemplateTabs, loadSessions).
 */

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
