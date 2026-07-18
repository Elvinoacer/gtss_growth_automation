/* global gtss */
/**
 * automation/platformTargets.js — Platform targeting UI for Run Queue.
 *
 * Lets the operator pick which platforms (LinkedIn, X, Instagram, Facebook)
 * the automation run should process. Selection is persisted in localStorage,
 * filters the Action Queue table, and is sent as `platforms` on
 * POST /api/automation/run.
 *
 * X and Instagram cold-DM targets stay locked until re-enabled under
 * Settings → Pipeline Configuration.
 */

function formatTargetPlatformLabel(platform) {
  if (window.gtss && typeof window.gtss.formatPlatformLabel === "function") {
    return window.gtss.formatPlatformLabel(platform);
  }
  if (platform === "linkedin") return "LinkedIn";
  if (platform === "x") return "X";
  if (platform === "instagram") return "Instagram";
  if (platform === "facebook") return "Facebook";
  return platform;
}

function isPlatformLockedForAutomation(platform) {
  if (platform === "x") {
    return (
      typeof xDmOutreachEnabledForAutomation !== "undefined" &&
      !xDmOutreachEnabledForAutomation
    );
  }
  if (platform === "instagram") {
    return (
      typeof igDmOutreachEnabledForAutomation !== "undefined" &&
      !igDmOutreachEnabledForAutomation
    );
  }
  return false;
}

function getSelectedTargetPlatforms() {
  return availableTargetPlatforms().filter((p) =>
    selectedTargetPlatforms.has(p),
  );
}

function persistTargetPlatforms() {
  try {
    localStorage.setItem(
      PLATFORM_TARGET_STORAGE_KEY,
      JSON.stringify(getSelectedTargetPlatforms()),
    );
  } catch (_) {
    // localStorage may be unavailable (private mode / quota) — non-fatal
  }
}

function loadPersistedTargetPlatforms() {
  try {
    const raw = localStorage.getItem(PLATFORM_TARGET_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((p) => String(p).trim().toLowerCase())
      .filter((p) => TARGET_DM_PLATFORMS.includes(p));
  } catch (_) {
    return null;
  }
}

function setSelectedTargetPlatforms(platforms, { reloadQueue = true } = {}) {
  const available = new Set(availableTargetPlatforms());
  const next = new Set(
    (platforms || [])
      .map((p) => String(p).trim().toLowerCase())
      .filter((p) => available.has(p)),
  );
  selectedTargetPlatforms = next;
  persistTargetPlatforms();
  syncPlatformTargetCheckboxUI();
  updateRunButtonPlatformHint();
  if (reloadQueue && typeof loadQueue === "function") {
    loadQueue();
  }
}

function updateRunButtonPlatformHint() {
  if (!runAllBtn || isAutomationRunning) return;
  const selected = getSelectedTargetPlatforms();
  const available = availableTargetPlatforms();
  const label =
    selected.length === 0
      ? "Run Queue"
      : selected.length === available.length
        ? "Run Queue"
        : `Run ${selected.map(formatTargetPlatformLabel).join(", ")}`;
  runAllBtn.innerHTML = `<span class="material-symbols-outlined" style="font-variation-settings: 'FILL' 1">play_arrow</span> ${escapeHtml(label)}`;
}

function syncPlatformTargetCheckboxUI() {
  if (!platformTargetCheckboxes) return;
  platformTargetCheckboxes
    .querySelectorAll("[data-target-platform]")
    .forEach((input) => {
      const key = input.getAttribute("data-target-platform");
      if (input.disabled) {
        input.checked = false;
        return;
      }
      input.checked = selectedTargetPlatforms.has(key);
      const label = input.closest("label");
      if (label) {
        label.classList.toggle("border-primary", input.checked);
        label.classList.toggle("bg-primary/10", input.checked);
        label.classList.toggle("text-primary", input.checked);
        label.classList.toggle("border-outline-variant", !input.checked);
        label.classList.toggle("text-on-surface-variant", !input.checked);
      }
    });
}

function renderPlatformTargetCheckboxes() {
  if (!platformTargetCheckboxes) return;

  const lockedNotes = [];
  if (isPlatformLockedForAutomation("x")) lockedNotes.push("X");
  if (isPlatformLockedForAutomation("instagram")) lockedNotes.push("Instagram");

  platformTargetCheckboxes.innerHTML =
    TARGET_DM_PLATFORMS.map((platform) => {
      const locked = isPlatformLockedForAutomation(platform);
      const checked = !locked && selectedTargetPlatforms.has(platform);
      const label = formatTargetPlatformLabel(platform);
      const badge =
        platform === "x" && locked
          ? " (premium)"
          : platform === "instagram" && locked
            ? " (gated)"
            : "";
      const title = locked
        ? `${label} DM outreach disabled — enable under Settings → Pipeline Configuration`
        : "";
      return `
      <label
        class="inline-flex items-center gap-2 select-none px-3 py-2 rounded-lg border transition-colors ${
          locked
            ? "cursor-not-allowed opacity-50 border-outline-variant text-on-surface-variant"
            : checked
              ? "cursor-pointer border-primary bg-primary/10 text-primary"
              : "cursor-pointer border-outline-variant text-on-surface-variant hover:bg-surface-variant/40"
        }"
        title="${title}"
      >
        <input
          type="checkbox"
          class="platform-target-checkbox rounded text-primary focus:ring-primary/30"
          data-target-platform="${escapeHtml(platform)}"
          ${checked ? "checked" : ""}
          ${locked ? "disabled" : ""}
        />
        <span class="font-label-caps text-label-caps">${escapeHtml(label)}${badge}</span>
      </label>
    `;
    }).join("") +
    (lockedNotes.length
      ? `<p class="w-full text-body-xs text-on-surface-variant mt-1" style="flex-basis:100%">
          ${lockedNotes.join(" &amp; ")} off for DMs by default. Re-enable under
          <strong>Settings → Pipeline Configuration</strong>.
        </p>`
      : "");
}

async function loadDmOutreachFlags() {
  try {
    const cfg = await fetchJSON("/api/settings/pipeline");
    return {
      x: Boolean(cfg?.xDmOutreachEnabled),
      ig: Boolean(cfg?.igDmOutreachEnabled),
    };
  } catch (_) {
    return { x: false, ig: false };
  }
}

function availableTargetPlatforms() {
  return TARGET_DM_PLATFORMS.filter((p) => !isPlatformLockedForAutomation(p));
}

async function initPlatformTargets() {
  const flags = await loadDmOutreachFlags();
  xDmOutreachEnabledForAutomation = flags.x;
  igDmOutreachEnabledForAutomation = flags.ig;

  const available = availableTargetPlatforms();
  const saved = loadPersistedTargetPlatforms();
  if (saved && saved.length > 0) {
    selectedTargetPlatforms = new Set(
      saved.filter((p) => available.includes(p)),
    );
    if (selectedTargetPlatforms.size === 0) {
      selectedTargetPlatforms = new Set(available);
    }
  } else if (saved && saved.length === 0) {
    selectedTargetPlatforms = new Set();
  } else {
    selectedTargetPlatforms = new Set(available);
  }

  // Always drop gated platforms while flags are off.
  if (!xDmOutreachEnabledForAutomation) selectedTargetPlatforms.delete("x");
  if (!igDmOutreachEnabledForAutomation) {
    selectedTargetPlatforms.delete("instagram");
  }
  persistTargetPlatforms();

  renderPlatformTargetCheckboxes();
  updateRunButtonPlatformHint();

  if (platformTargetCheckboxes) {
    platformTargetCheckboxes.addEventListener("change", (event) => {
      const input = event.target.closest("[data-target-platform]");
      if (!input || input.disabled) return;
      const platform = input.getAttribute("data-target-platform");
      if (input.checked) {
        selectedTargetPlatforms.add(platform);
      } else {
        selectedTargetPlatforms.delete(platform);
      }
      persistTargetPlatforms();
      syncPlatformTargetCheckboxUI();
      updateRunButtonPlatformHint();
      if (typeof loadQueue === "function") loadQueue();
    });
  }

  if (platformSelectAllBtn) {
    platformSelectAllBtn.addEventListener("click", () => {
      setSelectedTargetPlatforms(availableTargetPlatforms());
    });
  }

  if (platformClearBtn) {
    platformClearBtn.addEventListener("click", () => {
      setSelectedTargetPlatforms([]);
    });
  }
}
