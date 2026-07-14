/**
 * settings/init.js — Top-level event wiring + DOMContentLoaded boot.
 *
 * Originally the tail of public/js/settings.js. Holds:
 *   - The top-level event listeners attached at script-load time to the
 *     Brand Context preview modal buttons (save-context-btn,
 *     reset-context-btn, preview-context-btn, close-preview-btn,
 *     context-preview-backdrop). These use `?.addEventListener` so they
 *     are safe to call even if the elements aren't on the page.
 *   - The DOMContentLoaded handler that boots the page:
 *       bindEvents() → bindPipelineEvents() → bindCentralizedExtensions()
 *       → await loadSettings() → await loadContext() → await loadSessions()
 *       → await loadPipelineSettings() → initSettingsNavScrollspy()
 *
 * This file MUST load last (after every other split file has declared its
 * functions) because it references them by bare name at parse time and
 * invokes them at DOMContentLoaded time.
 */

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
  bindCentralizedExtensions();
  await loadSettings();
  await loadContext();
  await loadSessions();
  await loadPipelineSettings();
  initSettingsNavScrollspy();
});
