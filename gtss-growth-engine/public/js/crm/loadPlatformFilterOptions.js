/**
 * crm/loadPlatformFilterOptions.js — Populate the platform-filter dropdown
 * from the shared platform catalog.
 *
 * Original crm.js was 578 lines; this is one of its thematic splits.
 */

"use strict";

async function loadPlatformFilterOptions() {
  const catalog = await window.gtss.loadPlatformCatalog();
  platformLabels = Object.fromEntries(
    catalog.map((platform) => [platform.key, platform.label]),
  );
  const currentValue = els.platformFilter.value;
  els.platformFilter.innerHTML = [
    '<option value="">All Platforms</option>',
    ...catalog.map(
      (platform) =>
        `<option value="${platform.key}">${window.gtss.escapeHtml(platform.label || window.gtss.formatPlatformLabel(platform.key))}</option>`,
    ),
  ].join("");
  if (currentValue) els.platformFilter.value = currentValue;
}
