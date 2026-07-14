/**
 * settings/helpers.js — Small UI helpers shared across the Settings page.
 *
 * Originally part of public/js/settings.js. Holds the small, dependency-
 * free helpers used by every other split file:
 *   - platformLabel(platform)      — resolve a platform key to a
 *                                    human-friendly label (prefers the
 *                                    per-platform override in
 *                                    settingsState.settings.platformLabels,
 *                                    falls back to gtss.formatPlatformLabel,
 *                                    finally the bare key).
 *   - formatTemplateLabel(key)     — title-case a template key for the
 *                                    template-tab buttons (with special
 *                                    cases for "linkedin", "dm", "x").
 *   - getLimitFieldOrder(data)     — produce a stable, deduped order of
 *                                    limit-field keys for the limits
 *                                    table (prefers the configured
 *                                    limitFields, falls back to the union
 *                                    of every platform's keys).
 *   - getLimitValue(pl, field)     — read a (possibly dotted) limit
 *                                    field from a platform-limits object.
 *   - setLimitValue(t, field, v)   — write a (possibly dotted) limit
 *                                    field, creating the intermediate
 *                                    group object if needed.
 *   - formatLimitField(field)      — title-case a limit-field key for the
 *                                    table header (with a special case for
 *                                    "connections").
 *   - confirmModal(message)        — Promise-returning wrapper around the
 *                                    shared #confirm-backdrop modal.
 *   - setInline(id, message, type) — set the textContent + className of
 *                                    an inline-result element (used by
 *                                    every "saved" / "failed" pill).
 *
 * No external dependencies (other than `document` and the `settingsState`
 * global declared in state.js).
 */

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
    Object.entries(platformLimits || {}).forEach(([field, value]) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.keys(value).forEach((nestedField) => {
          const key = `${field}.${nestedField}`;
          if (seen.has(key)) return;
          seen.add(key);
          fields.push(key);
        });
        return;
      }
      if (seen.has(field)) return;
      seen.add(field);
      fields.push(field);
    });
  });
  return fields;
}

function getLimitValue(platformLimits, field) {
  if (!platformLimits) return undefined;
  if (!field.includes(".")) return platformLimits[field];
  const [group, nestedField] = field.split(".", 2);
  return platformLimits[group]?.[nestedField];
}

function setLimitValue(target, field, value) {
  if (!field.includes(".")) {
    target[field] = value;
    return;
  }
  const [group, nestedField] = field.split(".", 2);
  target[group] = target[group] || {};
  target[group][nestedField] = value;
}

function formatLimitField(field) {
  if (field === "connections") return "Connections/Requests";
  return field
    .split(".")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
