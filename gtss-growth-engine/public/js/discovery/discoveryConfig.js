/**
 * discovery/discoveryConfig.js — Max-leads config loader/saver for the
 * Discovery page.
 *
 * The #max-leads-input controls how many leads each discovery run will
 * collect. Its value is persisted via /api/discovery/config so the same
 * max is restored on page reload.
 *
 * Exposes (via global scope):
 *   - loadDiscoveryConfig() — async; GET /api/discovery/config and
 *                             populate #max-leads-input
 *   - saveDiscoveryConfig() — async; POST /api/discovery/config with the
 *                             current #max-leads-input value (no-op if
 *                             the input is missing or invalid)
 *
 * Depends on (from window.gtss, available via app.js):
 *   - fetchJSON
 */

async function loadDiscoveryConfig() {
  try {
    const config = await window.gtss.fetchJSON("/api/discovery/config");
    const input = document.getElementById("max-leads-input");
    if (input && config.maxLeads) {
      input.value = config.maxLeads;
    }
  } catch (error) {
    console.error("Failed to load discovery config", error);
  }
}

async function saveDiscoveryConfig() {
  const maxLeads = Number(document.getElementById("max-leads-input").value);
  if (isNaN(maxLeads) || maxLeads < 1) return;

  try {
    await window.gtss.fetchJSON("/api/discovery/config", {
      method: "POST",
      body: JSON.stringify({ maxLeads }),
    });
  } catch (error) {
    console.error("Failed to save discovery config", error);
  }
}
