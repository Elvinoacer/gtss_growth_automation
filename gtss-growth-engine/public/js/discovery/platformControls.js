/**
 * discovery/platformControls.js — Platform checkbox + filter loader for
 * the Discovery page.
 *
 * Loads the global platform catalog from app.js, filters it down to the
 * DISCOVERY_PLATFORM_KEYS whitelist, renders the per-platform checkbox row
 * (#platform-row), and populates the #platform-filter <select> on the
 * results table. Also wires the platform-checkbox change listener that
 * reveals the Instagram-discovery container (#ig-discovery-container) when
 * Instagram is checked (which triggers loadInstagramDiscoveryKeywords in
 * instagramHashtags.js).
 *
 * X and Instagram cold-DM discovery stay locked until re-enabled under
 * Settings → Pipeline Configuration.
 *
 * Exposes (via global scope):
 *   - loadPlatformControls() — async; idempotent
 */

async function loadPlatformControls() {
  const catalog = (await window.gtss.loadPlatformCatalog()).filter((platform) =>
    DISCOVERY_PLATFORM_KEYS.has(platform.key),
  );
  platformLabels = Object.fromEntries(
    catalog.map((platform) => [platform.key, platform.label]),
  );

  let xDmOutreachEnabled = false;
  let igDmOutreachEnabled = false;
  try {
    const pipelineCfg = await window.gtss.fetchJSON("/api/settings/pipeline");
    xDmOutreachEnabled = Boolean(pipelineCfg?.xDmOutreachEnabled);
    igDmOutreachEnabled = Boolean(pipelineCfg?.igDmOutreachEnabled);
  } catch (_) {
    xDmOutreachEnabled = false;
    igDmOutreachEnabled = false;
  }

  const platformRow = document.getElementById("platform-row");
  if (platformRow) {
    platformRow.innerHTML = catalog
      .map((platform) => {
        const isXLocked = platform.key === "x" && !xDmOutreachEnabled;
        const isIgLocked = platform.key === "instagram" && !igDmOutreachEnabled;
        const isLocked = isXLocked || isIgLocked;
        const label = escapeHtml(
          platform.label || window.gtss.formatPlatformLabel(platform.key),
        );
        const badge = isXLocked
          ? ' <span class="muted" style="font-size:11px;">(premium)</span>'
          : isIgLocked
            ? ' <span class="muted" style="font-size:11px;">(gated)</span>'
            : "";
        const title = isXLocked
          ? "X DM outreach disabled — enable under Settings → Pipeline Configuration"
          : isIgLocked
            ? "Instagram DM outreach disabled — enable under Settings → Pipeline Configuration"
            : "";
        return `
      <label class="platform-option" style="${isLocked ? "opacity:0.55;" : ""}"
        title="${title}">
        <input type="checkbox" name="platforms" value="${platform.key}"
          ${isLocked ? "disabled" : ""}>
        ${label}${badge}
      </label>
    `;
      })
      .join("");

    if (!xDmOutreachEnabled || !igDmOutreachEnabled) {
      const note = document.createElement("p");
      note.className = "muted";
      note.style.cssText =
        "font-size:12px;margin:8px 0 0;line-height:1.5;width:100%;";
      const parts = [];
      if (!xDmOutreachEnabled) parts.push("X");
      if (!igDmOutreachEnabled) parts.push("Instagram");
      note.innerHTML = `${parts.join(" &amp; ")} off for discovery &amp; DMs by default. Re-enable under <strong>Settings → Pipeline Configuration</strong>.`;
      platformRow.appendChild(note);
    }

    const checkboxes = platformRow.querySelectorAll('input[name="platforms"]');
    checkboxes.forEach((cb) => {
      cb.addEventListener("change", () => {
        const igChecked = [
          ...platformRow.querySelectorAll('input[name="platforms"]:checked'),
        ].some((i) => i.value === "instagram");
        const igContainer = document.getElementById("ig-discovery-container");
        if (igContainer) {
          if (igChecked) {
            igContainer.classList.add("visible");
            loadInstagramDiscoveryKeywords();
          } else {
            igContainer.classList.remove("visible");
          }
        }
      });
    });
  }

  const filterSelect = document.getElementById("platform-filter");
  if (filterSelect) {
    filterSelect.innerHTML = [
      '<option value="">All</option>',
      ...catalog.map(
        (platform) =>
          `<option value="${platform.key}">${escapeHtml(platform.label || window.gtss.formatPlatformLabel(platform.key))}</option>`,
      ),
    ].join("");
  }
}
