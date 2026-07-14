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
 * Exposes (via global scope):
 *   - loadPlatformControls() — async; idempotent
 *
 * Depends on (from discovery/state.js, loaded earlier):
 *   - platformLabels, DISCOVERY_PLATFORM_KEYS
 * Depends on (from discovery/helpers.js, loaded earlier):
 *   - escapeHtml
 * Depends on (from discovery/instagramHashtags.js, loaded earlier):
 *   - loadInstagramDiscoveryKeywords
 * Depends on (from window.gtss, available via app.js):
 *   - loadPlatformCatalog, formatPlatformLabel
 */

async function loadPlatformControls() {
  const catalog = (await window.gtss.loadPlatformCatalog()).filter((platform) =>
    DISCOVERY_PLATFORM_KEYS.has(platform.key),
  );
  platformLabels = Object.fromEntries(
    catalog.map((platform) => [platform.key, platform.label]),
  );

  const platformRow = document.getElementById("platform-row");
  if (platformRow) {
    platformRow.innerHTML = catalog
      .map(
        (platform) => `
      <label class="platform-option"><input type="checkbox" name="platforms" value="${platform.key}"> ${escapeHtml(platform.label || window.gtss.formatPlatformLabel(platform.key))}</label>
    `,
      )
      .join("");

    const checkboxes = platformRow.querySelectorAll('input[name="platforms"]');
    checkboxes.forEach(cb => {
      cb.addEventListener("change", () => {
        const igChecked = [...platformRow.querySelectorAll('input[name="platforms"]:checked')].some(i => i.value === "instagram");
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
